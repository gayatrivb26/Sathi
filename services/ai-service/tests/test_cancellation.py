"""Client disconnect cancels the tutor pipeline promptly (contracts §11.5).

The end-to-end tests run the real app under uvicorn on an ephemeral port and use an HTTP client that closes
the connection mid-stream, exactly like .NET aborting the upstream request.
"""

from __future__ import annotations

import asyncio
import json
import socket
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
import uvicorn
from sqlalchemy import select

from app.aio import drain_background
from app.config import Settings
from app.container import Container
from app.db import Database
from app.llm.anthropic_provider import AnthropicProvider
from app.llm.base import LlmRequest, LlmResult, TextDelta, UsageUpdate
from app.llm.fake_provider import FakeProvider
from app.llm.router import LlmRouter
from app.main import create_app
from app.models import ModelRun, RetrievalRun, RetrievedSource, SearchRun
from app.prompts import Prompt
from app.routers.tutor import sse_stream
from app.search.base import SearchResult
from tests.conftest import COURSE_X, auth, build_container, index_text, make_settings

PROMPT = Prompt(name="tutor_system", version=1, text="You are a tutor. " * 50, hash="sha256:abc")
LESSON = (
    "# Scaled dot-product attention\n\n"
    "Attention scores are the dot product of queries and keys. "
    "We divide the scores by the square root of d_k so that their variance stays near one. "
    "Without scaling, large dot products push the softmax into saturation and gradients vanish. "
    "The softmax then turns scores into weights that sum to one.\n"
)
TUTOR_AUTH = {"scopes": "tutor", "course_ids": [COURSE_X]}


def _request() -> LlmRequest:
    return LlmRequest(
        purpose="tutor",
        prompt=PROMPT,
        messages=[{"role": "user", "content": "Why scale attention scores?"}],
        max_tokens=100,
        effort="low",
        context={"question": "Why scale attention scores?", "sources": []},
    )


def _tutor_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "runId": str(uuid.uuid4()),
        "conversationId": str(uuid.uuid4()),
        "course": {"id": str(COURSE_X), "title": "AI Engineering"},
        "lesson": {"id": str(uuid.uuid4()), "title": "Scaled dot-product attention"},
        "question": "Why do we divide attention scores by the square root of d_k?",
        "level": "beginner",
        "mode": "explain",
        "webSearch": False,
        "history": [],
        "weakConcepts": [],
    }
    body.update(overrides)
    return body


def _log_lines(out: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


async def _eventually(check: Callable[[], Awaitable[bool]], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if await check():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition not met in time")


# ---------------------------------------------------------------- test doubles
class TrackingFakeProvider(FakeProvider):
    """FakeProvider with a per-token delay that records how far it got and whether it was closed."""

    def __init__(self, delay_seconds: float = 0.05) -> None:
        super().__init__(delay_seconds=delay_seconds)
        self.deltas = 0
        self.closed = asyncio.Event()

    async def stream_chat(self, request: LlmRequest, model: str) -> AsyncIterator[TextDelta | UsageUpdate | LlmResult]:
        try:
            async for item in super().stream_chat(request, model):
                if isinstance(item, TextDelta):
                    self.deltas += 1
                yield item
        finally:
            self.closed.set()


class SlowSearchProvider:
    name = "slow"
    fetch_pages = False
    cost_per_query = 0.0

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.cancelled = asyncio.Event()

    async def search(self, query: str, max_results: int) -> list[SearchResult]:
        self.started.set()
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            self.cancelled.set()
            raise
        return []


class _SlowSdkStream:
    """Stand-in for the SDK's ``messages.stream(...)`` context: records that the context was exited."""

    def __init__(self) -> None:
        self.exited = False
        self.exit_exc: type[BaseException] | None = None

    async def __aenter__(self) -> _SlowSdkStream:
        return self

    async def __aexit__(self, exc_type: type[BaseException] | None, *exc: object) -> None:
        self.exited = True
        self.exit_exc = exc_type

    def __aiter__(self) -> AsyncIterator[Any]:
        async def gen() -> AsyncIterator[Any]:
            usage = SimpleNamespace(
                input_tokens=1234, output_tokens=1, cache_read_input_tokens=0, cache_creation_input_tokens=0
            )
            yield SimpleNamespace(type="message_start", message=SimpleNamespace(usage=usage))
            for i in range(1000):
                await asyncio.sleep(0.01)
                delta = SimpleNamespace(type="text_delta", text=f"word{i} ")
                yield SimpleNamespace(type="content_block_delta", delta=delta)

        return gen()


class _RecordingRouter(LlmRouter):
    def __init__(self, settings: Settings, provider: Any) -> None:
        super().__init__(settings, provider, None)
        self.records: list[dict[str, Any]] = []

    async def _record(self, request: LlmRequest, **kw: Any) -> None:  # type: ignore[override]
        self.records.append(kw)
        await super()._record(request, **kw)


# ---------------------------------------------------------------- unit level
async def test_cancelling_router_closes_anthropic_stream_and_records_cancelled() -> None:
    settings = make_settings(llm_provider="anthropic", anthropic_api_key="sk-test-not-real")
    sdk_stream = _SlowSdkStream()
    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=lambda **_: sdk_stream)))
    router = _RecordingRouter(settings, AnthropicProvider(settings, client=client))  # type: ignore[arg-type]
    tokens: list[str] = []

    async def consume() -> None:
        async for item in router.stream(_request()):
            if isinstance(item, TextDelta):
                tokens.append(item.text)

    task = asyncio.create_task(consume())
    await _eventually(lambda: asyncio.sleep(0, len(tokens) >= 3))
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await drain_background()
    assert sdk_stream.exited, "the SDK stream context must be exited so the HTTP request is closed"
    assert sdk_stream.exit_exc is asyncio.CancelledError
    assert len(router.records) == 1
    rec = router.records[0]
    assert rec["finish_reason"] == "cancelled" and rec["error_code"] is None
    assert rec["usage"].input_tokens == 1234  # from message_start, not an estimate
    assert rec["usage"].output_tokens >= 1
    assert rec["cost"] > 0


