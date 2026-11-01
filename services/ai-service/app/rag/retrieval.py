"""Hybrid retrieval: pgvector cosine top-20 + Postgres full-text top-20, fused with RRF (k=60) → top 6.

**Scope isolation:** both queries apply the service token's ``rscope`` in their ``WHERE`` clause, *before*
ranking (contracts §6). Request bodies never influence the scope.
"""

from __future__ import annotations

import re
import time
import uuid
from collections.abc import Hashable, Sequence
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.security import RetrievalScope
from app.text import content_words

SCOPE_SQL = (
    "((c.scope = 'course' AND c.course_id = ANY(CAST(:course_ids AS uuid[])))"
    " OR (c.scope = 'user' AND c.owner_user_id = CAST(:user_id AS uuid)))"
)
_COLUMNS = (
    "c.id, c.document_id, c.document_version, c.lesson_id, c.scope, c.course_id, c.owner_user_id, "
    "c.source_type, c.title, c.page, c.section, c.chunk_index, c.content"
)
_TSQ_SAFE = re.compile(r"^[a-z0-9]+$")


@dataclass
class RetrievedChunk:
    chunk_id: uuid.UUID
    document_id: uuid.UUID
    lesson_id: uuid.UUID | None
    scope: str
    course_id: uuid.UUID | None
    owner_user_id: uuid.UUID | None
    source_type: str
    title: str
    page: int | None
    section: str | None
    chunk_index: int
    content: str
    vector_rank: int | None = None
    keyword_rank: int | None = None
    similarity: float | None = None
    keyword_score: float | None = None
    score: float = 0.0


@dataclass
class RetrievalResult:
    chunks: list[RetrievedChunk]
    method: str
    timings: dict[str, float] = field(default_factory=dict)
    vector_candidates: int = 0
    keyword_candidates: int = 0

    @property
    def empty(self) -> bool:
        return not self.chunks


def rrf_fuse[K: Hashable](rankings: Sequence[Sequence[K]], k: int = 60) -> list[tuple[K, float]]:
    """Reciprocal Rank Fusion: score(d) = Σ_r 1 / (k + rank_r(d)), ranks starting at 1.

    Ties are broken by best (lowest) individual rank, then by first appearance.
    """
    scores: dict[K, float] = {}
    best: dict[K, int] = {}
    order: dict[K, int] = {}
    for ranking in rankings:
        for rank, key in enumerate(ranking, start=1):
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank)
            best[key] = min(best.get(key, rank), rank)
            order.setdefault(key, len(order))
    return sorted(scores.items(), key=lambda kv: (-kv[1], best[kv[0]], order[kv[0]]))


def build_tsquery(query: str, max_terms: int = 16) -> str | None:
    """OR-query of content words (sanitised to [a-z0-9]) for ``to_tsquery('english', ...)``."""
    terms: list[str] = []
    for w in content_words(query):
        w = w.replace("'", "").replace("-", "")
        if _TSQ_SAFE.match(w) and w not in terms:
            terms.append(w)
    if not terms:
        return None
    return " | ".join(terms[:max_terms])


def _vec_literal(vec: Sequence[float]) -> str:
    return "[" + ",".join(f"{x:.7f}" for x in vec) + "]"


def _row_to_chunk(row: Any) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=row.id,
        document_id=row.document_id,
        lesson_id=row.lesson_id,
        scope=row.scope,
        course_id=row.course_id,
        owner_user_id=row.owner_user_id,
        source_type=row.source_type,
        title=row.title,
        page=row.page,
        section=row.section,
        chunk_index=row.chunk_index,
        content=row.content,
    )


