"""Data deletion (outbox consumers): document chunks and per-user AI data."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response

from app.container import Container
from app.deps import get_container, ingestion
from app.ids import user_id_hash
from app.logging import bind
from app.openapi import internal
from app.security import Principal, require_scope

router = APIRouter(prefix="/internal/v1", tags=["documents"])


@router.delete(
    "/documents/{document_id}",
    status_code=204,
    summary="Delete a document's chunks (all versions) and parsed files",
    description="Idempotent outbox consumer for `document.deleted`.",
    **internal("ingest", 503),
)
async def delete_document(
    document_id: uuid.UUID,
    _: Principal = Depends(require_scope("ingest")),
    container: Container = Depends(get_container),
) -> Response:
    bind(document_id=str(document_id))
    await ingestion(container).delete_document(document_id)
    return Response(status_code=204)


@router.delete(
    "/users/{user_id}",
    status_code=204,
    summary="Delete a user's AI data (owned chunks, debug captures)",
    description="Idempotent outbox consumer for `user.deleted`.",
    **internal("admin", 503),
)
async def delete_user(
    user_id: uuid.UUID,
    _: Principal = Depends(require_scope("admin")),
    container: Container = Depends(get_container),
) -> Response:
    uh = user_id_hash(str(user_id), container.settings.log_hash_salt.get_secret_value())
    await ingestion(container).delete_user(user_id, uh)
    return Response(status_code=204)
