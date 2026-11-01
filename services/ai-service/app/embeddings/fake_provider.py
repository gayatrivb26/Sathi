"""Deterministic hashed bag-of-words embeddings (dim 384, L2-normalised) for tests and keyless runs."""

from __future__ import annotations

import hashlib
import math

from app.text import content_words


def _bucket(token: str, dim: int) -> tuple[int, float]:
    digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
    value = int.from_bytes(digest, "big")
    return value % dim, 1.0 if (value >> 63) & 1 == 0 else -1.0


def hashed_embedding(text: str, dim: int = 384) -> list[float]:
    vec = [0.0] * dim
    tokens = content_words(text)
    for tok in tokens:
        idx, sign = _bucket(tok, dim)
        vec[idx] += sign
        if len(tok) > 4:  # crude stemming signal: shared prefixes land together
            idx2, sign2 = _bucket("pre:" + tok[:5], dim)
            vec[idx2] += 0.5 * sign2
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0:
        vec[0] = 1.0
        return vec
    return [v / norm for v in vec]


class FakeEmbeddingProvider:
    def __init__(self, dim: int = 384, model: str = "fake-hashed-bow-384") -> None:
        self.dim = dim
        self.model = model
        self.relevance_floor = 0.15

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [hashed_embedding(t, self.dim) for t in texts]

    async def embed_query(self, text: str) -> list[float]:
        return hashed_embedding(text, self.dim)