class HybridRetriever:
    def __init__(
        self,
        *,
        embedding_model: str,
        vector_k: int = 20,
        keyword_k: int = 20,
        rrf_k: int = 60,
        top_k: int = 6,
        min_similarity: float = 0.5,
        ef_search: int = 100,
    ) -> None:
        self.embedding_model = embedding_model
        self.vector_k = vector_k
        self.keyword_k = keyword_k
        self.rrf_k = rrf_k
        self.top_k = top_k
        self.min_similarity = min_similarity
        self.ef_search = ef_search
        self._iterative_scan: bool | None = None

    @staticmethod
    def scope_params(scope: RetrievalScope) -> dict[str, Any]:
        return {
            "course_ids": [str(c) for c in scope.course_ids],
            "user_id": str(scope.user_id) if scope.user_id else None,
        }

    async def _tune(self, session: AsyncSession) -> None:
        if self._iterative_scan is None:
            version = await session.scalar(text("SELECT extversion FROM pg_extension WHERE extname = 'vector'"))
            parts = [int(p) for p in re.findall(r"\d+", str(version or "0"))[:2]] + [0, 0]
            self._iterative_scan = (parts[0], parts[1]) >= (0, 8)
        await session.execute(text(f"SET LOCAL hnsw.ef_search = {int(self.ef_search)}"))
        if self._iterative_scan:
            # keep scanning the HNSW graph until enough rows pass the scope filter
            await session.execute(text("SET LOCAL hnsw.iterative_scan = relaxed_order"))

    async def search(
        self,
        session: AsyncSession,
        *,
        query: str,
        query_vector: Sequence[float],
        scope: RetrievalScope,
        source_types: Sequence[str] | None = None,
        top_k: int | None = None,
    ) -> RetrievalResult:
        top_k = top_k or self.top_k
        timings: dict[str, float] = {}
        if scope.is_empty:
            return RetrievalResult([], "hybrid", timings)
        params = self.scope_params(scope)
        type_sql = ""
        if source_types:
            type_sql = " AND c.source_type = ANY(CAST(:source_types AS text[]))"
            params["source_types"] = list(source_types)

        async with session.begin():
            await self._tune(session)

            t0 = time.perf_counter()
            vec_rows = (
                await session.execute(
                    text(
                        f"SELECT {_COLUMNS}, 1 - (e.embedding <=> CAST(:qvec AS vector)) AS similarity "  # noqa: S608
                        "FROM ai.document_chunks c JOIN ai.chunk_embeddings e ON e.chunk_id = c.id "
                        f"WHERE {SCOPE_SQL}{type_sql} AND e.model = :model "
                        "ORDER BY e.embedding <=> CAST(:qvec AS vector) LIMIT :k"
                    ),
                    {**params, "qvec": _vec_literal(query_vector), "model": self.embedding_model, "k": self.vector_k},
                )
            ).all()
            timings["vector_ms"] = round((time.perf_counter() - t0) * 1000, 1)

            kw_rows: Sequence[Any] = []
            tsq = build_tsquery(query)
            t1 = time.perf_counter()
            if tsq:
                kw_rows = (
                    await session.execute(
                        text(
                            f"SELECT {_COLUMNS}, ts_rank_cd(c.content_tsv, q) AS kw_score "  # noqa: S608
                            "FROM ai.document_chunks c, to_tsquery('english', :tsq) q "
                            f"WHERE {SCOPE_SQL}{type_sql} AND c.content_tsv @@ q "
                            "ORDER BY kw_score DESC, c.id LIMIT :k"
                        ),
                        {**params, "tsq": tsq, "k": self.keyword_k},
                    )
                ).all()
            timings["keyword_ms"] = round((time.perf_counter() - t1) * 1000, 1)

        t2 = time.perf_counter()
        chunks: dict[uuid.UUID, RetrievedChunk] = {}
        vector_ranking: list[uuid.UUID] = []
        for rank, row in enumerate(vec_rows, start=1):
            c = chunks.setdefault(row.id, _row_to_chunk(row))
            c.vector_rank, c.similarity = rank, float(row.similarity)
            vector_ranking.append(row.id)
        keyword_ranking: list[uuid.UUID] = []
        for rank, row in enumerate(kw_rows, start=1):
            c = chunks.setdefault(row.id, _row_to_chunk(row))
            c.keyword_rank, c.keyword_score = rank, float(row.kw_score)
            keyword_ranking.append(row.id)

        # relevance gate: a vector-only hit must be similar enough; keyword hits matched real terms
        def relevant(cid: uuid.UUID) -> bool:
            c = chunks[cid]
            return c.keyword_rank is not None or (c.similarity or 0.0) >= self.min_similarity

        fused = [(cid, s) for cid, s in rrf_fuse([vector_ranking, keyword_ranking], self.rrf_k) if relevant(cid)]
        result = []
        for cid, score in fused[:top_k]:
            chunks[cid].score = round(score, 6)
            result.append(chunks[cid])
        timings["fusion_ms"] = round((time.perf_counter() - t2) * 1000, 2)
        return RetrievalResult(
            result,
            "hybrid" if tsq else "vector",
            timings,
            vector_candidates=len(vec_rows),
            keyword_candidates=len(kw_rows),
        )
