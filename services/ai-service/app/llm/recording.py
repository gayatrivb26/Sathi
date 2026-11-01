"""Record/replay wrapper keyed by a hash of the request, for deterministic tests against real outputs.

``record`` calls the inner provider and stores the result in ``<dir>/<hash>.json``; ``replay`` serves
stored results only (a missing recording raises ``LLM_UNAVAILABLE``). Recordings contain model output,
so keep them to synthetic test inputs.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator
from dataclasses import asdict
from pathlib import Path
from typing import Any, Literal

from app.llm.base import LlmError, LlmProvider, LlmRequest, LlmResult, LlmUsage, T, TextDelta, UsageUpdate


def request_key(request: LlmRequest, model: str, kind: str, schema: str | None = None) -> str:
    payload = {
        "kind": kind,
        "model": model,
        "purpose": request.purpose,
        "prompt_hash": request.prompt.hash,
        "messages": request.messages,
        "max_tokens": request.max_tokens,
        "effort": request.effort,
        "schema": schema,
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:32]


class RecordingProvider:
    def __init__(self, inner: LlmProvider, directory: Path, mode: Literal["record", "replay"]) -> None:
        self.inner = inner
        self.directory = directory
        self.mode = mode
        self.name = inner.name

    def _path(self, key: str) -> Path:
        return self.directory / f"{key}.json"

    def _load(self, key: str) -> dict[str, Any]:
        path = self._path(key)
        if not path.exists():
            raise LlmError("LLM_UNAVAILABLE", f"no recording {key}")
        data: dict[str, Any] = json.loads(path.read_text("utf-8"))
        return data

    def _save(self, key: str, data: dict[str, Any]) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        self._path(key).write_text(json.dumps(data, indent=2, ensure_ascii=False), "utf-8")

    @staticmethod
    def _result(data: dict[str, Any]) -> LlmResult:
        return LlmResult(
            text=data["text"],
            model=data["model"],
            provider=data["provider"],
            stop_reason=data["stop_reason"],
            usage=LlmUsage(**data["usage"]),
            request_id=data.get("request_id"),
        )

    async def stream_chat(
        self, request: LlmRequest, model: str
    ) -> AsyncIterator[TextDelta | UsageUpdate | LlmResult]:
        key = request_key(request, model, "stream")
        if self.mode == "replay":
            data = self._load(key)
            for chunk in data["chunks"]:
                yield TextDelta(chunk)
            yield self._result(data)
            return
        chunks: list[str] = []
        async for item in self.inner.stream_chat(request, model):
            if isinstance(item, TextDelta):
                chunks.append(item.text)
            elif isinstance(item, LlmResult):
                self._save(key, {"chunks": chunks, **asdict(item)})
            yield item

    async def complete_structured(self, request: LlmRequest, model: str, output_type: type[T]) -> tuple[T, LlmResult]:
        key = request_key(request, model, "structured", output_type.__name__)
        if self.mode == "replay":
            data = self._load(key)
            return output_type.model_validate(data["parsed"]), self._result(data)
        parsed, result = await self.inner.complete_structured(request, model, output_type)
        self._save(key, {"parsed": parsed.model_dump(mode="json"), **asdict(result)})
        return parsed, result
