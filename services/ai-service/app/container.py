"""Composition root: builds every service from Settings (real or injected fakes for tests)."""

from __future__ import annotations

from dataclasses import dataclass

from app.config import Settings
from app.db import Database
from app.embeddings.base import EmbeddingProvider
from app.embeddings.fake_provider import FakeEmbeddingProvider
from app.embeddings.fastembed_provider import FastEmbedProvider
from app.grading.grade import Grader
from app.ingestion.service import IngestionService
from app.llm.anthropic_provider import AnthropicProvider
from app.llm.base import LlmProvider
from app.llm.fake_provider import FakeProvider
from app.llm.recording import RecordingProvider
from app.llm.router import LlmRouter
from app.prompts import PromptLibrary
from app.quiz.generate import QuizGenerator
from app.rag.retrieval import HybridRetriever
from app.search.base import SearchProvider
from app.search.brave import BraveSearchProvider
from app.search.fake import FakeSearchProvider
from app.search.fetcher import SafeFetcher
from app.search.service import WebSearchService
from app.search.tavily import TavilySearchProvider
from app.storage import ObjectStorage, S3Storage
from app.tutor.service import TutorService


def build_llm_provider(settings: Settings) -> LlmProvider:
    provider: LlmProvider = AnthropicProvider(settings) if settings.llm_provider == "anthropic" else FakeProvider()
    if settings.llm_record_mode != "off":
        provider = RecordingProvider(provider, settings.llm_recordings_dir, settings.llm_record_mode)
    return provider


def build_embedder(settings: Settings) -> EmbeddingProvider:
    if settings.embedding_provider == "fake":
        return FakeEmbeddingProvider(settings.embedding_dim)
    emb = FastEmbedProvider(
        settings.embedding_model,
        settings.embedding_dim,
        settings.fastembed_cache_path,
        offline=settings.fastembed_offline,
    )
    emb.relevance_floor = settings.rag_min_vector_similarity
    return emb


def build_search_provider(settings: Settings) -> SearchProvider | None:
    match settings.search_provider:
        case "tavily":
            return TavilySearchProvider(
                settings.tavily_api_key.get_secret_value(),
                timeout=settings.web_search_timeout_seconds,
                cost_per_query=settings.web_search_cost_per_query_usd,
            )
        case "brave":
            return BraveSearchProvider(
                settings.brave_api_key.get_secret_value(),
                timeout=settings.web_search_timeout_seconds,
                cost_per_query=settings.web_search_cost_per_query_usd,
            )
        case "fake":
            return FakeSearchProvider()
        case _:
            return None


@dataclass
class Container:
    settings: Settings
    db: Database | None
    storage: ObjectStorage
    embedder: EmbeddingProvider
    llm_provider: LlmProvider
    llm: LlmRouter
    prompts: PromptLibrary
    retriever: HybridRetriever
    web: WebSearchService
    ingestion: IngestionService
    tutor: TutorService
    quiz: QuizGenerator
    grader: Grader

    @classmethod
    def build(
        cls,
        settings: Settings,
        *,
        db: Database | None = None,
        storage: ObjectStorage | None = None,
        llm_provider: LlmProvider | None = None,
        embedder: EmbeddingProvider | None = None,
        search_provider: SearchProvider | bool | None = True,
        fetcher: SafeFetcher | None = None,
        use_db: bool = True,
    ) -> Container:
        if db is None and use_db:
            db = Database(
                settings.database_url,
                pool_size=settings.db_pool_size,
                max_overflow=settings.db_max_overflow,
                slow_query_ms=settings.db_slow_query_ms,
            )
        if storage is None:
            storage = S3Storage(
                settings.storage_endpoint,
                settings.storage_access_key.get_secret_value(),
                settings.storage_secret_key.get_secret_value(),
                settings.storage_bucket,
                settings.storage_region,
            )
        embedder = embedder or build_embedder(settings)
        llm_provider = llm_provider or build_llm_provider(settings)
        search: SearchProvider | None = (
            build_search_provider(settings)
            if search_provider is True
            else (None if search_provider is False else search_provider)
        )
        prompts = PromptLibrary(settings.prompts_dir, settings.prompt_versions)
        router = LlmRouter(settings, llm_provider, db)
        retriever = HybridRetriever(
            embedding_model=embedder.model,
            vector_k=settings.rag_vector_k,
            keyword_k=settings.rag_keyword_k,
            rrf_k=settings.rag_rrf_k,
            top_k=settings.rag_top_k,
            min_similarity=embedder.relevance_floor,
            ef_search=settings.rag_hnsw_ef_search,
        )
        fetcher = fetcher or SafeFetcher(
            timeout=settings.web_fetch_timeout_seconds,
            max_bytes=settings.web_fetch_max_bytes,
            max_redirects=settings.web_fetch_max_redirects,
            allowed_ports=settings.web_fetch_allowed_ports,
        )
        web = WebSearchService(settings, db, search, fetcher, embedder)
        ingestion = IngestionService(settings, db, storage, embedder) if db is not None else None
        return cls(
            settings=settings,
            db=db,
            storage=storage,
            embedder=embedder,
            llm_provider=llm_provider,
            llm=router,
            prompts=prompts,
            retriever=retriever,
            web=web,
            ingestion=ingestion,  # type: ignore[arg-type]
            tutor=TutorService(settings, db, router, prompts, embedder, retriever, web),
            quiz=QuizGenerator(settings, db, router, prompts, embedder, retriever),
            grader=Grader(settings, router, prompts),
        )

    async def close(self) -> None:
        if self.db is not None:
            await self.db.dispose()
