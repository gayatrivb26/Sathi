"""Web search for the tutor (master spec §18): topic-only query → provider (24 h cache, global spend cap)
→ SSRF-safe fetch → clean text → passages picked by embedding similarity with a reputable-domain boost.

Never sent to the provider: names, e-mails, phone numbers, URLs, uploaded-file text or conversation text.
Logged (``web_search.run``): query hash, provider, URLs, result count, timings, cache hit, outcome, error
code — never page contents.
"""

from __future__ import annotations

import asyncio
import math
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from urllib.parse import urlsplit

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.aio import shielded
from app.config import Settings
from app.db import Database
from app.embeddings.base import EmbeddingProvider
from app.errors import current_trace_id
from app.ids import query_hash, sha256_hex
from app.logging import get_logger
from app.models import SearchCache, SearchRun
from app.search.base import SearchProvider, SearchResult
from app.search.extract import html_to_text, plain_text
from app.search.fetcher import FetchBlocked, FetchFailed, SafeFetcher
from app.telemetry import get_metrics
from app.text import content_words, looks_like_injection

log = get_logger(__name__)

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_URL = re.compile(r"(?i)\b(?:https?://|www\.)\S+")
_PHONE = re.compile(r"(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)")
_LONG_TOKEN = re.compile(r"\b[A-Za-z0-9_\-]{24,}\b")  # API keys, tokens, ids
_CAPITALISED_PAIR = re.compile(r"\b(?:my name is|i am|i'm)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?", re.IGNORECASE)


def scrub(text: str) -> str:
    text = _CAPITALISED_PAIR.sub(" ", text)
    for pattern in (_EMAIL, _URL, _PHONE, _LONG_TOKEN):
        text = pattern.sub(" ", text)
    return " ".join(text.split())


def build_search_query(question: str, lesson_title: str | None, max_terms: int = 12) -> str:
    """Topic-only query from the question and lesson title (never history, uploads or personal data)."""
    terms: list[str] = []
    for w in content_words(scrub(question)):
        if w not in terms and not w.isdigit():
            terms.append(w)
    for w in content_words(scrub(lesson_title or "")):
        if w not in terms and len(terms) < max_terms:
            terms.append(w)
    return " ".join(terms[:max_terms])


@dataclass
class WebPassage:
    title: str
    url: str
    content: str
    score: float
    domain: str
    reputable: bool
    suspicious: bool = False


@dataclass
class WebSearchOutcome:
    passages: list[WebPassage] = field(default_factory=list)
    outcome: str = "skipped"  # ok | empty | failed | skipped
    error_code: str | None = None
    query_hash: str | None = None
    provider: str = "none"
    urls: list[str] = field(default_factory=list)
    result_count: int = 0
    cache_hit: bool = False
    latency_ms: int = 0
    timings: dict[str, float] = field(default_factory=dict)
    cancelled: bool = False


class WebSearcher(Protocol):
    async def search(
        self, *, question: str, lesson_title: str | None, run_id: uuid.UUID | None
    ) -> WebSearchOutcome: ...


class StaticWebSearch:
    """Returns fixed passages (evaluation: hostile-page injection cases)."""

    def __init__(self, passages: list[WebPassage]) -> None:
        self.passages = passages

    async def search(self, *, question: str, lesson_title: str | None, run_id: uuid.UUID | None) -> WebSearchOutcome:
        return WebSearchOutcome(
            passages=list(self.passages),
            outcome="ok",
            provider="static",
            urls=[p.url for p in self.passages],
            result_count=len(self.passages),
        )


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


def split_passages(text: str, words_per_passage: int = 110, overlap: int = 20) -> list[str]:
    words = text.split()
    if not words:
        return []
    out = []
    step = max(1, words_per_passage - overlap)
    for i in range(0, len(words), step):
        piece = " ".join(words[i : i + words_per_passage])
        if len(piece) > 80:
            out.append(piece)
        if i + words_per_passage >= len(words):
            break
    return out[:40]


