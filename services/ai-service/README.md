# Sathi AI service

FastAPI service for the live tutor (hybrid RAG + optional web search, streamed over SSE), document
ingestion, question generation, rubric grading, stateless mastery/recommendations, the AI run ledger and
the golden-dataset evaluation runner. It is private: only `api` and `jobs` call it, with a short-lived
RS256 service token. The source of truth for every endpoint, table, header and log field is
[`docs/architecture/contracts.md`](../../docs/architecture/contracts.md).

## Layout

| Path | What |
| --- | --- |
| `app/main.py` | App factory. `AI_INSTANCE_ROLE=all` mounts everything; `ingest` mounts ingestion, document deletion and health only (the `ai-ingest` container). |
| `app/config.py` | Validated settings (fail fast). `LLM_PROVIDER` defaults to `fake` when `ANTHROPIC_API_KEY` is empty. |
| `app/security.py` | Service-token verification: RS256 only, key chosen by `kid`; `iss` ∈ {sathi-api, sathi-jobs}, `aud=ai-service`, `exp`, scopes, `rscope`. |
| `app/openapi.py`, `app/export_openapi.py` | OpenAPI post-processing (ProblemDetails, bearer scheme, scopes, SSE payloads) and `python -m app.export_openapi`. |
| `app/aio.py` | Cancellation helpers (`shielded` ledger writes, explicit async-generator close). |
| `app/logging.py`, `app/middleware.py`, `app/telemetry.py` | structlog JSON (contracts §8) with redaction and runtime level switch; request context; OpenTelemetry (OTLP only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set). |
| `app/llm/` | `LlmProvider` protocol, Anthropic provider (official SDK, `AsyncAnthropic`), deterministic `FakeProvider`, record/replay wrapper, `LlmRouter` (kill switch, daily spend cap, fallback model, `llm.call` log line, `ai.model_runs`). |
| `app/embeddings/` | fastembed `BAAI/bge-small-en-v1.5` (384-d, baked into the image) and a deterministic hashed bag-of-words fake. |
| `app/rag/` | Structure-aware chunker, hybrid retrieval (pgvector HNSW + Postgres FTS, RRF k=60, scope filter inside SQL), citation check. |
| `app/search/` | Tavily/Brave/fake providers, SSRF-safe fetcher, HTML extraction, web-search service (24 h cache, spend cap, passage selection). |
| `app/ingestion/` | PDF/DOCX/MD/TXT parsers and the idempotent parse → index pipeline. |
| `app/tutor/` | Tutor pipeline, prompt assembly (sources as quoted data), output guard. |
| `app/quiz/`, `app/grading/`, `app/mastery/` | Question generation, rubric grading, mastery update (contracts §7) and recommendations. |
| `app/evaluation/` | `python -m app.evaluation.runner --dataset all` (also `POST /internal/v1/eval/run`). |
| `migrations/` | Alembic for schema `ai` (version table in `ai`). |
| `../../prompts/<name>/v<N>.md` | Versioned prompts; every run records name, version and `sha256:` hash. |

## Run locally

```bash
cd services/ai-service
python -m uv sync                       # creates .venv from uv.lock
export DATABASE_URL=postgresql+psycopg://sathi_ai:<pw>@localhost:5432/sathi
# public half of the key pair api/jobs sign with (scripts/generate-secrets.* writes both into .env)
export SERVICE_TOKEN_PUBLIC_KEYS="k1:$SERVICE_TOKEN_PUBLIC_KEY_PEM_B64"
export LOG_HASH_SALT=dev-salt STORAGE_ENDPOINT=http://localhost:9000 STORAGE_ACCESS_KEY=<ai user> STORAGE_SECRET_KEY=<ai secret>
export PROMPTS_DIR=../../prompts EVAL_DATASETS_DIR=../../tests/ai-evaluation/datasets
.venv/bin/alembic upgrade head          # or .venv\Scripts\alembic on Windows
.venv/bin/python -m app                 # http://127.0.0.1:8000 (selector event loop on Windows)
# or: .venv/bin/uvicorn app.main:app --port 8000
```

Without `ANTHROPIC_API_KEY` the deterministic FakeProvider answers from the retrieved passages. Set
`EMBEDDING_PROVIDER=fake` to skip the fastembed model download on a dev machine, and
`SEARCH_PROVIDER=none|fake|tavily|brave` (default `fake` in development/test, `none` elsewhere without keys).

Key optional settings: `LLM_MODEL` (`claude-opus-5-5`), `LLM_FALLBACK_MODEL` (`claude-sonnet-5-5`),
`LLM_SERVER_FALLBACKS` (`true`: server-side refusal fallbacks with `fallbacks="default"`),
`LLM_DAILY_SPEND_CAP_USD`, `AI_KILL_SWITCH`, `LLM_TUTOR_EFFORT` (`low`), `LLM_STRUCTURED_EFFORT`
(`medium`), `LLM_PRICING` (JSON, USD per 1M tokens), `LLM_RECORD_MODE=off|record|replay`,
`WEB_SEARCH_DAILY_SPEND_CAP_USD`, `WEB_SEARCH_COST_PER_QUERY_USD`, `RAG_MIN_VECTOR_SIMILARITY`,
`INGEST_CONCURRENCY`, `PROMPT_VERSIONS` (JSON pins, e.g. `{"tutor_system": 1}`).

## Test, lint, type-check

