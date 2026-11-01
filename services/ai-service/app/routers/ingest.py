"""Ingestion endpoints (contracts §6). Content failures → 422 ProblemDetails with INGEST_* codes."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.container import Container
from app.deps import get_container, ingestion
from app.errors import AppError
from app.logging import bind
from app.openapi import internal
from app.rag.chunking import PageText
from app.schemas import IndexRequest, IndexResponse, IndexTextRequest, ParseRequest, ParseResponse
from app.security import Principal, require_scope

router = APIRouter(prefix="/internal/v1/ingest", tags=["ingest"])


@router.post(
    "/parse",
    response_model=ParseResponse,
    summary="Parse an uploaded file into text",
    description="Reads `storageKey` (uploads/* or lessons/*) and writes `parsed/{documentId}/v{version}.json`.",
    **internal("ingest", 404, 422, 503),
)
async def parse(
    body: ParseRequest,
    _: Principal = Depends(require_scope("ingest")),
    container: Container = Depends(get_container),
) -> ParseResponse:
    bind(document_id=str(body.document_id), document_version=body.document_version)
    out = await ingestion(container).parse(
        document_id=body.document_id,
        version=body.document_version,
        storage_key=body.storage_key,
        content_type=body.content_type,
        file_name=body.file_name,
    )
    return ParseResponse(page_count=out.page_count, char_count=out.char_count, parsed_key=out.parsed_key)


@router.post(
    "/index",
    response_model=IndexResponse,
    summary="Chunk, embed and index a parsed document",
    description="Idempotent: replaces the document's chunks (any version) in one transaction.",
    **internal("ingest", 404, 422, 503),
)
async def index(
    body: IndexRequest,
    _: Principal = Depends(require_scope("ingest")),
    container: Container = Depends(get_container),
) -> IndexResponse:
    bind(document_id=str(body.document_id), document_version=body.document_version)
    out = await ingestion(container).index_parsed(
        parsed_key=body.parsed_key,
        document_id=body.document_id,
        version=body.document_version,
        scope=body.scope,
        source_type=body.source_type,
        title=body.title,
        owner_user_id=body.owner_user_id,
        course_id=body.course_id,
        lesson_id=body.lesson_id,
    )
    return IndexResponse(passage_count=out.passage_count, embedding_model=out.embedding_model)


@router.post(
    "/text",
    response_model=IndexResponse,
    summary="Index lesson Markdown directly (no file)",
    description="Course lesson content; idempotent like `/ingest/index`.",
    **internal("ingest", 422, 503),
)
async def index_text(
    body: IndexTextRequest,
    _: Principal = Depends(require_scope("ingest")),
    container: Container = Depends(get_container),
) -> IndexResponse:
    bind(document_id=str(body.document_id), document_version=body.document_version)
    if sum(1 for ch in body.markdown if not ch.isspace()) < 50:
        raise AppError("INGEST_NO_TEXT", "This lesson has too little text to index.", internal="short markdown")
    out = await ingestion(container).index_pages(
        pages=[PageText(None, body.markdown)],
        document_id=body.document_id,
        version=body.document_version,
        scope="course",
        source_type="course",
        title=body.title,
        course_id=body.course_id,
        lesson_id=body.lesson_id,
    )
    return IndexResponse(passage_count=out.passage_count, embedding_model=out.embedding_model)
