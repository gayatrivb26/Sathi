"""LlmRouter: guards, fallback model, accounting and the ``llm.call`` log line.

* ``AI_KILL_SWITCH=true`` → every call fails with ``LLM_DISABLED``.
* Daily spend cap (sum of ``ai.model_runs.estimated_cost_usd`` since 00:00 UTC) → ``SPEND_CAP_REACHED``.
* Provider 5xx/overload/connection failure (after SDK retries) and before any token → fallback model.
* Every call writes an ``ai.model_runs`` row, emits metrics and one ``llm.call`` line (master spec §7.3).
* Cancellation (client disconnect, contracts §11.5): the provider stream is closed at once and the call is
  recorded with ``finish_reason='cancelled'`` and the tokens used so far (provider-reported where available,
  otherwise estimated from the prompt and the streamed text). Cancellation is not an error.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select

from app.aio import aclose_quietly, shielded
from app.config import Settings
from app.db import Database
from app.errors import current_trace_id
from app.llm.base import (
    LlmError,
    LlmProvider,
    LlmRequest,
    LlmResult,
    LlmUsage,
    T,
    TextDelta,
    UsageUpdate,
    estimate_tokens,
)
from app.logging import get_logger
from app.models import ModelRun
from app.telemetry import get_metrics

log = get_logger(__name__)


@dataclass
class LlmOutcome:
    """Final accounting for one routed call (success)."""

    text: str
    provider: str
    model: str
    prompt_name: str
    prompt_version: int
    prompt_hash: str
    usage: LlmUsage
    cost_usd: float
    ttft_ms: int | None
    latency_ms: int
    retries: int
    finish_reason: str
    fallback_used: bool
    request_id: str | None


def estimate_cost(pricing: dict[str, dict[str, float]], model: str, usage: LlmUsage) -> float:
    price = pricing.get(model)
    if price is None:
        # tolerate dated/aliased ids reported back by the API (e.g. "claude-opus-5-5-2026...")
        price = next((p for m, p in pricing.items() if model.startswith(m)), None)
    if price is None:
        return 0.0
    inp, out = price["input"], price["output"]
    cost = (
        usage.input_tokens * inp
        + usage.cache_write_tokens * inp * 1.25
        + usage.cache_read_tokens * inp * 0.1
        + usage.output_tokens * out
    ) / 1_000_000
    return round(cost, 6)


def merge_usage(seen: LlmUsage, update: LlmUsage) -> LlmUsage:
    """Provider usage counters are cumulative: keep the highest value seen for each."""
    return LlmUsage(
        input_tokens=max(seen.input_tokens, update.input_tokens),
        output_tokens=max(seen.output_tokens, update.output_tokens),
        cache_read_tokens=max(seen.cache_read_tokens, update.cache_read_tokens),
        cache_write_tokens=max(seen.cache_write_tokens, update.cache_write_tokens),
    )


def partial_usage(request: LlmRequest, seen: LlmUsage, streamed_text: str) -> LlmUsage:
    """Usage of a call cut short: what the provider reported, else an estimate from prompt and output."""
    input_tokens = seen.input_tokens
    if not (seen.input_tokens or seen.cache_read_tokens or seen.cache_write_tokens):
        input_tokens = estimate_tokens(request.prompt.text) + sum(
            estimate_tokens(m["content"]) for m in request.messages
        )
    return LlmUsage(
        input_tokens=input_tokens,
        output_tokens=max(seen.output_tokens, estimate_tokens(streamed_text)),
        cache_read_tokens=seen.cache_read_tokens,
        cache_write_tokens=seen.cache_write_tokens,
    )


class SpendTracker:
    """Today's LLM spend. Reads the DB at most every ``ttl`` seconds and adds local increments."""

    def __init__(self, db: Database | None, ttl: float = 15.0) -> None:
        self.db = db
        self.ttl = ttl
        self._value = 0.0
        self._read_at = 0.0
        self._day = ""

    async def today(self) -> float:
        day = datetime.now(UTC).strftime("%Y-%m-%d")
        if day != self._day:
            self._day, self._value, self._read_at = day, 0.0, 0.0
        if self.db is not None and time.monotonic() - self._read_at > self.ttl:
            start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
            async with self.db.session() as s:
                total = await s.scalar(
                    select(func.coalesce(func.sum(ModelRun.estimated_cost_usd), 0)).where(ModelRun.created_at >= start)
                )
            self._value = float(total or 0)
            self._read_at = time.monotonic()
        return self._value

    def add(self, amount: float) -> None:
        self._value += amount


