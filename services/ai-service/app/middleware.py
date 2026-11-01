"""Request context: binds request_id / run_id / trace ids into structlog contextvars, echoes
``X-Request-Id`` and ``X-Trace-Id``, and writes one ``http.request`` line per request."""

from __future__ import annotations

import re
import time
import uuid
from typing import Any

import structlog
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.errors import current_trace_id
from app.logging import get_logger

log = get_logger("app.http")
_SAFE_ID = re.compile(r"^[A-Za-z0-9._:\-]{1,128}$")


def _header(scope: Scope, name: bytes) -> str | None:
    for k, v in scope.get("headers", []):
        if k.lower() == name:
            value = v.decode("latin-1").strip()
            return value if _SAFE_ID.match(value) else None
    return None


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        structlog.contextvars.clear_contextvars()
        request_id = _header(scope, b"x-request-id") or uuid.uuid4().hex
        run_id = _header(scope, b"x-run-id")
        structlog.contextvars.bind_contextvars(request_id=request_id)
        if run_id:
            structlog.contextvars.bind_contextvars(run_id=run_id)
        scope.setdefault("state", {})["request_id"] = request_id
        started = time.perf_counter()
        status: dict[str, Any] = {"code": 500}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
                headers = list(message.get("headers", []))
                headers.append((b"x-request-id", request_id.encode()))
                trace_id = current_trace_id()
                if trace_id:
                    headers.append((b"x-trace-id", trace_id.encode()))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            path = scope.get("path", "")
            route = scope.get("route")
            template = getattr(route, "path", None) or path
            duration = round((time.perf_counter() - started) * 1000, 1)
            fields = {
                "message": f"{scope.get('method')} {template} -> {status['code']}",
                "method": scope.get("method"),
                "path": template,
                "status": status["code"],
                "duration_ms": duration,
            }
            if path.startswith("/health"):
                log.debug("http.request", **fields)
            elif status["code"] >= 500:
                log.warning("http.request", **fields)
            else:
                log.info("http.request", **fields)
