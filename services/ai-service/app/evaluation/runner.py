"""Golden-dataset evaluation runner.

    python -m app.evaluation.runner --dataset all

Datasets (``EVAL_DATASETS_DIR``, default ``/app/eval-datasets``; in the repo
``tests/ai-evaluation/datasets``): ``retrieval.jsonl``, ``tutor.jsonl``, ``injection.jsonl``,
``grading.jsonl``. Results are stored in ``ai.evaluation_*``; metrics are returned and printed as JSON.

Metrics: Recall@5 and MRR (retrieval), pass rate and citation validity rate (tutor), injection pass rate,
grading agreement (|AI − human| ≤ 20 % of max), MAE and Cohen's κ on low/mid/high score bands.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.container import Container
from app.errors import AppError
from app.evaluation.metrics import cohens_kappa, mean, recall_at_k, reciprocal_rank, score_band
from app.logging import get_logger
from app.models import EvaluationCase, EvaluationDataset, EvaluationResult, EvaluationRun
from app.schemas import GradeRequest, IdTitle, Rubric, RubricCriterion, TutorRequest
from app.search.service import StaticWebSearch, WebPassage
from app.security import Principal, RetrievalScope
from app.tutor.service import TutorRun, TutorService

log = get_logger(__name__)

KINDS = ("retrieval", "tutor", "injection", "grading")
NIL = uuid.UUID(int=0)


def _norm(s: str) -> str:
    return " ".join(s.lower().split())


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    cases = []
    for n, line in enumerate(path.read_text("utf-8").splitlines(), start=1):
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        try:
            case = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path.name}:{n}: invalid JSON") from exc
        case.setdefault("id", f"{path.stem}-{n}")
        cases.append(case)
    return cases


class EvaluationRunner:
    def __init__(self, container: Container, datasets_dir: Path | None = None) -> None:
        self.c = container
        self.dir = datasets_dir or container.settings.eval_datasets_dir
        if container.db is None:
            raise AppError("INTERNAL_ERROR", internal="evaluation requires a database")
        self.db = container.db

    # ------------------------------------------------------------------ persistence
    async def _dataset(self, kind: str, cases: list[dict[str, Any]]) -> tuple[uuid.UUID, dict[str, uuid.UUID]]:
        async with self.db.transaction() as s:
            stmt = pg_insert(EvaluationDataset).values(
                id=uuid.uuid4(),
                name=kind,
                kind=kind,
                description=f"{kind}.jsonl",
                case_count=len(cases),
            )
            upsert = stmt.on_conflict_do_update(
                index_elements=[EvaluationDataset.name],
                set_={"case_count": len(cases), "updated_at": datetime.now(UTC)},
            ).returning(EvaluationDataset.id)
            dataset_id = (await s.execute(upsert)).scalar_one()
            ids: dict[str, uuid.UUID] = {}
            for case in cases:
                expected = {k: v for k, v in case.items() if k.startswith(("expected", "must", "forbidden", "human"))}
                inputs = {k: v for k, v in case.items() if k not in expected and k != "id"}
                cstmt = pg_insert(EvaluationCase).values(
                    id=uuid.uuid4(),
                    dataset_id=dataset_id,
                    external_id=str(case["id"]),
                    input=inputs,
                    expected=expected,
                )
                cupsert = cstmt.on_conflict_do_update(
                    constraint="uq_evaluation_cases_dataset_ext",
                    set_={"input": cstmt.excluded.input, "expected": cstmt.excluded.expected},
                ).returning(EvaluationCase.id)
                ids[str(case["id"])] = (await s.execute(cupsert)).scalar_one()
        return dataset_id, ids

    async def _course_scope(self) -> RetrievalScope:
        async with self.db.session() as s:
            rows = (
                (
                    await s.execute(
                        text(
                            "SELECT DISTINCT course_id FROM ai.document_chunks "
                            "WHERE scope = 'course' AND course_id IS NOT NULL"
                        )
                    )
                )
                .scalars()
                .all()
            )
        return RetrievalScope(course_ids=tuple(rows))

    def _principal(self, scope: RetrievalScope) -> Principal:
        return Principal(
            subject="system",
            user_id=None,
            user_hash=None,
            scopes=frozenset({"eval"}),
            rscope=scope,
            issuer="sathi-jobs",
        )

    # ------------------------------------------------------------------ retrieval
    async def eval_retrieval(self, cases: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        scope = await self._course_scope()
        results, recalls, rrs, kw_hits = [], [], [], []
        for case in cases:
            expected = {_norm(t) for t in case.get("expected_lesson_titles") or []}
            keywords = [k.lower() for k in case.get("expected_keywords") or []]
            titles: list[str] = []
            content = ""
            if not scope.is_empty:
                qvec = await self.c.embedder.embed_query(case["question"])
                async with self.db.session() as s:
                    res = await self.c.retriever.search(
                        s, query=case["question"], query_vector=qvec, scope=scope, source_types=["course"], top_k=10
                    )
                titles = [_norm(ch.title) for ch in res.chunks]
                content = " ".join(ch.content.lower() for ch in res.chunks[:5])
            r5 = recall_at_k(titles, expected, 5)
            rr = reciprocal_rank(titles, expected)
            kw = (sum(1 for k in keywords if k in content) / len(keywords)) if keywords else None
            recalls.append(r5)
            rrs.append(rr)
            if kw is not None:
                kw_hits.append(kw)
            results.append(
                {
                    "id": case["id"],
                    "passed": r5 > 0,
                    "scores": {"recall@5": r5, "rr": rr, "keywordHit": kw},
                    "output": {"titles": titles[:10]},
                }
            )
        metrics = {
            "cases": len(cases),
            "recall@5": mean(recalls),
            "mrr": mean(rrs),
            "keywordHitRate": mean(kw_hits),
            "indexedCourses": len(scope.course_ids),
        }
        return metrics, results

    # ------------------------------------------------------------------ tutor & injection
    async def _tutor_once(
        self,
        service: TutorService,
        question: str,
        *,
        level: str = "intermediate",
        mode: str = "explain",
        web: bool = False,
        scope: RetrievalScope,
    ) -> TutorRun:
        req = TutorRequest(
            run_id=uuid.uuid4(),
            conversation_id=uuid.uuid4(),
            course=IdTitle(id=scope.course_ids[0] if scope.course_ids else NIL, title="Evaluation"),
            question=question,
            level=level,
            mode=mode,
            web_search=web,
        )
        run = TutorRun()
        async for _ in service.stream(req, self._principal(scope), run):
            pass
        return run

    async def eval_tutor(self, cases: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        scope = await self._course_scope()
        results, passes, valid, dropped, latencies, costs = [], [], 0, 0, [], []
        for case in cases:
            t0 = time.perf_counter()
            run = await self._tutor_once(
                self.c.tutor,
                case["question"],
                level=case.get("level", "intermediate"),
                mode=case.get("mode", "explain"),
                scope=scope,
            )
            latencies.append((time.perf_counter() - t0) * 1000)
            content = run.content.lower()
            must = [m.lower() for m in case.get("must_include_any") or []]
            include_ok = (not must) or any(m in content for m in must)
            n_valid = run.check.valid_count if run.check else 0
            n_drop = run.check.dropped_count if run.check else 0
            valid += n_valid
            dropped += n_drop
            cite_ok = (not case.get("must_cite")) or n_valid > 0
            ok = run.error_code is None and include_ok and cite_ok
            passes.append(1.0 if ok else 0.0)
            if run.outcome:
                costs.append(run.outcome.cost_usd)
            results.append(
                {
                    "id": case["id"],
                    "passed": ok,
                    "scores": {
                        "includeOk": include_ok,
                        "citeOk": cite_ok,
                        "citationsValid": n_valid,
                        "citationsDropped": n_drop,
                    },
                    "output": {
                        "errorCode": run.error_code,
                        "answerBasis": run.check.answer_basis if run.check else [],
                        "contentChars": len(run.content),
                    },
                }
            )
        total = valid + dropped
        metrics = {
            "cases": len(cases),
            "passRate": mean(passes),
            "citationValidityRate": round(valid / total, 4) if total else None,
            "avgLatencyMs": mean(latencies),
            "avgCostUsd": mean(costs),
        }
        return metrics, results

    async def eval_injection(self, cases: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        scope = await self._course_scope()
        results, passes = [], []
        for case in cases:
            hostile = WebPassage(
                title="Web page",
                url=f"https://example.com/eval/{case['id']}",
                content=case["hostile_passage"],
                score=1.0,
                domain="example.com",
                reputable=False,
                suspicious=True,
            )
            service = TutorService(
                self.c.settings,
                self.c.db,
                self.c.llm,
                self.c.prompts,
                self.c.embedder,
                self.c.retriever,
                StaticWebSearch([hostile]),
            )
            run = await self._tutor_once(service, case["question"], web=True, scope=scope)
            hits = [p for p in case.get("forbidden_patterns") or [] if re.search(p, run.content, re.IGNORECASE)]
            ok = not hits and run.error_code in (None, "LLM_REFUSED")
            passes.append(1.0 if ok else 0.0)
            results.append(
                {
                    "id": case["id"],
                    "passed": ok,
                    "scores": {"forbiddenHits": len(hits)},
                    "output": {"matchedPatterns": hits, "errorCode": run.error_code},
                }
            )
        return {"cases": len(cases), "injectionPassRate": mean(passes)}, results

    # ------------------------------------------------------------------ grading
    async def eval_grading(self, cases: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        results, agree, errors, human_bands, ai_bands, confs = [], [], [], [], [], []
        for case in cases:
            rubric = case["rubric"]
            req = GradeRequest(
                question_stem=case["question"],
                rubric=Rubric(
                    version=1,
                    criteria=[RubricCriterion(**c) for c in rubric["criteria"]],
                    model_answer=rubric.get("modelAnswer", ""),
                ),
                answer_text=case["answer"],
            )
            try:
                out = await self.c.grader.grade(req, None)
            except AppError as err:
                results.append({"id": case["id"], "passed": False, "scores": {}, "output": {"errorCode": err.code}})
                continue
            max_score = float(case.get("max_score") or out.max_score)
            human = float(case["human_score"])
            diff = abs(out.score - human)
            ok = diff <= 0.2 * max_score
            agree.append(1.0 if ok else 0.0)
            errors.append(diff)
            human_bands.append(score_band(human, max_score))
            ai_bands.append(score_band(out.score, max_score))
            confs.append(out.confidence)
            results.append(
                {
                    "id": case["id"],
                    "passed": ok,
                    "scores": {
                        "aiScore": out.score,
                        "humanScore": human,
                        "absError": diff,
                        "confidence": out.confidence,
                    },
                    "output": {"maxScore": max_score},
                }
            )
        metrics = {
            "cases": len(cases),
            "agreementRate": mean(agree),
            "meanAbsoluteError": mean(errors),
            "cohensKappa": cohens_kappa(human_bands, ai_bands),
            "avgConfidence": mean(confs),
        }
        return metrics, results

    # ------------------------------------------------------------------ orchestration
    async def run(self, dataset: str = "all") -> tuple[uuid.UUID, dict[str, Any]]:
        kinds = KINDS if dataset == "all" else (dataset,)
        if dataset != "all" and dataset not in KINDS:
            raise AppError("VALIDATION_FAILED", errors={"dataset": [f"Unknown dataset {dataset!r}."]})
        loaded = {k: load_jsonl(self.dir / f"{k}.jsonl") for k in kinds if (self.dir / f"{k}.jsonl").exists()}
        run_id = uuid.uuid4()
        dataset_ids: dict[str, uuid.UUID] = {}
        case_ids: dict[str, dict[str, uuid.UUID]] = {}
        for kind, cases in loaded.items():
            dataset_ids[kind], case_ids[kind] = await self._dataset(kind, cases)
        async with self.db.transaction() as s:
            s.add(
                EvaluationRun(
                    id=run_id,
                    dataset_id=dataset_ids.get(dataset),
                    dataset_name=dataset,
                    status="running",
                    git_sha=os.environ.get("GIT_SHA") or os.environ.get("SATHI_GIT_SHA"),
                    provider=self.c.llm_provider.name,
                    model=self.c.settings.llm_model if self.c.llm_provider.name != "fake" else "fake",
                )
            )
        metrics: dict[str, Any] = {"datasetsDir": str(self.dir), "missing": [k for k in kinds if k not in loaded]}
        evaluators = {
            "retrieval": self.eval_retrieval,
            "tutor": self.eval_tutor,
            "injection": self.eval_injection,
            "grading": self.eval_grading,
        }
        status = "succeeded"
        for kind, cases in loaded.items():
            try:
                m, results = await evaluators[kind](cases)
            except Exception as exc:
                log.error("evaluation.failed", message=f"Evaluation of {kind} failed", dataset=kind, exc_info=exc)
                metrics[kind] = {"error": type(exc).__name__}
                status = "failed"
                continue
            metrics[kind] = m
            async with self.db.transaction() as s:
                for r in results:
                    s.add(
                        EvaluationResult(
                            run_id=run_id,
                            case_id=case_ids[kind].get(str(r["id"])),
                            passed=bool(r["passed"]),
                            scores=r["scores"],
                            output=r["output"],
                        )
                    )
        async with self.db.transaction() as s:
            row = await s.scalar(select(EvaluationRun).where(EvaluationRun.id == run_id))
            if row is not None:
                row.status, row.metrics, row.finished_at = status, metrics, datetime.now(UTC)
        log.info(
            "evaluation.completed",
            message="Evaluation run completed",
            evaluation_run_id=str(run_id),
            dataset=dataset,
            metrics=metrics,
            status=status,
        )
        return run_id, metrics


async def _main(dataset: str, datasets_dir: str | None) -> int:
    from app.config import get_settings
    from app.logging import configure_logging

    settings = get_settings()
    configure_logging(
        service="ai-eval", env=settings.sathi_env, version=settings.sathi_version, level=settings.log_level
    )
    container = Container.build(settings)
    try:
        runner = EvaluationRunner(container, Path(datasets_dir) if datasets_dir else None)
        run_id, metrics = await runner.run(dataset)
        print(json.dumps({"evaluationRunId": str(run_id), "metrics": metrics}, indent=2))
        return 0
    finally:
        await container.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run Sathi AI golden-dataset evaluations")
    parser.add_argument("--dataset", default="all", choices=[*KINDS, "all"])
    parser.add_argument("--datasets-dir", default=None, help="override EVAL_DATASETS_DIR")
    args = parser.parse_args(argv)
    if sys.platform == "win32":
        return asyncio.run(_main(args.dataset, args.datasets_dir), loop_factory=asyncio.SelectorEventLoop)
    return asyncio.run(_main(args.dataset, args.datasets_dir))


if __name__ == "__main__":
    raise SystemExit(main())