async def test_closing_router_generator_records_cancelled_once() -> None:
    settings = make_settings()
    provider = TrackingFakeProvider(delay_seconds=0.01)
    router = _RecordingRouter(settings, provider)
    gen = router.stream(_request())
    async for item in gen:
        if isinstance(item, TextDelta):
            break
    await gen.aclose()  # type: ignore[attr-defined]
    assert provider.closed.is_set()
    assert [r["finish_reason"] for r in router.records] == ["cancelled"]
    usage = router.records[0]["usage"]
    assert usage.input_tokens > 0 and usage.output_tokens >= 1


async def test_sse_stream_polls_for_disconnect_and_cancels_the_pipeline() -> None:
    cancelled = asyncio.Event()
    produced = 0

    async def events() -> AsyncIterator[tuple[str, dict[str, Any]]]:
        nonlocal produced
        try:
            while True:
                await asyncio.sleep(0.01)
                produced += 1
                yield "token", {"text": "x"}
        except asyncio.CancelledError:
            cancelled.set()
            raise

    disconnected = False

    async def is_disconnected() -> bool:
        return disconnected

    chunks = 0
    started = time.monotonic()
    async for _chunk in sse_stream(events(), "req", is_disconnected=is_disconnected, poll_seconds=0.05):
        chunks += 1
        if chunks == 5:
            disconnected = True
    await asyncio.wait_for(cancelled.wait(), timeout=2)
    assert time.monotonic() - started < 2
    seen = produced
    await asyncio.sleep(0.1)
    assert produced == seen, "the pipeline must stop producing after the disconnect"


# ---------------------------------------------------------------- end to end (real server, real disconnect)
class _Server:
    def __init__(self, container: Container) -> None:
        self.app = create_app(container.settings, container)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        config = uvicorn.Config(
            self.app, lifespan="off", log_config=None, access_log=False, timeout_graceful_shutdown=2
        )
        self.server = uvicorn.Server(config)
        self.task: asyncio.Task[None] | None = None

    async def __aenter__(self) -> str:
        self.task = asyncio.create_task(self.server.serve(sockets=[self.sock]))
        await _eventually(lambda: asyncio.sleep(0, self.server.started))
        return f"http://127.0.0.1:{self.port}"

    async def __aexit__(self, *exc: object) -> None:
        self.server.should_exit = True
        if self.task is not None:
            await asyncio.wait_for(self.task, timeout=10)
        self.sock.close()


async def _disconnect_after(
    base_url: str, body: dict[str, Any], *, until: str, count: int = 1, then_wait: asyncio.Event | None = None
) -> list[str]:
    """Open the SSE stream, read until ``count`` lines start with ``until`` (and ``then_wait`` is set), then drop
    the connection."""
    seen: list[str] = []
    async with (
        httpx.AsyncClient(base_url=base_url, timeout=10) as client,
        client.stream("POST", "/internal/v1/tutor/stream", json=body, headers=auth(**TUTOR_AUTH)) as r,
    ):
        assert r.status_code == 200
        hits = 0
        async for line in r.aiter_lines():
            seen.append(line)
            if line.startswith(until):
                hits += 1
                if hits >= count:
                    if then_wait is not None:
                        await asyncio.wait_for(then_wait.wait(), timeout=5)
                    break
    # leaving the block closes the (unfinished) response, so httpx closes the TCP connection
    return seen


async def test_disconnect_mid_stream_stops_llm_without_db(capsys: pytest.CaptureFixture[str]) -> None:
    provider = TrackingFakeProvider(delay_seconds=0.05)
    container = build_container(make_settings(), None, llm_provider=provider)
    started = time.monotonic()
    _, lines = await _cancel_and_collect(container, provider, capsys)
    assert time.monotonic() - started < 10
    _assert_cancel_logs(lines)