class WebSearchService:
    def __init__(
        self,
        settings: Settings,
        db: Database | None,
        provider: SearchProvider | None,
        fetcher: SafeFetcher,
        embedder: EmbeddingProvider,
    ) -> None:
        self.settings = settings
        self.db = db
        self.provider = provider
        self.fetcher = fetcher
        self.embedder = embedder

    # ------------------------------------------------------------------ helpers
    def is_reputable(self, domain: str) -> bool:
        domain = domain.lower()
        for entry in self.settings.web_reputable_domains:
            if entry.startswith("."):
                if domain.endswith(entry):
                    return True
            elif domain == entry or domain.endswith("." + entry):
                return True
        return False

    async def _spent_today(self) -> float:
        if self.db is None or self.provider is None or self.provider.cost_per_query <= 0:
            return 0.0
        start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
        async with self.db.session() as s:
            count = await s.scalar(
                select(func.count())
                .select_from(SearchRun)
                .where(
                    SearchRun.created_at >= start,
                    SearchRun.cache_hit.is_(False),
                    SearchRun.provider == self.provider.name,
                    SearchRun.outcome.in_(["ok", "empty", "failed"]),
                )
            )
        return float(count or 0) * self.provider.cost_per_query

    async def _cache_get(self, key: str) -> list[SearchResult] | None:
        if self.db is None:
            return None
        async with self.db.session() as s:
            row = await s.get(SearchCache, key)
        if row is None or row.expires_at <= datetime.now(UTC):
            return None
        return [SearchResult.from_json(r) for r in row.results]

    async def _cache_put(self, key: str, results: list[SearchResult]) -> None:
        if self.db is None or self.provider is None:
            return
        now = datetime.now(UTC)
        values: dict[str, Any] = {
            "query_hash": key,
            "provider": self.provider.name,
            "results": [r.to_json() for r in results],
            "created_at": now,
            "expires_at": now + timedelta(hours=self.settings.web_cache_hours),
        }
        stmt = pg_insert(SearchCache).values(**values)
        stmt = stmt.on_conflict_do_update(
            index_elements=[SearchCache.query_hash],
            set_={"results": stmt.excluded.results, "created_at": now, "expires_at": stmt.excluded.expires_at},
        )
        async with self.db.transaction() as s:
            await s.execute(stmt)

    async def _page_text(self, result: SearchResult) -> tuple[str, str]:
        """Return (title, text) for a result: fetched page text, else provider content/snippet."""
        fallback = result.content or result.snippet
        if self.provider is None or not self.provider.fetch_pages:
            return result.title, fallback
        try:
            page = await self.fetcher.fetch(result.url)
        except FetchBlocked as exc:
            log.warning(
                "web_search.fetch_blocked",
                message="Blocked unsafe URL",
                url_host=urlsplit(result.url).hostname,
                reason=str(exc)[:200],
            )
            return result.title, ""
        except FetchFailed as exc:
            log.debug("web_search.fetch_failed", url_host=urlsplit(result.url).hostname, reason=str(exc)[:200])
            return result.title, fallback
        extracted = html_to_text(page.body) if "html" in page.content_type else plain_text(page.body)
        return (extracted.title or result.title), (extracted.text or fallback)

    async def _select_passages(self, question: str, pages: list[tuple[SearchResult, str, str]]) -> list[WebPassage]:
        candidates: list[tuple[SearchResult, str, str]] = []
        for result, title, text in pages:
            for passage in split_passages(text):
                candidates.append((result, title, passage))
        if not candidates:
            return []
        qvec = await self.embedder.embed_query(question)
        pvecs = await self.embedder.embed_documents([p for _, _, p in candidates])
        scored: list[WebPassage] = []
        for (result, title, passage), vec in zip(candidates, pvecs, strict=True):
            domain = (urlsplit(result.url).hostname or "").lower()
            reputable = self.is_reputable(domain)
            score = _cosine(qvec, vec) * (1.15 if reputable else 1.0)
            scored.append(
                WebPassage(
                    title=title or domain,
                    url=result.url,
                    content=passage,
                    score=round(score, 4),
                    domain=domain,
                    reputable=reputable,
                    suspicious=looks_like_injection(passage),
                )
            )
        scored.sort(key=lambda p: -p.score)
        chosen: list[WebPassage] = []
        per_url: dict[str, int] = {}
        for p in scored:
            if per_url.get(p.url, 0) >= 2:
                continue
            per_url[p.url] = per_url.get(p.url, 0) + 1
            chosen.append(p)
            if len(chosen) >= self.settings.web_passages_max:
                break
        return chosen

    # ------------------------------------------------------------------ main entry
    async def search(self, *, question: str, lesson_title: str | None, run_id: uuid.UUID | None) -> WebSearchOutcome:
        started = time.perf_counter()
        out = WebSearchOutcome(provider=self.provider.name if self.provider else "none")
        query = build_search_query(question, lesson_title)
        out.query_hash = query_hash(query)
        try:
            if self.provider is None:
                out.outcome, out.error_code = "skipped", "WEB_SEARCH_FAILED"
                return out
            if not query:
                out.outcome = "empty"
                return out
            if await self._spent_today() >= self.settings.web_search_daily_spend_cap_usd:
                out.outcome, out.error_code = "skipped", "WEB_SEARCH_FAILED"
                log.warning(
                    "web_search.spend_cap",
                    message="Global web-search spend cap reached",
                    cap_usd=self.settings.web_search_daily_spend_cap_usd,
                )
                return out

            cache_key = sha256_hex(f"{self.provider.name}:{' '.join(query.lower().split())}")[:40]
            t0 = time.perf_counter()
            results = await self._cache_get(cache_key)
            out.cache_hit = results is not None
            if results is None:
                try:
                    results = await asyncio.wait_for(
                        self.provider.search(query, self.settings.web_search_max_results),
                        timeout=self.settings.web_search_timeout_seconds,
                    )
                except Exception as exc:
                    out.outcome, out.error_code = "failed", "WEB_SEARCH_FAILED"
                    log.warning(
                        "web_search.provider_failed",
                        message="Search provider failed; answering without web",
                        provider=self.provider.name,
                        exception_type=type(exc).__name__,
                        error_code="WEB_SEARCH_FAILED",
                    )
                    return out
                if results:
                    await self._cache_put(cache_key, results)
            out.timings["search_ms"] = round((time.perf_counter() - t0) * 1000, 1)
            out.result_count = len(results)
            if not results:
                out.outcome = "empty"
                return out

            t1 = time.perf_counter()
            top = results[: self.settings.web_fetch_pages]
            texts = await asyncio.gather(*(self._page_text(r) for r in top))
            pages = [(r, title, text) for r, (title, text) in zip(top, texts, strict=True) if text]
            out.timings["fetch_ms"] = round((time.perf_counter() - t1) * 1000, 1)

            t2 = time.perf_counter()
            out.passages = await self._select_passages(question, pages)
            out.timings["select_ms"] = round((time.perf_counter() - t2) * 1000, 1)
            out.urls = sorted({p.url for p in out.passages})
            out.outcome = "ok" if out.passages else "empty"
            return out
        except asyncio.CancelledError:
            # client disconnected: in-flight fetches are cancelled with us (gather propagates the cancel)
            out.outcome, out.cancelled = "skipped", True
            raise
        finally:
            out.latency_ms = int((time.perf_counter() - started) * 1000)
            await shielded(self._finish(out, run_id))

    async def _finish(self, out: WebSearchOutcome, run_id: uuid.UUID | None) -> None:
        get_metrics().web_searches.add(
            1, {"provider": out.provider, "outcome": out.outcome, "cache_hit": str(out.cache_hit).lower()}
        )
        log.info(
            "web_search.run",
            message="Web search cancelled" if out.cancelled else f"Web search {out.outcome}",
            cancelled=out.cancelled,
            query_hash=out.query_hash,
            provider=out.provider,
            urls=out.urls,
            result_count=out.result_count,
            passage_count=len(out.passages),
            suspicious_passages=sum(1 for p in out.passages if p.suspicious),
            timings=out.timings,
            latency_ms=out.latency_ms,
            cache_hit=out.cache_hit,
            outcome=out.outcome,
            error_code=out.error_code,
        )
        if self.db is None or out.query_hash is None:
            return
        try:
            async with self.db.transaction() as s:
                s.add(
                    SearchRun(
                        run_id=run_id,
                        trace_id=current_trace_id(),
                        query_hash=out.query_hash,
                        provider=out.provider,
                        result_count=out.result_count,
                        urls=out.urls,
                        latency_ms=out.latency_ms,
                        cache_hit=out.cache_hit,
                        outcome=out.outcome,
                        error_code=out.error_code,
                    )
                )
        except Exception as exc:
            log.warning("web_search.record_failed", exception_type=type(exc).__name__)