```bash
python -m uv run ruff check app migrations tests
python -m uv run mypy app
# DB tests need a throwaway Postgres + pgvector; without TEST_DATABASE_URL they are skipped.
docker run -d --rm --name ai-test-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=sathi -p 55433:5432 pgvector/pgvector:0.8.0-pg17
TEST_DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:55433/sathi python -m uv run pytest
```

The DB fixture drops and re-creates schema `ai` via Alembic once per session (so it also tests the
migration) and truncates the tables after each test.

## Docker

```bash
docker build -f services/ai-service/Dockerfile -t sathi-ai:dev .     # from the repository root
docker run --rm sathi-ai:dev alembic upgrade head                     # migrator-ai
```

The image runs as a non-root user, contains the baked embedding model (`/app/models`), prompts
(`/app/prompts`) and golden datasets (`/app/eval-datasets`), and its health check calls `/health/live`.

## Behaviour notes

* **Scope isolation.** Retrieval uses only the token's `rscope` in the SQL `WHERE` clause of both the
  vector and the keyword query, before ranking. Request bodies never widen it.
* **Untrusted sources.** Course, upload and web passages are wrapped in labelled `<source>` blocks with
  structural tags neutralised and instruction-like passages flagged; the system prompt says sources are
  data. The final answer passes an output guard that removes remote images and links that do not point
  at a supplied source.
* **Failures.** LLM failures end the SSE stream with `error {code, message, referenceId}`; retrieval and
  web-search failures degrade with `warnings` (`RAG_NO_RESULTS`, `WEB_SEARCH_FAILED`). Each failure is
  logged once, at the boundary.
* **Cancellation** (contracts §11.5). When .NET closes the SSE connection, Starlette's disconnect
  listener cancels the response, and `sse_stream` also polls `request.is_disconnected()` every 0.5 s between
  events. The cancel goes through the pipeline. In-flight web fetches are cancelled, and the search is
  recorded as `search_runs.outcome='skipped'`. The Anthropic stream context is exited, which closes the
  upstream HTTP request. The call is written to `model_runs` with `finish_reason='cancelled'`, using the input
  tokens from `message_start` and the output tokens so far (estimated as about 4 characters per token when the
  provider has not reported them). The retrieval/source rows already produced are written. One
  `tutor.cancelled` line is logged at info level, with `stage` and `streamed_chars`. Nothing is logged as an
  error. No `done` or `error` event is sent, because nobody is listening.

## Service tokens (contracts §11.7)

`api`/`jobs` sign with an RSA private key. This service only verifies, and it never holds a signing key.

* `SERVICE_TOKEN_PUBLIC_KEYS` (required) is a comma-separated list of `kid:base64(SPKI PEM)` entries, e.g.
  `k1:LS0tLS1CRUdJTi…,k0:LS0tLS1CRUdJTi…`. The value after `kid:` is the base64 of the whole
  `-----BEGIN PUBLIC KEY-----` PEM text, which is the same value as `.env`'s `SERVICE_TOKEN_PUBLIC_KEY_PEM_B64`.
  A single entry may omit `kid:`, and that key then verifies tokens whatever their `kid`.
* Startup fails fast in these cases: empty value, invalid base64/PEM, a key that is not RSA, an RSA key shorter
  than 2048 bits, a duplicate or malformed `kid` (`[A-Za-z0-9._-]{1,64}`), or a kid-less entry mixed with others.
* The token header must be `alg=RS256`. `HS256` is rejected before any key is touched, including an HMAC
  signed with the public PEM (algorithm confusion), and so are `none` and every other algorithm. The key is
  selected by the `kid` header, and an unknown `kid` is rejected. A token without `kid` is accepted only when
  exactly one key is configured.
* Rotation works like this. First add the new public key next to the old one (`k2:…,k1:…`). Then switch .NET
  to the new private key and `kid`. Remove the old entry after 5 minutes, which is the token lifetime.
* `SERVICE_TOKEN_SECRET` is no longer read (HS256 is gone).

## Object storage permissions (contracts §11.8)

`STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` must be the scoped AI user (compose maps
`STORAGE_AI_ACCESS_KEY` / `STORAGE_AI_SECRET_KEY` onto them), never the MinIO root account. Required policy on
bucket `sathi-documents`:

| Action | Resource | Used for |
| --- | --- | --- |
| `s3:GetObject` | `uploads/*`, `lessons/*` | reading files to parse |
| `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` | `parsed/*` | parsed text, deletion |
| `s3:ListBucket` | bucket (prefix `parsed/` is enough) | prefix deletion, readiness check |

The service never creates buckets and never calls `ListAllMyBuckets` or `HeadBucket`. The code refuses to
write or delete outside `parsed/`. `/health/ready` checks storage with
`list_objects_v2(Prefix='parsed/', MaxKeys=1)`. A storage failure makes `ai-ingest` unready (503). The `all`
instance only reports `checks.storage = "failed"`, so live chat keeps working.

## OpenAPI (contracts §11.9)

```bash
python -m uv run python -m app.export_openapi          # writes ../../contracts/openapi/ai-internal.v1.json
python -m uv run python -m app.export_openapi -        # print to stdout
```

The export needs no environment or database. Its output is deterministic: sorted keys, a 2-space indent and a
trailing newline. `tests/test_openapi.py` fails when the committed file is stale. The document has these parts:

* a summary for every operation
* `x-required-scope`
* the `serviceToken` bearer scheme
* `application/problem+json` `ProblemDetails` for every error status
* typed run detail (`InternalRunDetail`)
* the tutor SSE payload schemas under `x-sse-events` on `POST /internal/v1/tutor/stream`

When the service runs outside production, it serves the same document at `/openapi.json`.
