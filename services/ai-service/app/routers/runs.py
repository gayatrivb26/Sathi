"""GET /internal/v1/runs/{runId}: model-level run detail for the admin run view (journey J8)."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends
from pydantic.alias_generators import to_camel
from sqlalchemy import select

from app.container import Container
from app.deps import get_container
from app.errors import AppError
from app.models import Base, ModelRun, RetrievalRun, RetrievedSource, SearchRun
from app.openapi import internal
from app.schemas import InternalRunDetail
from app.security import Principal, require_scope

router = APIRouter(prefix="/internal/v1", tags=["runs"])


def _value(v: Any) -> Any:
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, datetime):
        return v.isoformat().replace("+00:00", "Z")
    if isinstance(v, Decimal):
        return float(v)
    return v


def row_dict(row: Base, exclude: tuple[str, ...] = ()) -> dict[str, Any]:
    return {to_camel(c.key): _value(getattr(row, c.key)) for c in row.__table__.columns if c.key not in exclude}


@router.get(
    "/runs/{run_id}",
    response_model=InternalRunDetail,
    summary="Model-level detail of one AI run",
    description="model_runs, retrieval runs with their sources, search runs and web sources (journey J8).",
    **internal("runs", 404),
)
async def run_detail(
    run_id: uuid.UUID,
    _: Principal = Depends(require_scope("runs")),
    container: Container = Depends(get_container),
) -> dict[str, Any]:
    if container.db is None:
        raise AppError("INTERNAL_ERROR", internal="no database")
    async with container.db.session() as s:
        model_runs = (
            await s.scalars(select(ModelRun).where(ModelRun.run_id == run_id).order_by(ModelRun.created_at))
        ).all()
        retrieval_runs = (
            await s.scalars(select(RetrievalRun).where(RetrievalRun.run_id == run_id).order_by(RetrievalRun.created_at))
        ).all()
        sources = (
            await s.scalars(
                select(RetrievedSource).where(RetrievedSource.run_id == run_id).order_by(RetrievedSource.rank)
            )
        ).all()
        search_runs = (
            await s.scalars(select(SearchRun).where(SearchRun.run_id == run_id).order_by(SearchRun.created_at))
        ).all()
    if not (model_runs or retrieval_runs or sources or search_runs):
        raise AppError("NOT_FOUND", internal=f"no ai rows for run {run_id}")
    by_retrieval: dict[uuid.UUID | None, list[dict[str, Any]]] = {}
    for src in sources:
        by_retrieval.setdefault(src.retrieval_run_id, []).append(row_dict(src))
    return {
        "modelRuns": [row_dict(m) for m in model_runs],
        "retrievalRuns": [{**row_dict(r), "sources": by_retrieval.get(r.id, [])} for r in retrieval_runs],
        "searchRuns": [row_dict(sr) for sr in search_runs],
        "webSources": by_retrieval.get(None, []),
    }
