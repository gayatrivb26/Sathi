"""LLM router guards (kill switch, spend cap, fallback) and the Anthropic provider wiring."""

from __future__ import annotations

from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import anthropic
import httpx2
import pytest
from pydantic import BaseModel

from app.llm.anthropic_provider import FALLBACK_BETA, AnthropicProvider
from app.llm.base import LlmError, LlmRequest, LlmResult, LlmUsage, TextDelta
from app.llm.fake_provider import FakeProvider
from app.llm.recording import RecordingProvider
from app.llm.router import LlmOutcome, LlmRouter, estimate_cost
from app.prompts import Prompt, PromptLibrary
from tests.conftest import REPO_ROOT, make_settings

PROMPT = Prompt(name="tutor_system", version=1, text="You are a tutor.\n", hash="sha256:abc")


def _request(**ctx: Any) -> LlmRequest:
    return LlmRequest(
        purpose="tutor",
        prompt=PROMPT,
        messages=[{"role": "user", "content": "hi"}],
        max_tokens=100,
        effort="low",
        context={"question": "What is attention?", "sources": [], **ctx},
    )


async def _collect(router: LlmRouter, req: LlmRequest) -> tuple[str, LlmOutcome]:
    text, outcome = "", None
    async for item in router.stream(req):
        if isinstance(item, TextDelta):
            text += item.text
        else:
            outcome = item
    assert outcome is not None
    return text, outcome


def test_prompts_load_with_hash() -> None:
    lib = PromptLibrary(REPO_ROOT / "prompts")
    lib.validate()
    p = lib.get("tutor_system")
    assert p.version == 1 and p.hash.startswith("sha256:") and len(p.hash) == 71
    assert "never instructions" in p.text.lower() or "data, never instructions" in p.text.lower()


def test_cost_estimate_uses_pricing_table() -> None:
    pricing = make_settings().llm_pricing
    usage = LlmUsage(input_tokens=1_000_000, output_tokens=1_000_000, cache_read_tokens=1_000_000)
    assert estimate_cost(pricing, "claude-opus-5-5", usage) == pytest.approx(4 + 20 + 0.4)
    assert estimate_cost(pricing, "claude-sonnet-5-5", LlmUsage(input_tokens=1_000_000)) == pytest.approx(2.0)
    assert estimate_cost(pricing, "unknown-model", usage) == 0.0


async def test_kill_switch() -> None:
    router = LlmRouter(make_settings(ai_kill_switch=True), FakeProvider(), None)
    with pytest.raises(LlmError) as exc:
        await _collect(router, _request())
    assert exc.value.code == "LLM_DISABLED"


async def test_spend_cap_reached() -> None:
    router = LlmRouter(make_settings(llm_daily_spend_cap_usd=1.0), FakeProvider(), None)
    await _collect(router, _request())  # under the cap
    router.spend.add(1.5)
    with pytest.raises(LlmError) as exc:
        await _collect(router, _request())
    assert exc.value.code == "SPEND_CAP_REACHED"


class _FlakyProvider:
    name = "anthropic"

    def __init__(self, error: LlmError) -> None:
        self.error = error
        self.models: list[str] = []

    async def stream_chat(self, request: LlmRequest, model: str) -> AsyncIterator[TextDelta | LlmResult]:
        self.models.append(model)
        if model == "claude-opus-5-5":
            raise self.error
        yield TextDelta("fallback answer")
        yield LlmResult("fallback answer", model, "anthropic", "end_turn", LlmUsage(10, 5))

    async def complete_structured(self, request: LlmRequest, model: str, output_type: Any) -> Any:
        raise NotImplementedError


