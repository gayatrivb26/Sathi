"""Scope isolation against real pgvector: the token's rscope is applied inside SQL before ranking."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select, text

from app.container import Container
from app.models import ChunkEmbedding, DocumentChunk
from app.security import RetrievalScope
from tests.conftest import COURSE_X, COURSE_Y, USER_A, USER_B, index_text

pytestmark = pytest.mark.db

SECRET_NOTES = "Quokka zebra protocol: my private exam answers about gradient descent and learning rates. " * 6
COURSE_X_TEXT = "Gradient descent updates parameters using the learning rate times the gradient. " * 6
COURSE_Y_TEXT = "Gradient descent in course Y: hidden premium material about learning rates. " * 6


async def _search(container: Container, query: str, scope: RetrievalScope) -> list[str]:
    assert container.db is not None
    qvec = await container.embedder.embed_query(query)
    async with container.db.session() as s:
        result = await container.retriever.search(s, query=query, query_vector=qvec, scope=scope)
    return [c.title for c in result.chunks]


async def test_scope_isolation(container: Container) -> None:
    await index_text(container, SECRET_NOTES, title="A-private-notes", scope="user", owner=USER_A)
    await index_text(
        container,
        "User B notes on gradient descent and learning rates. " * 6,
        title="B-notes",
        scope="user",
        owner=USER_B,
    )
    await index_text(container, COURSE_X_TEXT, title="X-lesson", course_id=COURSE_X)
    await index_text(container, COURSE_Y_TEXT, title="Y-lesson", course_id=COURSE_Y)

    # user B, enrolled in course X only, asks a question that matches A's notes best
    titles = await _search(
        container,
        "quokka zebra protocol private exam answers gradient descent",
        RetrievalScope(course_ids=(COURSE_X,), user_id=USER_B),
    )
    assert titles, "expected some results"
    assert "A-private-notes" not in titles
    assert "Y-lesson" not in titles
    assert set(titles) <= {"B-notes", "X-lesson"}

    # user A sees their own notes
    titles_a = await _search(container, "quokka zebra protocol", RetrievalScope(course_ids=(COURSE_X,), user_id=USER_A))
    assert "A-private-notes" in titles_a and "B-notes" not in titles_a

    # course-only scope never returns any upload
    titles_c = await _search(container, "gradient descent learning rate", RetrievalScope(course_ids=(COURSE_Y,)))
    assert titles_c and set(titles_c) == {"Y-lesson"}

    # empty scope returns nothing (no query at all)
    assert await _search(container, "gradient descent", RetrievalScope()) == []


async def test_hybrid_ranks_and_relevance_gate(container: Container) -> None:
    await index_text(
        container, "Reciprocal rank fusion combines ranked lists with 1/(k + rank). " * 5, title="RRF lesson"
    )
    await index_text(
        container, "Cooking pasta requires boiling salted water for ten minutes. " * 5, title="Unrelated lesson"
    )
    assert container.db is not None
    qvec = await container.embedder.embed_query("how does reciprocal rank fusion work")
    async with container.db.session() as s:
        result = await container.retriever.search(
            s,
            query="how does reciprocal rank fusion work",
            query_vector=qvec,
            scope=RetrievalScope(course_ids=(COURSE_X,)),
        )
    assert result.method == "hybrid"
    assert [c.title for c in result.chunks][0] == "RRF lesson"
    assert all(c.title != "Unrelated lesson" for c in result.chunks)
    top = result.chunks[0]
    assert top.keyword_rank == 1 and top.vector_rank == 1
    assert top.score == pytest.approx(2 / 61, abs=1e-6)


async def test_generated_tsvector_and_indexes_exist(container: Container) -> None:
    await index_text(container, COURSE_X_TEXT, title="X")
    assert container.db is not None
    async with container.db.session() as s:
        tsv = await s.scalar(text("SELECT content_tsv::text FROM ai.document_chunks LIMIT 1"))
        assert "gradient" in tsv
        idx = set((await s.execute(text("SELECT indexname FROM pg_indexes WHERE schemaname = 'ai'"))).scalars())
    assert {
        "ix_chunk_embeddings_hnsw",
        "ix_document_chunks_tsv",
        "ix_document_chunks_scope_course",
        "ix_document_chunks_owner",
    } <= idx


async def test_reindex_is_idempotent(container: Container) -> None:
    assert container.db is not None and container.ingestion is not None
    doc = uuid.uuid4()
    long_text = "\n\n".join(f"Paragraph {i}: attention weights are a softmax over scores. " * 8 for i in range(6))
    await index_text(container, long_text, title="Doc", document_id=doc)
    async with container.db.session() as s:
        first = await s.scalar(select(func.count()).select_from(DocumentChunk).where(DocumentChunk.document_id == doc))
    assert first and first > 1
    await index_text(container, long_text, title="Doc", document_id=doc)  # same job re-run
    await index_text(container, long_text, title="Doc", document_id=doc)
    async with container.db.session() as s:
        again = await s.scalar(select(func.count()).select_from(DocumentChunk).where(DocumentChunk.document_id == doc))
        emb = await s.scalar(select(func.count()).select_from(ChunkEmbedding))
    assert again == first and emb == first

    # a new version replaces the old one entirely
    await index_text(
        container,
        "Version two is shorter but still long enough to index properly. " * 3,
        title="Doc",
        document_id=doc,
        version=2,
    )
    async with container.db.session() as s:
        versions = (
            (await s.execute(select(DocumentChunk.document_version).where(DocumentChunk.document_id == doc).distinct()))
            .scalars()
            .all()
        )
    assert versions == [2]

    deleted = await container.ingestion.delete_document(doc)
    assert deleted >= 1
    async with container.db.session() as s:
        assert await s.scalar(select(func.count()).select_from(ChunkEmbedding)) == 0  # cascade


async def test_delete_user_removes_only_their_chunks(container: Container) -> None:
    assert container.db is not None and container.ingestion is not None
    await index_text(container, SECRET_NOTES, title="A", scope="user", owner=USER_A)
    await index_text(container, SECRET_NOTES, title="B", scope="user", owner=USER_B)
    await index_text(container, COURSE_X_TEXT, title="X")
    chunks, _ = await container.ingestion.delete_user(USER_A, "hash")
    assert chunks >= 1
    async with container.db.session() as s:
        titles = set((await s.execute(select(DocumentChunk.title))).scalars())
    assert titles == {"B", "X"}
