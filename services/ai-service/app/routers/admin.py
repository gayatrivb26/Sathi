"""Admin operations: runtime log level and per-conversation debug capture."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Response
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.container import Container
from app.deps import get_container
from app.errors import AppError
from app.logging import current_level, get_logger, set_level
from app.models import DebugCaptureSetting
from app.openapi import internal
from app.schemas import DebugCaptureRequest, LogLevelRequest
from app.security import Principal, require_scope

router = APIRouter(prefix="/internal/v1/admin", tags=["admin"])
log = get_logger(__name__)
MAX_CAPTURE_HOURS = 24


@router.put(
    "/log-level",
    status_code=204,
    summary="Change the runtime log level",
    description="Applies to this instance only; logged as `admin.log_level_changed`.",
    **internal("admin"),
)
async def put_log_level(body: LogLevelRequest, principal: Principal = Depends(require_scope("admin"))) -> Response:
    before = current_level()
    set_level(body.level)
    log.warning(
        "admin.log_level_changed",
        message=f"Log level changed {before} -> {body.level.upper()}",
        previous=before,
        level=body.level.upper(),
        actor=principal.user_hash or principal.subject,
    )
    return Response(status_code=204)


@router.put(
    "/debug-capture",
    status_code=204,
    summary="Enable or disable prompt/response capture for one conversation",
    description="Captures expire after at most 24 h (`expiresAt` is capped); stored rows are kept 72 h.",
    **internal("admin"),
)
async def put_debug_capture(
    body: DebugCaptureRequest,
    principal: Principal = Depends(require_scope("admin")),
    container: Container = Depends(get_container),
) -> Response:
    if container.db is None:
        raise AppError("INTERNAL_ERROR", internal="no database")
    now = datetime.now(UTC)
    limit = now + timedelta(hours=MAX_CAPTURE_HOURS)
    expires = body.expires_at or limit
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=UTC)
    expires = min(expires, limit)
    stmt = pg_insert(DebugCaptureSetting).values(
        conversation_id=body.conversation_id, enabled=body.enabled, expires_at=expires, updated_at=now
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[DebugCaptureSetting.conversation_id],
        set_={"enabled": body.enabled, "expires_at": expires, "updated_at": now},
    )
    async with container.db.transaction() as s:
        await s.execute(stmt)
    log.warning(
        "admin.debug_capture",
        message="Debug capture " + ("enabled" if body.enabled else "disabled"),
        conversation_id=str(body.conversation_id),
        enabled=body.enabled,
        expires_at=expires.isoformat(),
        actor=principal.user_hash or principal.subject,
    )
    return Response(status_code=204)
