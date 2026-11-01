"""POST /internal/v1/tutor/stream: SSE (contracts §6.1, §11.5).

Client disconnects stop the pipeline promptly in two ways:

* Starlette (ASGI spec < 2.4, e.g. uvicorn) listens for ``http.disconnect`` and cancels the response task;
  ``sse_stream`` then cancels the producer task, so ``CancelledError`` unwinds the tutor pipeline, the web
  fetches and the LLM stream (whose SDK context closes the upstream HTTP request).
* ``sse_stream`` also polls ``request.is_disconnected()`` between events (at most every
  ``DISCONNECT_POLL_SECONDS``), which covers servers where Starlette no longer listens (spec ≥ 2.4) and
  long silent phases (retrieval, web fetches, waiting for the first token).
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from app.aio import aclose_quietly
from app.container import Container
from app.deps import get_container, request_id
from app.errors import ERROR_CATALOG, AppError, current_trace_id
from app.ids import reference_id
from app.logging import bind, get_logger
from app.openapi import internal
from app.schemas import TutorRequest
from app.security import Principal, require_scope

router = APIRouter(prefix="/internal/v1", tags=["tutor"])
log = get_logger(__name__)
PING_SECONDS = 15.0
DISCONNECT_POLL_SECONDS = 0.5


def sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n".encode()


async def sse_stream(
    events: AsyncIterator[tuple[str, dict[str, Any]]],
    req_id: str,
    ping_seconds: float = PING_SECONDS,
    *,
    is_disconnected: Callable[[], Awaitable[bool]] | None = None,
    poll_seconds: float = DISCONNECT_POLL_SECONDS,
) -> AsyncIterator[bytes]:
    """Relay pipeline events as SSE, adding ``requestId`` and ``: ping`` keep-alives.

    The pipeline runs in its own task so pings keep flowing while it waits. When the client disconnects
    (this generator is cancelled or closed, or ``is_disconnected()`` turns true) the task is cancelled.
    """
    queue: asyncio.Queue[tuple[str, dict[str, Any]] | None] = asyncio.Queue()

    async def produce() -> None:
        try:
            async for item in events:
                queue.put_nowait(item)
        except asyncio.CancelledError:
            await aclose_quietly(events)
            raise
        except Exception as exc:
            log.error("tutor.unhandled", message="Unhandled tutor error", error_code="INTERNAL_ERROR", exc_info=exc)
            queue.put_nowait(
                (
                    "error",
                    {
                        "code": "INTERNAL_ERROR",
                        "message": ERROR_CATALOG["INTERNAL_ERROR"][2],
                        "referenceId": reference_id(current_trace_id()),
                    },
                )
            )
        finally:
            queue.put_nowait(None)

    task = asyncio.create_task(produce())
    loop = asyncio.get_running_loop()
    last_sent = last_check = loop.time()
    wait_cap = min(ping_seconds, poll_seconds) if is_disconnected is not None else ping_seconds
    try:
        while True:
            now = loop.time()
            if is_disconnected is not None and now - last_check >= poll_seconds:
                last_check = now
                if await is_disconnected():
                    return  # the finally block cancels the pipeline
            try:
                timeout = max(0.0, min(wait_cap, ping_seconds - (now - last_sent)))
                item = await asyncio.wait_for(queue.get(), timeout=timeout)
            except TimeoutError:
                if loop.time() - last_sent >= ping_seconds:
                    last_sent = loop.time()
                    yield b": ping\n\n"
                continue
            if item is None:
                break
            name, data = item
            if name == "error" and "referenceId" not in data:
                data = {**data, "referenceId": reference_id(current_trace_id())}
            last_sent = loop.time()
            yield sse(name, {**data, "requestId": req_id})
    finally:
        if not task.done():
            task.cancel()


_STREAM_DOC = internal("tutor")
_STREAM_DOC["responses"][200] = {
    "description": "Server-sent events (contracts §6.1): `status`* → `token`* → `citation`* → `usage` → `done`, "
    "or a terminal `error`. `: ping` comments keep the connection alive. Closing the connection cancels the run.",
    "content": {"text/event-stream": {"schema": {"type": "string"}}},
}


@router.post(
    "/tutor/stream",
    response_class=StreamingResponse,
    summary="Stream a tutor answer (SSE)",
    description="Hybrid retrieval in the token's `rscope`, optional web search, streamed answer with citations.",
    **_STREAM_DOC,
)
async def tutor_stream(
    body: TutorRequest,
    request: Request,
    principal: Principal = Depends(require_scope("tutor")),
    container: Container = Depends(get_container),
) -> StreamingResponse:
    if not body.question and not body.adjust:
        raise AppError("VALIDATION_FAILED", errors={"question": ["A question is required."]})
    if body.adjust and not body.previous_answer:
        raise AppError("VALIDATION_FAILED", errors={"previousAnswer": ["Required when adjust is set."]})
    bind(run_id=str(body.run_id), conversation_id=str(body.conversation_id))
    events = container.tutor.stream(body, principal)
    return StreamingResponse(
        sse_stream(events, request_id(request), is_disconnected=request.is_disconnected),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
