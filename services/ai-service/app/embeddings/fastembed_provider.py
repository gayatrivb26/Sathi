"""Local CPU embeddings with fastembed (ONNX): BAAI/bge-small-en-v1.5, dim 384.

The model is baked into the image (``FASTEMBED_CACHE_PATH=/app/models``); inference runs in a worker
thread so the event loop stays responsive.
"""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from typing import Any

from app.logging import get_logger

log = get_logger(__name__)


class FastEmbedProvider:
    def __init__(self, model: str, dim: int, cache_dir: Path | None, *, offline: bool = False) -> None:
        self.model = model
        self.dim = dim
        self._cache_dir = str(cache_dir) if cache_dir else None
        self._offline = offline
        self._impl: Any = None
        self.relevance_floor = 0.5
        self._lock = threading.Lock()

    def _load(self) -> Any:
        with self._lock:
            if self._impl is None:
                from fastembed import TextEmbedding

                kwargs: dict[str, Any] = {"cache_dir": self._cache_dir}
                if self._offline:
                    kwargs["local_files_only"] = True
                self._impl = TextEmbedding(self.model, **kwargs)
                log.info("embeddings.loaded", message="Embedding model loaded", model=self.model)
            return self._impl

    async def warm_up(self) -> None:
        # Loading alone is not enough: the first ONNX inference initialises the session and is slow, so run one
        # query and one passage embedding before the service reports ready (keeps the first student's TTFT low).
        await asyncio.to_thread(self._load)
        await self.embed_query("warm up")
        await self.embed_documents(["warm up"])

    @staticmethod
    def _normalise(vec: Any) -> list[float]:
        import numpy as np

        arr = np.asarray(vec, dtype=np.float32)
        norm = float(np.linalg.norm(arr))
        if norm > 0:
            arr = arr / norm
        return [float(x) for x in arr]

    def _embed_docs(self, texts: list[str]) -> list[list[float]]:
        impl = self._load()
        return [self._normalise(v) for v in impl.passage_embed(texts, batch_size=32)]

    def _embed_query(self, text: str) -> list[float]:
        impl = self._load()
        return self._normalise(next(iter(impl.query_embed(text))))

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        return await asyncio.to_thread(self._embed_docs, texts)

    async def embed_query(self, text: str) -> list[float]:
        return await asyncio.to_thread(self._embed_query, text)
