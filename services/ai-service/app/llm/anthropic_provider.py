"""Claude via the official ``anthropic`` SDK (async).

* Opus 5.5 always thinks: we never send ``thinking``/``temperature``; depth is ``output_config.effort``.
* Only ``text_delta`` text is relayed; thinking blocks are ignored.
* Stable system prompt first with ``cache_control``; volatile content lives in ``messages``.
* Server-side refusal fallbacks (``fallbacks="default"`` + beta header) when enabled; if the API rejects the
  parameter we log one warning and continue without it.
* Cancellation: when the consumer is cancelled (client disconnect) or closes the generator, the exception
  unwinds through ``async with ...messages.stream(...)``, whose exit closes the HTTP response, so Anthropic
  stops generating. Usage seen so far is reported with ``UsageUpdate`` items for the cancelled-run ledger.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import anthropic
from pydantic import ValidationError

from app.config import Settings
from app.llm.base import LlmError, LlmRequest, LlmResult, LlmUsage, T, TextDelta, UsageUpdate
from app.logging import get_logger

log = get_logger(__name__)

FALLBACK_BETA = "server-side-fallback-2026-07-01"


def _usage(usage: Any) -> LlmUsage:
    if usage is None:
        return LlmUsage()
    return LlmUsage(
        input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
        output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
        cache_read_tokens=int(getattr(usage, "cache_read_input_tokens", 0) or 0),
        cache_write_tokens=int(getattr(usage, "cache_creation_input_tokens", 0) or 0),
    )


def _served_by_fallback(usage: Any) -> bool:
    iterations = getattr(usage, "iterations", None) or []
    return any(getattr(i, "type", None) == "fallback_message" for i in iterations)


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, settings: Settings, client: anthropic.AsyncAnthropic | None = None) -> None:
        self._settings = settings
        self._client = client or anthropic.AsyncAnthropic(
            api_key=settings.anthropic_api_key.get_secret_value(),
            timeout=anthropic.Timeout(settings.llm_timeout_seconds, connect=5.0),
            max_retries=settings.llm_max_retries,
        )
        self._server_fallbacks = settings.llm_server_fallbacks
        self._fallback_warning_logged = False

    # ------------------------------------------------------------------ request building
    def _kwargs(self, request: LlmRequest, model: str) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": request.max_tokens,
            "system": [{"type": "text", "text": request.prompt.text, "cache_control": {"type": "ephemeral"}}],
            "messages": request.messages,
            "output_config": {"effort": request.effort},
        }
        if self._server_fallbacks:
            kwargs["betas"] = [FALLBACK_BETA]
            kwargs["fallbacks"] = "default"
        return kwargs

    def _maybe_disable_fallbacks(self, exc: anthropic.BadRequestError) -> bool:
        """Return True if the 400 was about server-side fallbacks (and disable them)."""
        if not self._server_fallbacks:
            return False
        text = f"{getattr(exc, 'message', '')} {exc.body if hasattr(exc, 'body') else ''}".lower()
        if "fallback" not in text and FALLBACK_BETA not in text:
            return False
        self._server_fallbacks = False
        if not self._fallback_warning_logged:
            self._fallback_warning_logged = True
            log.warning(
                "llm.server_fallbacks_disabled",
                message="API rejected server-side fallbacks; continuing without them",
                provider_request_id=getattr(exc, "request_id", None),
            )
        return True

    @staticmethod
    def _map_error(exc: Exception, model: str) -> LlmError:
        request_id = getattr(exc, "request_id", None)
        # most specific first
        if isinstance(exc, anthropic.RateLimitError):
            return LlmError("LLM_RATE_LIMITED", "provider rate limited", request_id=request_id, model=model)
        if isinstance(exc, anthropic.APITimeoutError):
            return LlmError("LLM_TIMEOUT", "provider timeout", request_id=request_id, model=model)
        if isinstance(exc, anthropic.APIStatusError):
            if exc.status_code >= 500:
                return LlmError(
                    "LLM_UNAVAILABLE",
                    f"provider {exc.status_code}",
                    fallback_ok=True,
                    request_id=request_id,
                    model=model,
                )
            return LlmError("LLM_UNAVAILABLE", f"provider {exc.status_code}", request_id=request_id, model=model)
        if isinstance(exc, anthropic.APIConnectionError):
            return LlmError("LLM_UNAVAILABLE", "connection failed", fallback_ok=True, model=model)
        return LlmError("LLM_UNAVAILABLE", type(exc).__name__, model=model)

    # ------------------------------------------------------------------ streaming
    async def stream_chat(
        self, request: LlmRequest, model: str
    ) -> AsyncIterator[TextDelta | UsageUpdate | LlmResult]:
        for attempt in range(2):
            kwargs = self._kwargs(request, model)
            started = False
            try:
                async with self._client.beta.messages.stream(**kwargs) as stream:
                    async for event in stream:
                        if event.type == "content_block_delta" and event.delta.type == "text_delta":
                            started = True
                            yield TextDelta(event.delta.text)
                        elif event.type == "message_start":
                            yield UsageUpdate(_usage(getattr(event.message, "usage", None)))
                        elif event.type == "message_delta" and getattr(event, "usage", None) is not None:
                            yield UsageUpdate(_usage(event.usage))
                    final = await stream.get_final_message()
                    request_id = stream.request_id
                break
            except anthropic.BadRequestError as exc:
                if attempt == 0 and not started and self._maybe_disable_fallbacks(exc):
                    continue
                raise self._map_error(exc, model) from exc
            except anthropic.APIError as exc:
                raise self._map_error(exc, model) from exc

        text = "".join(str(getattr(b, "text", "")) for b in final.content if b.type == "text")
        usage = _usage(final.usage)
        stop_reason = str(final.stop_reason or "end_turn")
        if stop_reason == "refusal":
            raise LlmError("LLM_REFUSED", "model declined", request_id=request_id, usage=usage, model=final.model)
        yield LlmResult(
            text=text,
            model=str(final.model or model),
            provider=self.name,
            stop_reason=stop_reason,
            usage=usage,
            request_id=request_id,
            server_fallback_used=_served_by_fallback(final.usage),
        )

    # ------------------------------------------------------------------ structured output
    async def complete_structured(self, request: LlmRequest, model: str, output_type: type[T]) -> tuple[T, LlmResult]:
        response: Any = None
        for attempt in range(2):
            kwargs = self._kwargs(request, model)
            try:
                response = await self._client.beta.messages.parse(output_format=output_type, **kwargs)
                break
            except anthropic.BadRequestError as exc:
                if attempt == 0 and self._maybe_disable_fallbacks(exc):
                    continue
                raise self._map_error(exc, model) from exc
            except anthropic.APIError as exc:
                raise self._map_error(exc, model) from exc
            except ValidationError as exc:
                raise LlmError("LLM_INVALID_OUTPUT", "structured output failed validation", model=model) from exc

        usage = _usage(response.usage)
        request_id = getattr(response, "_request_id", None)
        stop_reason = str(response.stop_reason or "end_turn")
        if stop_reason == "refusal":
            raise LlmError("LLM_REFUSED", "model declined", request_id=request_id, usage=usage, model=model)
        parsed = response.parsed_output
        if parsed is None:
            raise LlmError(
                "LLM_INVALID_OUTPUT",
                f"no parsed output (stop_reason={stop_reason})",
                request_id=request_id,
                usage=usage,
                model=model,
            )
        text = "".join(str(getattr(b, "text", "")) for b in response.content if b.type == "text")
        return parsed, LlmResult(
            text=text,
            model=str(response.model or model),
            provider=self.name,
            stop_reason=stop_reason,
            usage=usage,
            request_id=request_id,
            server_fallback_used=_served_by_fallback(response.usage),
        )