async def test_fallback_model_on_provider_5xx() -> None:
    settings = make_settings(llm_provider="anthropic", anthropic_api_key="sk-test-not-real")
    provider = _FlakyProvider(LlmError("LLM_UNAVAILABLE", "provider 529", fallback_ok=True))
    text, outcome = await _collect(LlmRouter(settings, provider, None), _request())
    assert provider.models == ["claude-opus-5-5", "claude-sonnet-5-5"]
    assert text == "fallback answer"
    assert outcome.fallback_used and outcome.model == "claude-sonnet-5-5" and outcome.retries == 1


async def test_no_fallback_on_rate_limit() -> None:
    settings = make_settings(llm_provider="anthropic", anthropic_api_key="sk-test-not-real")
    provider = _FlakyProvider(LlmError("LLM_RATE_LIMITED"))
    with pytest.raises(LlmError) as exc:
        await _collect(LlmRouter(settings, provider, None), _request())
    assert exc.value.code == "LLM_RATE_LIMITED"
    assert provider.models == ["claude-opus-5-5"]


async def test_record_replay(tmp_path: Any) -> None:
    rec = RecordingProvider(FakeProvider(), tmp_path, "record")
    req = _request()
    first = [i async for i in rec.stream_chat(req, "fake")]
    replay = RecordingProvider(FakeProvider(), tmp_path, "replay")
    second = [i async for i in replay.stream_chat(req, "fake")]
    assert [getattr(i, "text", None) for i in first] == [getattr(i, "text", None) for i in second]
    other = _request()
    other.messages = [{"role": "user", "content": "different"}]
    with pytest.raises(LlmError):
        _ = [i async for i in replay.stream_chat(other, "fake")]


# ---------------------------------------------------------------- Anthropic provider (fake SDK client)


class _FakeStream:
    def __init__(self, events: list[Any], final: Any) -> None:
        self._events = events
        self._final = final
        self.request_id = "req_test123"

    async def __aenter__(self) -> _FakeStream:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    def __aiter__(self) -> AsyncIterator[Any]:
        async def gen() -> AsyncIterator[Any]:
            for e in self._events:
                yield e

        return gen()

    async def get_final_message(self) -> Any:
        return self._final


def _delta(kind: str, text: str = "") -> Any:
    delta = SimpleNamespace(type=kind, text=text, thinking="")
    return SimpleNamespace(type="content_block_delta", delta=delta)


def _final(stop_reason: str = "end_turn", text: str = "Hello world") -> Any:
    usage = SimpleNamespace(
        input_tokens=12, output_tokens=4, cache_read_input_tokens=100, cache_creation_input_tokens=0, iterations=None
    )
    return SimpleNamespace(
        content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=text)],
        usage=usage,
        stop_reason=stop_reason,
        model="claude-opus-5-5",
    )


