#!/usr/bin/env bash
# Sathi database bootstrap (contracts.md §3).
#
# Runs once, as the postgres superuser, when the data volume is empty
# (docker-entrypoint-initdb.d). It is also safe to re-run by hand against an
# existing or managed server, e.g.:
#   docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres #     bash /docker-entrypoint-initdb.d/01-init.sh
#
# Creates:
#   - extensions vector, pg_trgm, pgcrypto in schema `extensions` (superuser-owned,
#     USAGE granted to every Sathi role)
#   - roles sathi_app, sathi_ai, sathi_hangfire (LOGIN, passwords from env)
#   - schemas app / ai / hangfire, each owned by its role
#   - each role: USAGE only on its own schema (+ extensions), search_path set
#   - no CREATE on public for anyone
set -Eeuo pipefail

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"
: "${AI_DB_PASSWORD:?AI_DB_PASSWORD must be set}"
: "${HANGFIRE_DB_PASSWORD:?HANGFIRE_DB_PASSWORD must be set}"

DB_NAME="${POSTGRES_DB:-sathi}"
SUPERUSER="${POSTGRES_USER:-postgres}"

echo "sathi-init: bootstrapping database '${DB_NAME}'"

psql -v ON_ERROR_STOP=1 \
     --username "${SUPERUSER}" \
     --dbname "${DB_NAME}" \
     --no-psqlrc \
     -v db_name="${DB_NAME}" \
     -v app_pw="${APP_DB_PASSWORD}" \
     -v ai_pw="${AI_DB_PASSWORD}" \
     -v hf_pw="${HANGFIRE_DB_PASSWORD}" <<'SQL'
\set QUIET on

-- Never let statement logging (log_min_duration_statement / log_statement) capture the
-- role passwords below — on a slow machine ALTER ROLE ... PASSWORD would be logged verbatim.
SET log_min_duration_statement = -1;
SET log_statement = 'none';

-- ---------------------------------------------------------------------------
-- Roles (idempotent). Passwords are passed as psql variables, never inlined.
-- ---------------------------------------------------------------------------
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION', r)
FROM unnest(ARRAY['sathi_app', 'sathi_ai', 'sathi_hangfire']) AS r
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
\gexec

ALTER ROLE sathi_app      WITH LOGIN PASSWORD :'app_pw';
ALTER ROLE sathi_ai       WITH LOGIN PASSWORD :'ai_pw';
ALTER ROLE sathi_hangfire WITH LOGIN PASSWORD :'hf_pw';

-- Bound runaway work per role (tunable later per environment).
ALTER ROLE sathi_app      SET statement_timeout = '30s';
ALTER ROLE sathi_ai       SET statement_timeout = '120s';
ALTER ROLE sathi_hangfire SET statement_timeout = '60s';
ALTER ROLE sathi_app      SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE sathi_ai       SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE sathi_hangfire SET idle_in_transaction_session_timeout = '60s';

-- ---------------------------------------------------------------------------
-- Database-level privileges: only the Sathi roles may connect.
-- ---------------------------------------------------------------------------
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db_name" TO sathi_app, sathi_ai, sathi_hangfire;

-- Nobody but the superuser may create objects in public.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Extensions live in their own superuser-owned schema; every role may use them.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION CURRENT_USER;
REVOKE ALL ON SCHEMA extensions FROM PUBLIC;
GRANT USAGE ON SCHEMA extensions TO sathi_app, sathi_ai, sathi_hangfire;

CREATE EXTENSION IF NOT EXISTS vector   WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO sathi_app, sathi_ai, sathi_hangfire;

-- ---------------------------------------------------------------------------
-- Schemas: one per owner, USAGE only for the owner.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app      AUTHORIZATION sathi_app;
CREATE SCHEMA IF NOT EXISTS ai       AUTHORIZATION sathi_ai;
CREATE SCHEMA IF NOT EXISTS hangfire AUTHORIZATION sathi_hangfire;

ALTER SCHEMA app      OWNER TO sathi_app;
ALTER SCHEMA ai       OWNER TO sathi_ai;
ALTER SCHEMA hangfire OWNER TO sathi_hangfire;

REVOKE ALL ON SCHEMA app, ai, hangfire FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA app      TO sathi_app;
GRANT USAGE, CREATE ON SCHEMA ai       TO sathi_ai;
GRANT USAGE, CREATE ON SCHEMA hangfire TO sathi_hangfire;

-- Hangfire.PostgreSql runs "CREATE SCHEMA IF NOT EXISTS hangfire" on start-up
-- (PrepareSchemaIfNecessary); PostgreSQL checks database CREATE privilege before
-- the IF NOT EXISTS short-circuit, so the Hangfire role needs it. It cannot
-- touch app/ai because it has no USAGE there.
GRANT CREATE ON DATABASE :"db_name" TO sathi_hangfire;

-- ---------------------------------------------------------------------------
-- Default search paths (unqualified names resolve to the role's own schema).
-- ---------------------------------------------------------------------------
ALTER ROLE sathi_app      IN DATABASE :"db_name" SET search_path = app, extensions;
ALTER ROLE sathi_ai       IN DATABASE :"db_name" SET search_path = ai, extensions;
ALTER ROLE sathi_hangfire IN DATABASE :"db_name" SET search_path = hangfire, extensions;

-- Superuser sessions (backups, ad-hoc admin) see everything.
ALTER DATABASE :"db_name" SET search_path = "$user", public, extensions;

\set QUIET off
SELECT 'sathi-init: roles ' || string_agg(rolname, ', ' ORDER BY rolname) AS result
FROM pg_roles WHERE rolname LIKE 'sathi_%';
SQL

echo "sathi-init: done"
