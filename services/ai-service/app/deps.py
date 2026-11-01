"""FastAPI dependencies."""

from __future__ import annotations

import uuid

from fastapi import Request

from app.container import Container
from app.errors import AppError
from app.ingestion.service import IngestionService


def get_container(request: Request) -> Container:
    container: Container = request.app.state.container
    return container


def header_run_id(request: Request) -> uuid.UUID | None:
    value = request.headers.get("x-run-id")
    if not value:
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def request_id(request: Request) -> str:
    rid = request.scope.get("state", {}).get("request_id") or request.headers.get("x-request-id") or ""
    return str(rid)


def ingestion(container: Container) -> IngestionService:
    if container.ingestion is None:
        raise AppError("INTERNAL_ERROR", internal="ingestion requires a database")
    return container.ingestion