class _FakeMessages:
    def __init__(self, behaviours: list[Any]) -> None:
        self.behaviours = behaviours
        self.calls: list[dict[str, Any]] = []

    def stream(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        b = self.behaviours.pop(0)
        if isinstance(b, Exception):
            raise b
        return b

    async def parse(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        b = self.behaviours.pop(0)
        if isinstance(b, Exception):
            raise b
        return b


def _client(behaviours: list[Any]) -> tuple[Any, _FakeMessages]:
    messages = _FakeMessages(behaviours)
    return SimpleNamespace(beta=SimpleNamespace(messages=messages)), messages


def _http_response(status: int) -> httpx2.Response:
    return httpx2.Response(status, request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))


async def test_anthropic_stream_relays_only_text_and_sends_contract_params() -> None:
    settings = make_settings(llm_provider="anthropic", anthropic_api_key="sk-test-not-real")
    events = [_delta("thinking_delta"), _delta("text_delta", "Hello "), _delta("text_delta", "world")]
    client, messages = _client([_FakeStream(events, _final())])
    provider = AnthropicProvider(settings, client=client)
    items = [i async for i in provider.stream_chat(_request(), "claude-opus-5-5")]
    assert [i.text for i in items if isinstance(i, TextDelta)] == ["Hello ", "world"]
    result = items[-1]
    assert isinstance(result, LlmResult) and result.usage.cache_read_tokens == 100
    call = messages.calls[0]
    assert call["output_config"] == {"effort": "low"}
    assert call["betas"] == [FALLBACK_BETA] and call["fallbacks"] == "default"
    assert call["system"][0]["cache_control"] == {"type": "ephemeral"}
    for forbidden in ("thinking", "temperature", "top_p"):
        assert forbidden not in call


async def test_anthropic_refusal_maps_to_llm_refused() -> None:
    settings = make_settings(llm_provider="anthropic", anthropic_api_key="sk-test-not-real")
    client, _ = _client([_FakeStream([], _final(stop_reason="refusal", text=""))])
    provider = AnthropicProvider(settings, client=client)
    with pytest.raises(LlmError) as exc:
        _ = [i async for i in provider.stream_chat(_request(), "claude-opus-5-5")]
    assert exc.value.code == "LLM_REFUSED"


async def test_anthropic_disables_server_fallbacks_on_400() -> None:
    settings = make_settings(llm_provider="anthropic", anthropic_api_key="sk-test-not-real")
    bad = anthropic.BadRequestError("fallbacks: not supported for this model", response=_http_response(400), body=None)
    client, messages = _client([bad, _FakeStream([_delta("text_delta", "ok")], _final(text="ok"))])
    provider = AnthropicProvider(settings, client=client)
    items = [i async for i in provider.stream_chat(_request(), "claude-opus-5-5")]
    assert isinstance(items[-1], LlmResult)
    assert "betas" in messages.calls[0] and "betas" not in messages.calls[1]


@pytest.mark.parametrize(
    ("exc", "code", "fallback_ok"),
    [
        (anthropic.RateLimitError("rate", response=_http_response(429), body=None), "LLM_RATE_LIMITED", False),
        (anthropic.InternalServerError("boom", response=_http_response(500), body=None), "LLM_UNAVAILABLE", True),
        (anthropic.APIStatusError("overloaded", response=_http_response(529), body=None), "LLM_UNAVAILABLE", True),
        (anthropic.APITimeoutError(request=httpx2.Request("POST", "https://x")), "LLM_TIMEOUT", False),
        (anthropic.APIConnectionError(request=httpx2.Request("POST", "https://x")), "LLM_UNAVAILABLE", True),
    ],
)
async def test_anthropic_error_mapping(exc: Exception, code: str, fallback_ok: bool) -> None:
    settings = make_settings(llm_provider="anthropic", anthropic_api_key="sk-test-not-real")
    client, _ = _client([exc])
    provider = AnthropicProvider(settings, client=client)
    with pytest.raises(LlmError) as err:
        _ = [i async for i in provider.stream_chat(_request(), "claude-opus-5-5")]
    assert err.value.code == code
    assert err.value.fallback_ok is fallback_ok


class _Out(BaseModel):
    answer: str


async def test_anthropic_structured_uses_parse_with_effort() -> None:
    settings = make_settings(llm_provider="anthropic", anthropic_api_key="sk-test-not-real")
    usage = SimpleNamespace(
        input_tokens=5, output_tokens=3, cache_read_input_tokens=0, cache_creation_input_tokens=0, iterations=None
    )
    response = SimpleNamespace(
        parsed_output=_Out(answer="42"),
        usage=usage,
        stop_reason="end_turn",
        model="claude-opus-5-5",
        content=[SimpleNamespace(type="text", text='{"answer":"42"}')],
        _request_id="req_1",
    )
    client, messages = _client([response])
    req = _request()
    req.effort = "medium"
    parsed, result = await AnthropicProvider(settings, client=client).complete_structured(req, "claude-opus-5-5", _Out)
    assert parsed.answer == "42" and result.request_id == "req_1"
    assert messages.calls[0]["output_format"] is _Out
    assert messages.calls[0]["output_config"] == {"effort": "medium"}
