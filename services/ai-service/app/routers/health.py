"""Liveness and readiness (contracts §5.9).

Readiness checks the database (required) and object storage. Storage is checked with a prefix-scoped
``list_objects_v2`` on ``parsed/`` so it works with the AI service's scoped storage user (contracts §11.8). A
storage failure makes the ``ai-ingest`` instance (``AI_INSTANCE_ROLE=ingest``) unready; the ``all`` instance
only reports it, so live chat keeps working while storage is down.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.container import Container
from app.deps import get_container
from app.logging import get_logger
from app.schemas import HealthLive, HealthReady

router = APIRouter(tags=["health"])
log = get_logger(__name__)
STORAGE_PING_TIMEOUT_SECONDS = 3.0


@router.get("/health/live", response_model=HealthLive, summary="Liveness: the process is up")
async def live() -> HealthLive:
    return HealthLive(status="ok")


@router.get(
    "/health/ready",
    response_model=HealthReady,
    summary="Readiness: database (and, for ai-ingest, storage) reachable",
    responses={503: {"model": HealthReady, "description": "Not ready; `checks` shows what failed."}},
)
async def ready(container: Container = Depends(get_container)) -> JSONResponse:
    checks: dict[str, str] = {}
    ok = True
    try:
        if container.db is None:
            raise RuntimeError("no database configured")
        await container.db.ping()
        checks["database"] = "ok"
    except Exception as exc:
        ok = False
        checks["database"] = "failed"
        log.warning("health.not_ready", message="Database not reachable", exception_type=type(exc).__name__)
    try:
        await asyncio.wait_for(container.storage.ping(), timeout=STORAGE_PING_TIMEOUT_SECONDS)
        checks["storage"] = "ok"
    except Exception as exc:
        checks["storage"] = "failed"
        if container.settings.ai_instance_role == "ingest":
            ok = False
        log.warning("health.storage_unavailable", message="Storage not reachable", exception_type=type(exc).__name__)
    checks["llm"] = "disabled" if container.settings.ai_kill_switch else container.llm_provider.name
    checks["embeddings"] = container.embedder.model
    body = HealthReady(status="ok" if ok else "unavailable", checks=checks)
    return JSONResponse(body.model_dump(), status_code=200 if ok else 503)
