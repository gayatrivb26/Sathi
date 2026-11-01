"""Evaluation runner end to end on the fixture datasets (FakeProvider + fake embeddings)."""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import func, select

from app.container import Container
from app.evaluation.runner import EvaluationRunner
from app.models import EvaluationCase, EvaluationResult, EvaluationRun
from tests.conftest import FIXTURES, auth, index_text

pytestmark = pytest.mark.db


async def _index_fixture_lessons(container: Container) -> None:
    for path in sorted((FIXTURES / "lessons").glob("*.md")):
        title = path.read_text("utf-8").splitlines()[0].lstrip("# ").strip()
        await index_text(container, path.read_text("utf-8"), title=title)


async def test_runner_all_datasets(container: Container) -> None:
    await _index_fixture_lessons(container)
    run_id, metrics = await EvaluationRunner(container, FIXTURES / "datasets").run("all")
    assert metrics["missing"] == []
    assert metrics["retrieval"]["recall@5"] == 1.0
    assert metrics["retrieval"]["mrr"] > 0.5
    assert metrics["tutor"]["passRate"] == 1.0
    assert metrics["tutor"]["citationValidityRate"] == 1.0
    assert metrics["injection"]["injectionPassRate"] == 1.0
    assert metrics["grading"]["cases"] == 2 and metrics["grading"]["cohensKappa"] is not None
    assert container.db is not None
    async with container.db.session() as s:
        run = await s.get(EvaluationRun, run_id)
        assert run is not None and run.status == "succeeded" and run.finished_at is not None
        assert await s.scalar(select(func.count()).select_from(EvaluationResult)) == 9
        assert await s.scalar(select(func.count()).select_from(EvaluationCase)) == 9

    # re-running upserts the cases (no duplicates)
    await EvaluationRunner(container, FIXTURES / "datasets").run("retrieval")
    async with container.db.session() as s:
        assert await s.scalar(select(func.count()).select_from(EvaluationCase)) == 9


async def test_eval_endpoint(client: httpx.AsyncClient, container: Container) -> None:
    await _index_fixture_lessons(container)
    r = await client.post("/internal/v1/eval/run", json={"dataset": "injection"}, headers=auth(scopes="eval"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["evaluationRunId"] and body["metrics"]["injection"]["injectionPassRate"] == 1.0
