"""Shared fixtures.

DB tests need a real Postgres + pgvector. Point ``TEST_DATABASE_URL`` at a throwaway database, e.g.

    docker run -d --name ai-agent-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=sathi \
        -p 55433:5432 pgvector/pgvector:0.8.0-pg17
    TEST_DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:55433/sathi pytest

Without it, tests marked ``db`` are skipped. The schema ``ai`` is dropped and re-created with Alembic once
per session; tables are truncated after each DB test.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

if sys.platform == "win32":  # psycopg async needs a selector loop on Windows
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from app.config import Settings
from app.container import Container
from app.db import Database
from app.embeddings.fake_provider import FakeEmbeddingProvider
from app.llm.fake_provider import FakeProvider
from app.main import create_app
from app.search.fake import FakeSearchProvider
from app.storage import MemoryStorage

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def generate_rsa_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def public_pem(key: rsa.RSAPrivateKey) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)


def public_key_entry(key: rsa.RSAPrivateKey, kid: str | None = "k1") -> str:
    """One ``SERVICE_TOKEN_PUBLIC_KEYS`` entry: ``kid:base64(SPKI PEM)`` (or just the base64 without a kid)."""
    b64 = base64.b64encode(public_pem(key)).decode()
    return f"{kid}:{b64}" if kid else b64


# Generated once per test session; .NET signs with the private key (contracts §11.7).
SIGNING_KEY = generate_rsa_key()
KEY_ID = "k1"
PUBLIC_KEYS = public_key_entry(SIGNING_KEY, KEY_ID)
SALT = "test-salt"
USER_A = uuid.UUID("00000000-0000-0000-0000-00000000000a")
USER_B = uuid.UUID("00000000-0000-0000-0000-00000000000b")
COURSE_X = uuid.UUID("00000000-0000-0000-0000-0000000000c1")
COURSE_Y = uuid.UUID("00000000-0000-0000-0000-0000000000c2")
TEST_DB_URL = os.environ.get("TEST_DATABASE_URL", "")

AI_TABLES = (
    "document_chunks, chunk_embeddings, retrieval_runs, retrieved_sources, search_runs, search_cache, "
    "model_configurations, model_runs, tool_invocations, agent_runs, debug_captures, debug_capture_settings, "
    "evaluation_results, evaluation_runs, evaluation_cases, evaluation_datasets"
)


@pytest.fixture(scope="session")
def event_loop_policy() -> asyncio.AbstractEventLoopPolicy:
    if sys.platform == "win32":
        return asyncio.WindowsSelectorEventLoopPolicy()
    return asyncio.DefaultEventLoopPolicy()


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "sathi_env": "test",
        "database_url": TEST_DB_URL or "postgresql+psycopg://u:p@localhost:1/none",
        "service_token_public_keys": PUBLIC_KEYS,
        "log_hash_salt": SALT,
        "storage_endpoint": "http://localhost:9",
        "storage_access_key": "test",
        "storage_secret_key": "test",
        "anthropic_api_key": "",
        "llm_provider": "fake",
        "embedding_provider": "fake",
        "search_provider": "fake",
        "prompts_dir": REPO_ROOT / "prompts",
        "eval_datasets_dir": FIXTURES / "datasets",
        "otel_exporter_otlp_endpoint": "",
        "log_level": "DEBUG",
    }
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def settings() -> Settings:
    return make_settings()


def make_token(
    *,
    scopes: str = "tutor",
    sub: str | uuid.UUID = USER_A,
    course_ids: list[uuid.UUID] | None = None,
    rscope_user: uuid.UUID | str | None = "sub",
    iss: str = "sathi-api",
    aud: str = "ai-service",
    exp_in: int = 300,
    key: Any = None,
    kid: str | None = KEY_ID,
    algorithm: str = "RS256",
    extra: dict[str, Any] | None = None,
) -> str:
    now = int(time.time())
    user = (str(sub) if str(sub) != "system" else None) if rscope_user == "sub" else rscope_user
    claims: dict[str, Any] = {
        "iss": iss,
        "aud": aud,
        "sub": str(sub),
        "uh": "679ae057de8932a8",
        "scp": scopes,
        "rscope": {"course_ids": [str(c) for c in (course_ids or [])], "user_id": str(user) if user else None},
        "rid": "req-test",
        "iat": now,
        "exp": now + exp_in,
    }
    claims.update(extra or {})
    headers = {"kid": kid} if kid else None
    return jwt.encode(claims, key if key is not None else SIGNING_KEY, algorithm=algorithm, headers=headers)


def auth(**kwargs: Any) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(**kwargs)}", "X-Request-Id": "req-123"}


def parse_sse(body: str) -> list[tuple[str, dict[str, Any]]]:
    events = []
    for block in body.split("\n\n"):
        if not block.strip() or block.startswith(":"):
            continue
        name, data = "", ""
        for line in block.split("\n"):
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                data = line[6:]
        events.append((name, json.loads(data)))
    return events


# ---------------------------------------------------------------- database
@pytest.fixture(scope="session")
def migrated_db_url() -> str:
    if not TEST_DB_URL:
        pytest.skip("TEST_DATABASE_URL not set")
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, text

    engine = create_engine(TEST_DB_URL)
    with engine.begin() as conn:
        # mirror infrastructure/docker/postgres/init: extensions live in schema `extensions` on the search_path
        conn.execute(text("CREATE SCHEMA IF NOT EXISTS extensions"))
        if not conn.execute(text("SELECT 1 FROM pg_extension WHERE extname = 'vector'")).scalar():
            conn.execute(text("CREATE EXTENSION vector SCHEMA extensions"))
        conn.execute(text('ALTER ROLE CURRENT_USER SET search_path TO "$user", public, extensions'))
        conn.execute(text("DROP SCHEMA IF EXISTS ai CASCADE"))
    engine.dispose()
    cfg = Config(str(SERVICE_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVICE_ROOT / "migrations"))
    os.environ["DATABASE_URL"] = TEST_DB_URL
    command.upgrade(cfg, "head")
    return TEST_DB_URL


@pytest.fixture
async def db(migrated_db_url: str) -> AsyncIterator[Database]:
    from sqlalchemy import text

    database = Database(migrated_db_url, pool_size=5, max_overflow=2)
    try:
        yield database
    finally:
        async with database.transaction() as s:
            await s.execute(text(f"TRUNCATE {', '.join('ai.' + t.strip() for t in AI_TABLES.split(','))} CASCADE"))
        await database.dispose()


def build_container(settings: Settings, db: Database | None, **kwargs: Any) -> Container:
    return Container.build(
        settings,
        db=db,
        storage=kwargs.pop("storage", MemoryStorage()),
        llm_provider=kwargs.pop("llm_provider", FakeProvider()),
        embedder=kwargs.pop("embedder", FakeEmbeddingProvider()),
        search_provider=kwargs.pop("search_provider", FakeSearchProvider()),
        use_db=db is not None,
        **kwargs,
    )


@pytest.fixture
def container(settings: Settings, db: Database) -> Container:
    return build_container(settings, db)


@pytest.fixture
def nodb_container(settings: Settings) -> Container:
    return build_container(settings, None)


async def _client(container: Container) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(container.settings, container)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://ai-service") as client:
        yield client


@pytest.fixture
async def client(container: Container) -> AsyncIterator[httpx.AsyncClient]:
    async for c in _client(container):
        yield c


@pytest.fixture
async def nodb_client(nodb_container: Container) -> AsyncIterator[httpx.AsyncClient]:
    async for c in _client(nodb_container):
        yield c


async def index_text(
    container: Container,
    text: str,
    *,
    title: str,
    scope: str = "course",
    course_id: uuid.UUID | None = COURSE_X,
    owner: uuid.UUID | None = None,
    document_id: uuid.UUID | None = None,
    version: int = 1,
) -> uuid.UUID:
    from app.rag.chunking import PageText

    doc = document_id or uuid.uuid4()
    assert container.ingestion is not None
    await container.ingestion.index_pages(
        pages=[PageText(None, text)],
        document_id=doc,
        version=version,
        scope=scope,
        source_type="course" if scope == "course" else "upload",
        title=title,
        owner_user_id=owner,
        course_id=course_id if scope == "course" else None,
    )
    return doc
