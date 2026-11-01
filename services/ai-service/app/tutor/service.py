"""Live tutor pipeline (contracts §6.1, master spec §18–19).

status(retrieving) → hybrid retrieval in the token's scope → [status(searching_web) → web search →
status(reading_sources)] → status(generating) → token* → citation check → citation* → usage → done.

Failures: LLM errors end the stream with a terminal ``error`` event; retrieval/web failures degrade with a
warning (``RAG_NO_RESULTS`` / ``WEB_SEARCH_FAILED``). The run ledger (retrieval_runs, retrieved_sources,
search_runs, model_runs and optional debug_captures) is written whatever the outcome.

Cancellation (contracts §11.5): when .NET closes the SSE connection the generator is cancelled
(``CancelledError``) or closed (``GeneratorExit``). In-flight web fetches are cancelled, the LLM stream is
closed (``model_runs.finish_reason='cancelled'`` with the tokens so far), the retrieval/search rows already
produced are written, and one ``tutor.cancelled`` line is logged at info level — never as an error.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select

from app.aio import aclose_quietly, shielded
from app.config import Settings
from app.db import Database
from app.embeddings.base import EmbeddingProvider
from app.errors import ERROR_CATALOG, current_trace_id
from app.ids import query_hash
from app.llm.base import LlmError, LlmRequest, TextDelta
from app.llm.router import LlmOutcome, LlmRouter
from app.logging import get_logger
from app.models import DebugCapture, DebugCaptureSetting, RetrievalRun, RetrievedSource
from app.prompts import PromptLibrary
from app.rag.citations import CitationCheck, check_citations
from app.rag.retrieval import HybridRetriever, RetrievalResult
from app.schemas import Citation, TutorRequest
from app.search.service import WebSearcher, WebSearchOutcome
from app.security import Principal
from app.telemetry import get_metrics, tracer
from app.text import looks_like_injection, plain_snippet, truncate
from app.tutor.guard import guard_output
from app.tutor.prompting import DEFAULT_ADJUST_QUESTION, SourceItem, build_messages

log = get_logger(__name__)

Event = tuple[str, dict[str, Any]]

STATUS_MESSAGES = {
    "retrieving": "Looking through your course material…",
    "searching_web": "Searching the web…",
    "reading_sources": "Reading the sources…",
    "generating": "Writing an answer…",
}


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


@dataclass
class Step:
    step: str
    started_at: datetime
    ended_at: datetime | None = None
    outcome: str = "ok"
    metrics: dict[str, Any] = field(default_factory=dict)

    def end(self, outcome: str = "ok", **metrics: Any) -> None:
        self.ended_at = _now()
        self.outcome = outcome
        self.metrics.update(metrics)

    def dump(self) -> dict[str, Any]:
        return {
            "step": self.step,
            "startedAt": _iso(self.started_at),
            "endedAt": _iso(self.ended_at or _now()),
            "outcome": self.outcome,
            "metrics": self.metrics,
        }


@dataclass
class TutorRun:
    """Collected state of one tutor run (also used by the evaluation runner)."""

    content: str = ""
    raw_text: str = ""
    sources: list[SourceItem] = field(default_factory=list)
    citations: list[Citation] = field(default_factory=list)
    check: CitationCheck | None = None
    warnings: list[str] = field(default_factory=list)
    steps: list[Step] = field(default_factory=list)
    outcome: LlmOutcome | None = None
    error_code: str | None = None
    retrieval: RetrievalResult | None = None
    web: WebSearchOutcome | None = None
    cancelled: bool = False


class TutorService:
    def __init__(
        self,
        settings: Settings,
        db: Database | None,
        router: LlmRouter,
        prompts: PromptLibrary,
        embedder: EmbeddingProvider,
        retriever: HybridRetriever,
        web: WebSearcher,
    ) -> None:
        self.settings = settings
        self.db = db
        self.router = router
        self.prompts = prompts
        self.embedder = embedder
        self.retriever = retriever
        self.web = web

    # ------------------------------------------------------------------ retrieval
    async def _retrieve(self, query: str, principal: Principal, run: TutorRun) -> None:
        step = Step("retrieve", _now())
        run.steps.append(step)
        scope = principal.rscope
        t0 = time.perf_counter()
        try:
            if self.db is None or scope.is_empty or not query:
                result = RetrievalResult([], "hybrid", {})
            else:
                qvec = await self.embedder.embed_query(query)
                embed_ms = round((time.perf_counter() - t0) * 1000, 1)
                async with self.db.session() as s:
                    result = await self.retriever.search(s, query=query, query_vector=qvec, scope=scope)
                result.timings["embed_ms"] = embed_ms
        except Exception as exc:
            step.end("failed", method="hybrid", resultCount=0, errorType=type(exc).__name__)
            run.warnings.append("RAG_NO_RESULTS")
            log.error(
                "retrieval.failed",
                message="Retrieval failed; answering without course sources",
                error_code="RAG_NO_RESULTS",
                exc_info=exc,
            )
            return
        result.timings["total_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        run.retrieval = result
        get_metrics().retrievals.add(1, {"method": result.method, "empty": str(result.empty).lower()})
        get_metrics().retrieval_latency.record(result.timings["total_ms"], {"method": result.method})
        log_fn = log.warning if result.empty else log.info
        log_fn(
            "retrieval.run",
            message="Retrieval returned no results" if result.empty else "Retrieval completed",
            query_hash=query_hash(query),
            method=result.method,
            scope_size={"course_ids": len(scope.course_ids), "includes_uploads": scope.user_id is not None},
            top_k=self.retriever.top_k,
            chunk_ids=[str(c.chunk_id) for c in result.chunks],
            scores=[c.score for c in result.chunks],
            vector_candidates=result.vector_candidates,
            keyword_candidates=result.keyword_candidates,
            timings=result.timings,
            empty=result.empty,
            error_code="RAG_NO_RESULTS" if result.empty else None,
        )
        if result.empty:
            run.warnings.append("RAG_NO_RESULTS")
        step.end(
            "empty" if result.empty else "ok",
            method=result.method,
            resultCount=len(result.chunks),
            timings=result.timings,
        )

    async def _web(self, req: TutorRequest, question: str, run: TutorRun) -> None:
        step = Step("web_search", _now())
        run.steps.append(step)
        out = await self.web.search(
            question=question, lesson_title=req.lesson.title if req.lesson else None, run_id=req.run_id
        )
        run.web = out
        if out.error_code:
            run.warnings.append(out.error_code)
        step.end(
            out.outcome if out.outcome in ("ok", "empty", "failed", "skipped") else "ok",
            provider=out.provider,
            resultCount=out.result_count,
            passageCount=len(out.passages),
            cacheHit=out.cache_hit,
            latencyMs=out.latency_ms,
        )

    def _sources(self, run: TutorRun) -> list[SourceItem]:
        sources: list[SourceItem] = []
        chunks = run.retrieval.chunks if run.retrieval else []
        # course material first, then the student's uploads, then the web
        ordered = [c for c in chunks if c.source_type == "course"] + [c for c in chunks if c.source_type != "course"]
        for c in ordered:
            sources.append(
                SourceItem(
                    index=len(sources) + 1,
                    source_type="course" if c.source_type == "course" else "upload",
                    title=c.title,
                    content=c.content,
                    document_id=c.document_id,
                    lesson_id=c.lesson_id,
                    chunk_id=c.chunk_id,
                    page=c.page,
                    section=c.section,
                    score=c.score,
                    vector_rank=c.vector_rank,
                    keyword_rank=c.keyword_rank,
                    suspicious=looks_like_injection(c.content),
                )
            )
        for p in run.web.passages if run.web else []:
            sources.append(
                SourceItem(
                    index=len(sources) + 1,
                    source_type="web",
                    title=p.title,
                    content=p.content,
                    url=p.url,
                    score=p.score,
                    suspicious=p.suspicious,
                )
            )
        return sources

    # ------------------------------------------------------------------ debug capture
    async def _debug_enabled(self, conversation_id: uuid.UUID) -> bool:
        if self.db is None:
            return False
        try:
            async with self.db.session() as s:
                row = await s.scalar(
                    select(DebugCaptureSetting).where(DebugCaptureSetting.conversation_id == conversation_id)
                )
            return bool(row and row.enabled and row.expires_at > _now())
        except Exception:
            return False

    # ------------------------------------------------------------------ ledger
    async def _write_ledger(
        self, req: TutorRequest, principal: Principal, run: TutorRun, query: str, request: LlmRequest | None
    ) -> None:
        if self.db is None:
            return
        cited = set(run.check.valid if run.check else [])
        try:
            async with self.db.transaction() as s:
                retrieval_id: uuid.UUID | None = None
                if run.retrieval is not None:
                    retrieval_id = uuid.uuid4()
                    s.add(
                        RetrievalRun(
                            id=retrieval_id,
                            run_id=req.run_id,
                            trace_id=current_trace_id(),
                            query_hash=query_hash(query),
                            method=run.retrieval.method,
                            scope_course_count=len(principal.rscope.course_ids),
                            scope_includes_uploads=principal.rscope.user_id is not None,
                            top_k=self.retriever.top_k,
                            result_count=len(run.retrieval.chunks),
                            timings=run.retrieval.timings,
                            empty=run.retrieval.empty,
                        )
                    )
                # a run cancelled during web search has retrieval results but no assembled source list yet
                for rank, src in enumerate(run.sources or self._sources(run), start=1):
                    s.add(
                        RetrievedSource(
                            retrieval_run_id=retrieval_id if src.source_type != "web" else None,
                            run_id=req.run_id,
                            rank=rank,
                            source_type=src.source_type,
                            chunk_id=src.chunk_id,
                            document_id=src.document_id,
                            url=src.url,
                            title=src.title[:500],
                            score=float(src.score),
                            vector_rank=src.vector_rank,
                            keyword_rank=src.keyword_rank,
                            cited=src.index in cited,
                        )
                    )
                if request is not None and await self._debug_enabled(req.conversation_id):
                    prompt_dump = json.dumps(
                        {"system": request.prompt.text, "messages": request.messages}, ensure_ascii=False
                    )
                    s.add(
                        DebugCapture(
                            run_id=req.run_id,
                            conversation_id=req.conversation_id,
                            user_id_hash=principal.user_hash,
                            prompt=prompt_dump,
                            response=run.raw_text,
                            expires_at=_now() + timedelta(hours=self.settings.debug_capture_retention_hours),
                        )
                    )
                    log.info("debug_capture.stored", message="Debug capture stored", run_id=str(req.run_id))
        except Exception as exc:
            log.warning(
                "tutor.ledger_failed", message="Could not write the retrieval ledger", exception_type=type(exc).__name__
            )

    # ------------------------------------------------------------------ main pipeline
    async def stream(
        self, req: TutorRequest, principal: Principal, run: TutorRun | None = None
    ) -> AsyncIterator[Event]:
        run = run if run is not None else TutorRun()
        question = req.question or (DEFAULT_ADJUST_QUESTION[req.adjust] if req.adjust else "")
        retrieval_query = req.question or truncate(req.previous_answer or "", 600)
        llm_request: LlmRequest | None = None
        parts: list[str] = []
        stage = "retrieving"
        ledger_written = False

        with tracer().start_as_current_span("tutor.run") as span:
            span.set_attribute("sathi.run_id", str(req.run_id))
            try:
                yield "status", {"stage": "retrieving", "message": STATUS_MESSAGES["retrieving"]}
                with tracer().start_as_current_span("tutor.retrieve"):
                    await self._retrieve(retrieval_query, principal, run)

                if req.web_search:
                    stage = "searching_web"
                    yield "status", {"stage": "searching_web", "message": STATUS_MESSAGES["searching_web"]}
                    with tracer().start_as_current_span("tutor.web_search"):
                        await self._web(req, req.question or retrieval_query, run)
                    yield "status", {"stage": "reading_sources", "message": STATUS_MESSAGES["reading_sources"]}

                run.sources = self._sources(run)
                generating_msg = STATUS_MESSAGES["generating"]
                if not run.sources:
                    generating_msg = "No matching sources found — writing a general explanation…"
                stage = "generating"
                yield "status", {"stage": "generating", "message": generating_msg}

                prompt = self.prompts.get("tutor_system")
                llm_request = LlmRequest(
                    purpose="tutor",
                    prompt=prompt,
                    messages=build_messages(req, question, run.sources),
                    max_tokens=self.settings.llm_tutor_max_tokens,
                    effort=self.settings.llm_tutor_effort,
                    run_id=req.run_id,
                    conversation_id=req.conversation_id,
                    context={
                        "question": question,
                        "mode": req.mode,
                        "level": req.level,
                        "adjust": req.adjust,
                        "previous_answer": req.previous_answer,
                        "sources": [
                            {"index": s.index, "type": s.source_type, "title": s.title, "content": s.content}
                            for s in run.sources
                        ],
                    },
                )
                llm_step = Step("llm", _now())
                run.steps.append(llm_step)
                llm_items = self.router.stream(llm_request)
                try:
                    with tracer().start_as_current_span("tutor.llm"):
                        async for item in llm_items:
                            if isinstance(item, TextDelta):
                                if item.text:
                                    parts.append(item.text)
                                    yield "token", {"text": item.text}
                            else:
                                run.outcome = item
                except LlmError as err:
                    run.raw_text = "".join(parts)
                    run.error_code = err.code
                    llm_step.end("failed", errorCode=err.code, outputChars=len(run.raw_text))
                    log.error(
                        "tutor.failed",
                        message=f"Tutor run failed: {err.code}",
                        error_code=err.code,
                        run_id=str(req.run_id),
                        streamed_chars=len(run.raw_text),
                        provider_request_id=err.request_id,
                    )
                    yield (
                        "error",
                        {"code": err.code, "message": ERROR_CATALOG.get(err.code, ERROR_CATALOG["INTERNAL_ERROR"])[2]},
                    )
                    return
                finally:
                    # closes the router → provider chain now (the SDK stream context exits on cancellation)
                    await aclose_quietly(llm_items)

                stage = "finalizing"
                run.raw_text = "".join(parts)
                outcome = run.outcome
                assert outcome is not None
                llm_step.end(
                    "ok",
                    model=outcome.model,
                    inputTokens=outcome.usage.input_tokens,
                    outputTokens=outcome.usage.output_tokens,
                    ttftMs=outcome.ttft_ms,
                    latencyMs=outcome.latency_ms,
                    finishReason=outcome.finish_reason,
                    fallbackUsed=outcome.fallback_used,
                )

                # citation check
                cite_step = Step("citation_check", _now())
                run.steps.append(cite_step)
                by_index = {s.index: s for s in run.sources}
                check = check_citations(run.raw_text, {i: s.source_type for i, s in by_index.items()})
                run.check = check
                guarded = guard_output(check.content, run.sources)
                run.content = guarded.text
                if guarded.removed_images or guarded.removed_links:
                    log.warning(
                        "tutor.output_guard",
                        message="Removed unsourced links/images from the answer",
                        removed_images=guarded.removed_images,
                        removed_links=guarded.removed_links,
                    )
                for idx in check.valid:
                    src = by_index[idx]
                    citation = Citation(
                        index=idx,
                        source_type=src.source_type,
                        title=src.title,
                        document_id=src.document_id,
                        lesson_id=src.lesson_id,
                        page=src.page,
                        url=src.url,
                        snippet=plain_snippet(src.content, 240),
                    )
                    run.citations.append(citation)
                    yield "citation", citation.dump()
                get_metrics().citations.add(check.valid_count, {"valid": "true"})
                get_metrics().citations.add(check.dropped_count, {"valid": "false"})
                log.info(
                    "citation.check",
                    message="Citation check completed",
                    valid=check.valid,
                    dropped=[{"index": d.index, "reason": d.reason} for d in check.dropped],
                    source_count=len(run.sources),
                    answer_basis=check.answer_basis,
                )
                cite_outcome = "failed" if check.dropped and not check.valid else "ok"
                cite_step.end(cite_outcome, valid=check.valid_count, dropped=check.dropped_count)

                yield (
                    "usage",
                    {
                        "inputTokens": outcome.usage.input_tokens,
                        "outputTokens": outcome.usage.output_tokens,
                        "costUsd": outcome.cost_usd,
                        "model": outcome.model,
                        "ttftMs": outcome.ttft_ms,
                        "latencyMs": outcome.latency_ms,
                    },
                )
                ledger_written = True
                await shielded(self._write_ledger(req, principal, run, retrieval_query, llm_request))
                log.info(
                    "tutor.completed",
                    message="Tutor run completed",
                    run_id=str(req.run_id),
                    answer_basis=check.answer_basis,
                    warnings=run.warnings,
                    source_count=len(run.sources),
                    citations_valid=check.valid_count,
                    citations_dropped=check.dropped_count,
                )
                stage = "done"
                yield (
                    "done",
                    {
                        "content": run.content,
                        "answerBasis": check.answer_basis,
                        "citationsValid": check.valid_count,
                        "citationsDropped": check.dropped_count,
                        "warnings": sorted(set(run.warnings)),
                        "steps": [s.dump() for s in run.steps],
                        "run": {
                            "provider": outcome.provider,
                            "model": outcome.model,
                            "promptHash": outcome.prompt_hash,
                            "inputTokens": outcome.usage.input_tokens,
                            "outputTokens": outcome.usage.output_tokens,
                            "costUsd": outcome.cost_usd,
                            "ttftMs": outcome.ttft_ms,
                            "latencyMs": outcome.latency_ms,
                        },
                    },
                )
            except (asyncio.CancelledError, GeneratorExit):
                if stage == "done":  # the run completed; the consumer merely stopped after `done`
                    raise
                # .NET closed the SSE connection (contracts §11.5). The LLM stream has already been closed and
                # recorded with finish_reason='cancelled' by the router; record what retrieval/search did.
                run.cancelled = True
                run.raw_text = "".join(parts)
                span.set_attribute("sathi.cancelled", True)
                log.info(
                    "tutor.cancelled",
                    message="Tutor run cancelled: the client disconnected",
                    run_id=str(req.run_id),
                    stage=stage,
                    streamed_chars=len(run.raw_text),
                    source_count=len(run.sources),
                )
                if not ledger_written and (run.retrieval is not None or run.sources or run.web is not None):
                    ledger_written = True
                    await shielded(self._write_ledger(req, principal, run, retrieval_query, llm_request))
                raise
            finally:
                if not ledger_written and (run.retrieval is not None or run.sources):
                    await shielded(self._write_ledger(req, principal, run, retrieval_query, llm_request))