class LlmRouter:
    def __init__(self, settings: Settings, provider: LlmProvider, db: Database | None) -> None:
        self.settings = settings
        self.provider = provider
        self.db = db
        self.spend = SpendTracker(db)

    # ------------------------------------------------------------------ guards
    async def _guard(self) -> None:
        if self.settings.ai_kill_switch:
            raise LlmError("LLM_DISABLED", "kill switch is on")
        cap = self.settings.llm_daily_spend_cap_usd
        if cap >= 0 and await self.spend.today() >= cap:
            raise LlmError("SPEND_CAP_REACHED", f"daily LLM spend cap {cap} USD reached")

    def _models(self) -> list[str]:
        primary = self.settings.llm_model if self.provider.name != "fake" else "fake"
        models = [primary]
        fb = self.settings.llm_fallback_model
        if self.provider.name != "fake" and fb and fb != primary:
            models.append(fb)
        return models

    # ------------------------------------------------------------------ accounting
    async def _record(
        self,
        request: LlmRequest,
        *,
        model: str,
        usage: LlmUsage,
        cost: float,
        ttft_ms: int | None,
        latency_ms: int,
        retries: int,
        finish_reason: str,
        error_code: str | None,
        fallback_used: bool,
        request_id: str | None,
    ) -> None:
        self.spend.add(cost)
        params: dict[str, Any] = {"max_tokens": request.max_tokens, "effort": request.effort}
        m = get_metrics()
        cancelled = finish_reason == "cancelled" and not error_code
        outcome = error_code or ("cancelled" if cancelled else "ok")
        verb = "failed" if error_code else "cancelled" if cancelled else "completed"
        attrs = {"purpose": request.purpose, "model": model, "outcome": outcome}
        m.llm_calls.add(1, attrs)
        m.llm_tokens.add(usage.input_tokens, {**attrs, "direction": "input"})
        m.llm_tokens.add(usage.output_tokens, {**attrs, "direction": "output"})
        m.llm_cost.add(cost, attrs)
        m.llm_latency.record(latency_ms, attrs)
        if ttft_ms is not None:
            m.llm_ttft.record(ttft_ms, attrs)
        line = {
            "message": f"LLM call {request.purpose} {verb}",
            "purpose": request.purpose,
            "provider": self.provider.name,
            "model": model,
            "prompt_name": request.prompt.name,
            "prompt_version": request.prompt.version,
            "prompt_hash": request.prompt.hash,
            "params": params,
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "cache_read_tokens": usage.cache_read_tokens,
            "cache_write_tokens": usage.cache_write_tokens,
            "cost_usd": cost,
            "ttft_ms": ttft_ms,
            "latency_ms": latency_ms,
            "retries": retries,
            "finish_reason": finish_reason,
            "error_code": error_code,
            "fallback_used": fallback_used,
            "provider_request_id": request_id,
            "run_id": str(request.run_id) if request.run_id else None,
        }
        if error_code:
            log.warning("llm.call", **line)
        else:
            log.info("llm.call", **line)
        if self.db is None:
            return
        try:
            async with self.db.transaction() as s:
                s.add(
                    ModelRun(
                        run_id=request.run_id,
                        trace_id=current_trace_id(),
                        purpose=request.purpose,
                        provider=self.provider.name,
                        model=model,
                        prompt_name=request.prompt.name,
                        prompt_version=request.prompt.version,
                        prompt_hash=request.prompt.hash,
                        params=params,
                        input_tokens=usage.input_tokens,
                        output_tokens=usage.output_tokens,
                        estimated_cost_usd=Decimal(str(cost)),
                        ttft_ms=ttft_ms,
                        latency_ms=latency_ms,
                        retries=retries,
                        finish_reason=finish_reason,
                        error_code=error_code,
                        fallback_used=fallback_used,
                    )
                )
        except Exception as exc:
            log.warning(
                "llm.record_failed", message="Could not write model_runs row", exception_type=type(exc).__name__
            )

    def _outcome(
        self,
        request: LlmRequest,
        result: LlmResult,
        *,
        cost: float,
        ttft: int | None,
        latency: int,
        retries: int,
        fallback_used: bool,
    ) -> LlmOutcome:
        return LlmOutcome(
            text=result.text,
            provider=result.provider,
            model=result.model,
            prompt_name=request.prompt.name,
            prompt_version=request.prompt.version,
            prompt_hash=request.prompt.hash,
            usage=result.usage,
            cost_usd=cost,
            ttft_ms=ttft,
            latency_ms=latency,
            retries=retries,
            finish_reason=result.stop_reason,
            fallback_used=fallback_used or result.server_fallback_used,
            request_id=result.request_id,
        )

    # ------------------------------------------------------------------ streaming
    async def stream(self, request: LlmRequest) -> AsyncIterator[TextDelta | LlmOutcome]:
        await self._guard()
        models = self._models()
        started = time.perf_counter()
        last_error: LlmError | None = None
        for attempt, model in enumerate(models):
            ttft: int | None = None
            streamed: list[str] = []
            seen = LlmUsage()
            recorded = False
            items = self.provider.stream_chat(request, model)
            try:
                async for item in items:
                    if isinstance(item, TextDelta):
                        if ttft is None:
                            ttft = int((time.perf_counter() - started) * 1000)
                        streamed.append(item.text)
                        yield item
                    elif isinstance(item, UsageUpdate):
                        seen = merge_usage(seen, item.usage)
                    else:
                        latency = int((time.perf_counter() - started) * 1000)
                        cost = estimate_cost(self.settings.llm_pricing, item.model, item.usage)
                        recorded = True
                        await shielded(
                            self._record(
                                request,
                                model=item.model,
                                usage=item.usage,
                                cost=cost,
                                ttft_ms=ttft,
                                latency_ms=latency,
                                retries=attempt,
                                finish_reason=item.stop_reason,
                                error_code=None,
                                fallback_used=attempt > 0 or item.server_fallback_used,
                                request_id=item.request_id,
                            )
                        )
                        yield self._outcome(
                            request,
                            item,
                            cost=cost,
                            ttft=ttft,
                            latency=latency,
                            retries=attempt,
                            fallback_used=attempt > 0,
                        )
                return
            except LlmError as err:
                latency = int((time.perf_counter() - started) * 1000)
                usage = err.usage or LlmUsage()
                cost = estimate_cost(self.settings.llm_pricing, err.model or model, usage)
                await shielded(
                    self._record(
                        request,
                        model=err.model or model,
                        usage=usage,
                        cost=cost,
                        ttft_ms=ttft,
                        latency_ms=latency,
                        retries=attempt,
                        finish_reason="refusal" if err.code == "LLM_REFUSED" else "error",
                        error_code=err.code,
                        fallback_used=attempt > 0,
                        request_id=err.request_id,
                    )
                )
                last_error = err
                if err.fallback_ok and not streamed and attempt + 1 < len(models):
                    log.warning(
                        "llm.fallback",
                        message=f"Primary model failed ({err.code}); trying fallback model",
                        model=model,
                        fallback_model=models[attempt + 1],
                        error_code=err.code,
                        provider_request_id=err.request_id,
                    )
                    continue
                raise
            except (asyncio.CancelledError, GeneratorExit):
                # The client went away: close the provider stream first (this ends the upstream HTTP request),
                # then account for what was used so far. Cancellation is not an error.
                await aclose_quietly(items)
                if not recorded:
                    usage = partial_usage(request, seen, "".join(streamed))
                    await shielded(
                        self._record(
                            request,
                            model=model,
                            usage=usage,
                            cost=estimate_cost(self.settings.llm_pricing, model, usage),
                            ttft_ms=ttft,
                            latency_ms=int((time.perf_counter() - started) * 1000),
                            retries=attempt,
                            finish_reason="cancelled",
                            error_code=None,
                            fallback_used=attempt > 0,
                            request_id=None,
                        )
                    )
                raise
            finally:
                await aclose_quietly(items)
        if last_error:  # pragma: no cover - loop always returns or raises
            raise last_error

    # ------------------------------------------------------------------ structured
    async def structured(self, request: LlmRequest, output_type: type[T]) -> tuple[T, LlmOutcome]:
        await self._guard()
        models = self._models()
        started = time.perf_counter()
        for attempt, model in enumerate(models):
            try:
                parsed, result = await self.provider.complete_structured(request, model, output_type)
            except LlmError as err:
                latency = int((time.perf_counter() - started) * 1000)
                usage = err.usage or LlmUsage()
                cost = estimate_cost(self.settings.llm_pricing, err.model or model, usage)
                await self._record(
                    request,
                    model=err.model or model,
                    usage=usage,
                    cost=cost,
                    ttft_ms=None,
                    latency_ms=latency,
                    retries=attempt,
                    finish_reason="refusal" if err.code == "LLM_REFUSED" else "error",
                    error_code=err.code,
                    fallback_used=attempt > 0,
                    request_id=err.request_id,
                )
                if err.fallback_ok and attempt + 1 < len(models):
                    log.warning(
                        "llm.fallback",
                        message=f"Primary model failed ({err.code}); trying fallback model",
                        model=model,
                        fallback_model=models[attempt + 1],
                        error_code=err.code,
                    )
                    continue
                raise
            latency = int((time.perf_counter() - started) * 1000)
            cost = estimate_cost(self.settings.llm_pricing, result.model, result.usage)
            await self._record(
                request,
                model=result.model,
                usage=result.usage,
                cost=cost,
                ttft_ms=None,
                latency_ms=latency,
                retries=attempt,
                finish_reason=result.stop_reason,
                error_code=None,
                fallback_used=attempt > 0 or result.server_fallback_used,
                request_id=result.request_id,
            )
            return parsed, self._outcome(
                request, result, cost=cost, ttft=None, latency=latency, retries=attempt, fallback_used=attempt > 0
            )
        raise LlmError("LLM_UNAVAILABLE", "no model available")  # pragma: no cover
