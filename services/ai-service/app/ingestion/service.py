"""Ingestion: parse → parsed JSON in storage; index → chunk + embed + replace rows in ONE transaction.

Indexing is idempotent: all chunks of the document (any version) are deleted and the new ones inserted
in the same transaction, under a per-document advisory lock, so re-running a job never duplicates rows.
A semaphore (``INGEST_CONCURRENCY``) bounds concurrent CPU-heavy work per instance.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, insert, text

from app.config import Settings
from app.db import Database
from app.embeddings.base import EmbeddingProvider
from app.errors import AppError
from app.ingestion.parsers import parse_document
from app.logging import get_logger
from app.models import ChunkEmbedding, DebugCapture, DocumentChunk
from app.rag.chunking import Chunk, PageText, chunk_pages
from app.storage import ObjectStorage
from app.telemetry import get_metrics

log = get_logger(__name__)

MAX_SOURCE_BYTES = 26 * 1024 * 1024


@dataclass
class ParseOutcome:
    page_count: int
    char_count: int
    parsed_key: str


@dataclass
class IndexOutcome:
    passage_count: int
    embedding_model: str


def parsed_key(document_id: uuid.UUID, version: int) -> str:
    return f"parsed/{document_id}/v{version}.json"


def embedding_text(title: str, chunk: Chunk) -> str:
    parts = [title]
    if chunk.section:
        parts.append(chunk.section)
    parts.append(chunk.content)
    return "\n".join(parts)


class IngestionService:
    def __init__(self, settings: Settings, db: Database, storage: ObjectStorage, embedder: EmbeddingProvider) -> None:
        self.settings = settings
        self.db = db
        self.storage = storage
        self.embedder = embedder
        self._sem = asyncio.Semaphore(max(1, settings.ingest_concurrency))

    def _step(self, stage: str, started: float, **fields: Any) -> None:
        duration = round((time.perf_counter() - started) * 1000, 1)
        get_metrics().ingest_steps.add(1, {"stage": stage, "outcome": "ok"})
        log.info(
            "ingest.step",
            message=f"Ingestion {stage} completed",
            stage=stage,
            outcome="ok",
            duration_ms=duration,
            **fields,
        )

    # ------------------------------------------------------------------ parse
    async def parse(
        self, *, document_id: uuid.UUID, version: int, storage_key: str, content_type: str, file_name: str
    ) -> ParseOutcome:
        async with self._sem:
            started = time.perf_counter()
            data = await self.storage.get_bytes(storage_key, max_bytes=MAX_SOURCE_BYTES)
            doc = await asyncio.to_thread(parse_document, data, content_type, file_name)
            if doc.char_count > self.settings.ingest_max_parsed_chars:
                raise AppError(
                    "INGEST_PARSE_FAILED", "This file has too much text to process.", internal=f"chars={doc.char_count}"
                )
            key = parsed_key(document_id, version)
            payload = {
                "documentId": str(document_id),
                "documentVersion": version,
                "fileName": file_name,
                "contentType": content_type,
                "format": doc.format,
                "pageCount": doc.page_count,
                "charCount": doc.char_count,
                "pages": [{"page": p.page, "text": p.text} for p in doc.pages],
            }
            await self.storage.put_bytes(
                key, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json"
            )
            self._step(
                "parse",
                started,
                document_id=str(document_id),
                document_version=version,
                format=doc.format,
                page_count=doc.page_count,
                char_count=doc.char_count,
                size_bytes=len(data),
            )
            return ParseOutcome(doc.page_count, doc.char_count, key)

    # ------------------------------------------------------------------ index
    async def index_parsed(self, *, parsed_key: str, **kwargs: Any) -> IndexOutcome:
        raw = await self.storage.get_bytes(parsed_key)
        try:
            payload = json.loads(raw)
            pages = [PageText(p.get("page"), str(p.get("text") or "")) for p in payload["pages"]]
        except (ValueError, KeyError, TypeError) as exc:
            raise AppError("INGEST_PARSE_FAILED", internal="parsed JSON is invalid") from exc
        return await self.index_pages(pages=pages, **kwargs)

    async def index_pages(
        self,
        *,
        pages: list[PageText],
        document_id: uuid.UUID,
        version: int,
        scope: str,
        source_type: str,
        title: str,
        owner_user_id: uuid.UUID | None = None,
        course_id: uuid.UUID | None = None,
        lesson_id: uuid.UUID | None = None,
    ) -> IndexOutcome:
        if scope == "user" and owner_user_id is None:
            raise AppError("VALIDATION_FAILED", errors={"ownerUserId": ["Required when scope is 'user'."]})
        if scope == "course" and course_id is None:
            raise AppError("VALIDATION_FAILED", errors={"courseId": ["Required when scope is 'course'."]})
        async with self._sem:
            started = time.perf_counter()
            chunks = chunk_pages(
                pages,
                target_tokens=self.settings.ingest_chunk_tokens,
                overlap=self.settings.ingest_chunk_overlap,
            )
            if not chunks:
                raise AppError("INGEST_NO_TEXT", internal="no chunks produced")
            t_embed = time.perf_counter()
            try:
                vectors = await self.embedder.embed_documents([embedding_text(title, c) for c in chunks])
            except Exception as exc:
                raise AppError("INGEST_INDEX_FAILED", internal=f"embedding failed: {type(exc).__name__}") from exc
            embed_ms = round((time.perf_counter() - t_embed) * 1000, 1)

            rows = []
            emb_rows = []
            for chunk, vec in zip(chunks, vectors, strict=True):
                cid = uuid.uuid4()
                rows.append(
                    {
                        "id": cid,
                        "document_id": document_id,
                        "document_version": version,
                        "scope": scope,
                        "owner_user_id": owner_user_id if scope == "user" else None,
                        "course_id": course_id,
                        "lesson_id": lesson_id,
                        "source_type": source_type,
                        "title": title[:500],
                        "page": chunk.page,
                        "section": chunk.section,
                        "chunk_index": chunk.index,
                        "content": chunk.content,
                        "token_count": chunk.token_count,
                    }
                )
                emb_rows.append(
                    {"chunk_id": cid, "model": self.embedder.model, "dim": self.embedder.dim, "embedding": vec}
                )
            try:
                async with self.db.transaction() as s:
                    await s.execute(
                        text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"doc:{document_id}"}
                    )
                    await s.execute(delete(DocumentChunk).where(DocumentChunk.document_id == document_id))
                    await s.execute(insert(DocumentChunk), rows)
                    await s.execute(insert(ChunkEmbedding), emb_rows)
            except AppError:
                raise
            except Exception as exc:
                raise AppError("INGEST_INDEX_FAILED", internal=f"db: {type(exc).__name__}") from exc
            self._step(
                "index",
                started,
                document_id=str(document_id),
                document_version=version,
                passage_count=len(chunks),
                embed_ms=embed_ms,
                embedding_model=self.embedder.model,
                scope=scope,
                source_type=source_type,
            )
            return IndexOutcome(len(chunks), self.embedder.model)

    # ------------------------------------------------------------------ deletion
    async def delete_document(self, document_id: uuid.UUID) -> int:
        async with self.db.transaction() as s:
            result = await s.execute(delete(DocumentChunk).where(DocumentChunk.document_id == document_id))
        try:
            await self.storage.delete_prefix(f"parsed/{document_id}/")
        except Exception as exc:
            log.warning("ingest.parsed_cleanup_failed", document_id=str(document_id), exception_type=type(exc).__name__)
        count = int(getattr(result, "rowcount", 0) or 0)
        log.info(
            "ingest.document_deleted",
            message="Document chunks deleted",
            document_id=str(document_id),
            chunk_count=count,
        )
        return count

    async def delete_user(self, user_id: uuid.UUID, user_hash: str) -> tuple[int, int]:
        async with self.db.transaction() as s:
            chunks = await s.execute(delete(DocumentChunk).where(DocumentChunk.owner_user_id == user_id))
            captures = await s.execute(delete(DebugCapture).where(DebugCapture.user_id_hash == user_hash))
        counts = (int(getattr(chunks, "rowcount", 0) or 0), int(getattr(captures, "rowcount", 0) or 0))
        log.info(
            "ingest.user_deleted",
            message="User AI data deleted",
            user_id_hash=user_hash,
            chunk_count=counts[0],
            debug_capture_count=counts[1],
        )
        return counts