async def _cancel_and_collect(
    container: Container, provider: TrackingFakeProvider, capsys: pytest.CaptureFixture[str]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    body = _tutor_body()
    out: list[str] = []
    async with _Server(container) as base_url:
        await _disconnect_after(base_url, body, until='data: {"text"', count=3)
        await asyncio.wait_for(provider.closed.wait(), timeout=3)
        deltas_at_close = provider.deltas

        async def logged() -> bool:
            out.append(capsys.readouterr().out)
            return "tutor.cancelled" in "".join(out)

        await _eventually(logged)
        await drain_background()
        await asyncio.sleep(0.2)
        assert provider.deltas == deltas_at_close, "no tokens may be generated after the disconnect"
        assert provider.deltas < 40, "the stream must stop long before the answer is complete"
    out.append(capsys.readouterr().out)
    return body, _log_lines("".join(out))


def _assert_cancel_logs(lines: list[dict[str, Any]]) -> None:
    cancelled = [ln for ln in lines if ln.get("event") == "tutor.cancelled"]
    assert len(cancelled) == 1, "tutor.cancelled is logged exactly once"
    assert cancelled[0]["level"] == "info"
    assert cancelled[0]["stage"] == "generating" and cancelled[0]["streamed_chars"] > 0
    llm = [ln for ln in lines if ln.get("event") == "llm.call"]
    assert len(llm) == 1 and llm[0]["finish_reason"] == "cancelled" and llm[0]["level"] == "info"
    errors = [ln for ln in lines if ln.get("level") == "error"]
    assert errors == [], errors
    assert not any(ln.get("event") in ("tutor.failed", "tutor.unhandled", "tutor.completed") for ln in lines)


@pytest.mark.db
async def test_disconnect_mid_stream_records_cancelled_run(db: Database, capsys: pytest.CaptureFixture[str]) -> None:
    provider = TrackingFakeProvider(delay_seconds=0.05)
    container = build_container(make_settings(), db, llm_provider=provider)
    await index_text(container, LESSON, title="Scaled dot-product attention")
    body, lines = await _cancel_and_collect(container, provider, capsys)
    _assert_cancel_logs(lines)
    run_id = uuid.UUID(body["runId"])
    async with db.session() as s:
        model_runs = (await s.scalars(select(ModelRun).where(ModelRun.run_id == run_id))).all()
        retrievals = (await s.scalars(select(RetrievalRun).where(RetrievalRun.run_id == run_id))).all()
        sources = (await s.scalars(select(RetrievedSource).where(RetrievedSource.run_id == run_id))).all()
    assert len(model_runs) == 1
    mr = model_runs[0]
    assert mr.finish_reason == "cancelled" and mr.error_code is None and mr.purpose == "tutor"
    assert mr.input_tokens > 0 and mr.output_tokens > 0
    assert len(retrievals) == 1 and retrievals[0].result_count >= 1
    assert sources and not any(s.cited for s in sources)


@pytest.mark.db
async def test_disconnect_during_web_search_cancels_fetches(db: Database, capsys: pytest.CaptureFixture[str]) -> None:
    search = SlowSearchProvider()
    provider = TrackingFakeProvider()
    settings = make_settings(web_search_timeout_seconds=60)
    container = build_container(settings, db, llm_provider=provider, search_provider=search)
    await index_text(container, LESSON, title="Scaled dot-product attention")
    body = _tutor_body(webSearch=True)
    out: list[str] = []
    async with _Server(container) as base_url:
        await _disconnect_after(base_url, body, until='data: {"stage":"searching_web"', then_wait=search.started)
        await asyncio.wait_for(search.cancelled.wait(), timeout=3)

        async def logged() -> bool:
            out.append(capsys.readouterr().out)
            return "tutor.cancelled" in "".join(out)

        await _eventually(logged)
        await drain_background()
    out.append(capsys.readouterr().out)
    lines = _log_lines("".join(out))
    cancelled = [ln for ln in lines if ln.get("event") == "tutor.cancelled"]
    assert len(cancelled) == 1 and cancelled[0]["stage"] == "searching_web" and cancelled[0]["level"] == "info"
    assert not [ln for ln in lines if ln.get("level") == "error"]
    assert provider.calls == [], "the LLM is never called after the client left"
    run_id = uuid.UUID(body["runId"])
    async with db.session() as s:
        searches = (await s.scalars(select(SearchRun).where(SearchRun.run_id == run_id))).all()
        retrievals = (await s.scalars(select(RetrievalRun).where(RetrievalRun.run_id == run_id))).all()
        sources = (await s.scalars(select(RetrievedSource).where(RetrievedSource.run_id == run_id))).all()
        model_runs = (await s.scalars(select(ModelRun).where(ModelRun.run_id == run_id))).all()
    assert len(searches) == 1 and searches[0].outcome == "skipped"
    assert len(retrievals) == 1 and sources
    assert model_runs == []
