"""FastAPI app factory.

Routers by ``AI_INSTANCE_ROLE``: ``all`` mounts everything; ``ingest`` (the ``ai-ingest`` instance) mounts
ingestion, document deletion and health only, so heavy uploads never slow live chat.

``uvicorn app.main:app`` resolves ``app`` lazily (module ``__getattr__``) so importing this module in
tests does not require production configuration.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

from app.aio import drain_background
from app.config import Settings, get_settings
from app.container import Container
from app.errors import install_error_handlers
from app.logging import configure_logging, get_logger
from app.middleware import RequestContextMiddleware
from app.openapi import API_DESCRIPTION, API_TITLE, API_VERSION, install_openapi, operation_id
from app.routers import mount_routers
from app.telemetry import instrument_app, instrument_engine, setup_telemetry

log = get_logger(__name__)


def create_app(settings: Settings | None = None, container: Container | None = None) -> FastAPI:
    settings = settings or (container.settings if container else get_settings())
    configure_logging(
        service=settings.service_name, env=settings.sathi_env, version=settings.sathi_version, level=settings.log_level
    )
    setup_telemetry(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        owned = app.state.container is None
        if owned:
            app.state.container = Container.build(settings)
        c: Container = app.state.container
        c.prompts.validate()  # fail fast on missing prompt files
        if c.db is not None:
            instrument_engine(c.db.engine)
        warm = getattr(c.embedder, "warm_up", None)
        if warm is not None:
            await warm()
        if settings.is_production and c.llm_provider.name == "fake":
            log.warning("startup.fake_llm", message="Production is running with the FakeProvider")
        log.info(
            "startup.ready",
            message="AI service started",
            role=settings.ai_instance_role,
            llm_provider=c.llm_provider.name,
            llm_model=settings.llm_model,
            embedding_model=c.embedder.model,
            search_provider=settings.search_provider,
            kill_switch=settings.ai_kill_switch,
        )
        try:
            yield
        finally:
            await drain_background()  # let cancellation ledger writes finish
            if owned:
                await c.close()
            log.info("shutdown.complete", message="AI service stopped")

    app = FastAPI(
        title=API_TITLE,
        version=API_VERSION,
        description=API_DESCRIPTION,
        lifespan=lifespan,
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/openapi.json",
        generate_unique_id_function=operation_id,
    )
    app.state.container = container
    app.state.settings = settings
    install_error_handlers(app)
    app.add_middleware(RequestContextMiddleware)
    mount_routers(app, settings.ai_instance_role)
    install_openapi(app)
    instrument_app(app)
    return app


_app: FastAPI | None = None


def __getattr__(name: str) -> Any:
    global _app
    if name == "app":
        if _app is None:
            _app = create_app()
        return _app
    raise AttributeError(name)
