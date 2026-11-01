"""Alembic environment for schema ``ai``.

* URL from ``-x dburl=...`` or ``DATABASE_URL`` (the migrator container passes the ``sathi_ai`` role URL).
* The version table lives in schema ``ai``. The schema is normally created by the Postgres init script
  (owned by ``sathi_ai``); we only create it if missing, so the role does not need CREATE on the DB.
"""

from __future__ import annotations

import os

from alembic import context
from sqlalchemy import create_engine, pool, text

SCHEMA = "ai"
config = context.config


def _url() -> str:
    url = context.get_x_argument(as_dictionary=True).get("dburl") or os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


def run_migrations_offline() -> None:
    context.configure(
        url=_url(),
        literal_binds=True,
        version_table_schema=SCHEMA,
        include_schemas=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        exists = connection.execute(text("SELECT 1 FROM pg_namespace WHERE nspname = :s"), {"s": SCHEMA}).scalar()
        if not exists:
            connection.execute(text(f'CREATE SCHEMA "{SCHEMA}"'))
        connection.commit()
        context.configure(
            connection=connection,
            version_table_schema=SCHEMA,
            include_schemas=True,
            transaction_per_migration=True,
        )
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
