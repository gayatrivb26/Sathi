"""Embedding provider interface. Vectors are L2-normalised so cosine distance == 1 - dot product."""

from __future__ import annotations

from typing import Protocol


class EmbeddingProvider(Protocol):
    model: str
    dim: int
    relevance_floor: float  # min cosine similarity for a vector-only hit to count as relevant

    async def embed_documents(self, texts: list[str]) -> list[list[float]]: ...

    async def embed_query(self, text: str) -> list[float]: ...
