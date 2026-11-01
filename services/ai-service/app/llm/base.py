"""Provider-neutral LLM interface."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, TypeVar

from pydantic import BaseModel

from app.prompts import Prompt

Purpose = Literal["tutor", "query_rewrite", "quiz_generation", "grading", "evaluation"]
Effort = Literal["low", "medium", "high"]
T = TypeVar("T", bound=BaseModel)


@dataclass
class LlmRequest:
    purpose: Purpose
    prompt: Prompt  # stable system prompt (cached)
    messages: list[dict[str, str]]  # [{"role": "user"|"assistant", "content": str}], volatile content
    max_tokens: int
    effort: Effort
    run_id: uuid.UUID | None = None
    conversation_id: uuid.UUID | None = None
    # Structured hints used only by the deterministic FakeProvider (never sent to a real provider).
    context: dict[str, Any] = field(default_factory=dict)


@dataclass
class LlmUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


@dataclass
class TextDelta:
    text: str


@dataclass
class UsageUpdate:
    """Provider-reported usage so far (e.g. input tokens from ``message_start``), consumed by the router.

    It lets a cancelled stream be accounted with real numbers; it is never forwarded to callers.
    """

    usage: LlmUsage


def estimate_tokens(text: str) -> int:
    """Rough token count (~4 characters per token) used when a provider cannot report usage."""
    return (len(text) + 3) // 4


@dataclass
class LlmResult:
    text: str
    model: str
    provider: str
    stop_reason: str
    usage: LlmUsage
    request_id: str | None = None
    server_fallback_used: bool = False


class LlmError(Exception):
    """Provider failure mapped to a contract error code.

    ``fallback_ok`` marks failures where trying the fallback model makes sense (5xx/overload/connection).
    """

    def __init__(
        self,
        code: str,
        message: str = "",
        *,
        fallback_ok: bool = False,
        request_id: str | None = None,
        usage: LlmUsage | None = None,
        model: str | None = None,
    ) -> None:
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code
        self.message = message
        self.fallback_ok = fallback_ok
        self.request_id = request_id
        self.usage = usage
        self.model = model


class LlmProvider(Protocol):
    name: str

    def stream_chat(self, request: LlmRequest, model: str) -> AsyncIterator[TextDelta | UsageUpdate | LlmResult]:
        """Yield ``TextDelta`` (and optional ``UsageUpdate``) items, then exactly one final ``LlmResult``.

        Raise ``LlmError`` on failure. When the consumer is cancelled or closes the generator, the provider must
        release its upstream request (exit the SDK stream context) promptly.
        """
        ...

    async def complete_structured(
        self, request: LlmRequest, model: str, output_type: type[T]
    ) -> tuple[T, LlmResult]: ...
