"""Async SQLAlchemy 2 engine (psycopg 3) with slow-query logging."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.logging import get_logger

log = get_logger(__name__)


class Database:
    def __init__(self, url: str, *, pool_size: int = 10, max_overflow: int = 5, slow_query_ms: int = 500) -> None:
        self.engine: AsyncEngine = create_async_engine(
            url,
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_pre_ping=True,
            pool_recycle=1800,
            connect_args={"application_name": "sathi-ai", "connect_timeout": 5},
        )
        self._sessions = async_sessionmaker(self.engine, expire_on_commit=False, class_=AsyncSession)
        self._slow_ms = slow_query_ms
        self._install_slow_query_logging()

    def _install_slow_query_logging(self) -> None:
        sync_engine = self.engine.sync_engine

        @event.listens_for(sync_engine, "before_cursor_execute")
        def _before(conn: Any, cursor: Any, statement: str, params: Any, context: Any, executemany: bool) -> None:
            conn.info.setdefault("query_start", []).append(time.perf_counter())

        @event.listens_for(sync_engine, "after_cursor_execute")
        def _after(conn: Any, cursor: Any, statement: str, params: Any, context: Any, executemany: bool) -> None:
            starts = conn.info.get("query_start")
            if not starts:
                return
            elapsed_ms = (time.perf_counter() - starts.pop()) * 1000
            if elapsed_ms >= self._slow_ms:
                # statements are parameterised: no user content in the SQL text
                log.warning(
                    "db.slow_query",
                    message="Slow query",
                    duration_ms=round(elapsed_ms, 1),
                    statement=" ".join(statement.split())[:300],
                )

    @asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        async with self._sessions() as session:
            yield session

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[AsyncSession]:
        async with self._sessions() as session, session.begin():
            yield session

    async def ping(self) -> bool:
        async with self.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True

    async def dispose(self) -> None:
        await self.engine.dispose()
