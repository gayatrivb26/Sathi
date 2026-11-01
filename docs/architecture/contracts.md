# Sathi — System Contracts (source of truth)

This document is the single contract every part of Sathi is built against: service names, ports, configuration keys, database schema, public and internal APIs, SSE events, error codes and the log schema. **If code and this document disagree, fix one of them in the same change.**

Product name in UI and code: **Sathi**. C# root namespace `Sathi`. Python package `app`.

---

## 1. Services, ports, networks

| Service (compose name) | Tech | Port (container) | Networks | Notes |
| --- | --- | --- | --- | --- |
| `web` | Nginx serving the Angular build **and** reverse proxy | 8080 | public, app | Only public service. Host port 8080 → http://localhost:8080 |
| `api` | ASP.NET Core, .NET 10 (`Sathi.Api`) | 8080 | app, internal, observability | Public backend, reached only via `web` under `/api/` |
| `jobs` | .NET 10 Hangfire host (`Sathi.Jobs`) | 8080 | app, internal, observability | Hangfire dashboard at `/hangfire` (Admin role only), proxied by `web` |
| `ai-service` | FastAPI (Python 3.12) | 8000 | internal, observability | Live tutor, quiz generation, grading, mastery, runs |
| `ai-ingest` | same image as `ai-service` | 8000 | internal, observability | Second instance for heavy ingestion (`AI_INSTANCE_ROLE=ingest`, `INGEST_CONCURRENCY=2`) |
| `postgres` | `pgvector/pgvector:pg17` | 5432 | internal | DB `sathi`; schemas `app`, `ai`, `hangfire` |
| `minio` | MinIO | 9000 (S3), 9001 (console, dev only) | internal | Bucket `sathi-documents` |
| `mailpit` | Mailpit | 1025 (SMTP), 8025 (UI, dev only) | internal | Dev email sink; production uses real SMTP |
| `migrator-app` | `Sathi.Migrator` (.NET) | — | internal | One-shot: EF Core migrations for `app` + seed |
| `migrator-ai` | ai-service image, `alembic upgrade head` | — | internal | One-shot: Alembic migrations for `ai` |
| `otel-collector`, `loki`, `tempo`, `prometheus`, `grafana` | observability profile | 4317/4318, 3100, 3200, 9090, 3000 | observability | `docker compose --profile observability up` |

`web` routes: `/api/` → `api:8080`, `/hangfire` → `jobs:8080`, everything else → Angular `index.html` (SPA fallback). SSE location `/api/v1/conversations/` must have `proxy_buffering off; proxy_read_timeout 300s;`.

Local dev without containers for app code: `ng serve` (port 4200, `proxy.conf.json` proxies `/api` and `/hangfire` to `http://localhost:5080`), API on `http://localhost:5080`, Jobs on `http://localhost:5090`, AI service on `http://localhost:8000`; Postgres/MinIO/Mailpit from compose with host ports 5432/9000/1025/8025.

---

## 2. Configuration keys

One validated settings class per service; startup fails fast on missing/invalid required values. All secrets come from environment (`.env` locally, a secret store in production). Never commit `.env`.

### Shared (.env)

| Variable | Example | Used by |
| --- | --- | --- |
| `SATHI_ENV` | `development` \| `test` \| `staging` \| `production` | all |
| `SATHI_VERSION` | `0.1.0` | all (log field `version`) |
| `POSTGRES_PASSWORD` | — | postgres superuser (init only) |
| `APP_DB_PASSWORD` | — | role `sathi_app` |
| `AI_DB_PASSWORD` | — | role `sathi_ai` |
| `HANGFIRE_DB_PASSWORD` | — | role `sathi_hangfire` |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | — | minio, api, jobs, ai |
| `SERVICE_TOKEN_SECRET` | ≥ 32 random bytes, base64 | api, jobs (sign), ai (verify) |
| `LOG_HASH_SALT` | random string | all — `user_id_hash` |
| `APP_BASE_URL` | `http://localhost:8080` | api (email links), jobs |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-collector:4317` (empty = disabled) | all |
| `ANTHROPIC_API_KEY` | — | ai |
| `LLM_PROVIDER` | `anthropic` \| `fake` (default `fake` when no key) | ai |
| `LLM_MODEL` | `claude-opus-5-5` | ai |
| `LLM_FALLBACK_MODEL` | `claude-sonnet-5-5` | ai |
| `LLM_DAILY_SPEND_CAP_USD` | `5` | ai |
| `AI_KILL_SWITCH` | `false` | ai (true → every LLM call fails with `LLM_DISABLED`) |
| `EMBEDDING_PROVIDER` | `fastembed` \| `fake` | ai |
| `EMBEDDING_MODEL` | `BAAI/bge-small-en-v1.5` (dim 384) | ai |
| `SEARCH_PROVIDER` | `tavily` \| `brave` \| `fake` \| `none` | ai |
| `TAVILY_API_KEY`, `BRAVE_API_KEY` | — | ai |
| `WEB_SEARCH_DAILY_SPEND_CAP_USD` | `1` | ai |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | `mailpit`, `1025` | api, jobs |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | — | migrator |
| `SEED_DEMO_USERS` | `true` in dev | migrator (creates demo student + instructor) |

### .NET (ASP.NET configuration, `__` = section separator)

`ConnectionStrings__App` (role `sathi_app`), `ConnectionStrings__Hangfire` (role `sathi_hangfire`, jobs only), `Ai__BaseUrl=http://ai-service:8000`, `Ai__IngestBaseUrl=http://ai-ingest:8000`, `Ai__TimeoutSeconds=120`, `ServiceToken__Secret`, `Storage__Endpoint=http://minio:9000`, `Storage__AccessKey`, `Storage__SecretKey`, `Storage__Bucket=sathi-documents`, `Storage__UseSsl=false`, `Email__Host`, `Email__Port`, `Email__From`, `Email__User`, `Email__Password`, `App__BaseUrl`, `Logging__HashSalt`, `Quotas__ChatMessagesPerDay=200`, `Quotas__WebSearchesPerDay=20`, `Quotas__UploadsPerDay=20`, `Quotas__MaxUploadBytes=26214400`, `Quotas__MaxStorageBytesPerUser=209715200`, `Grading__AutoAcceptConfidence=0.75`, `Observability__SlowQueryMs=500`, `Observability__GrafanaUrl=http://localhost:3000`.

Compose maps the shared variables onto these keys.

### Python (pydantic-settings, env names upper-case)

`DATABASE_URL=postgresql+psycopg://sathi_ai:<pw>@postgres:5432/sathi`, `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `SERVICE_TOKEN_SECRET`, `LOG_HASH_SALT`, `LOG_LEVEL=INFO`, `AI_INSTANCE_ROLE=all|ingest`, `INGEST_CONCURRENCY=2`, `PROMPTS_DIR=/app/prompts`, plus the `LLM_*`, `EMBEDDING_*`, `SEARCH_*`, `AI_KILL_SWITCH`, `OTEL_*` variables above. `LOG_LEVEL` can be changed at runtime through `PUT /internal/v1/admin/log-level` (admin scope).

---

## 3. Database

One Postgres database `sathi`, created by `infrastructure/docker/postgres/init/01-init.sh`:

- Extensions: `vector`, `pg_trgm`, `pgcrypto`.
- Roles: `sathi_app` (owns schema `app`), `sathi_ai` (owns schema `ai`), `sathi_hangfire` (owns schema `hangfire`).
- Each role has `USAGE` only on its own schema; no cross-schema foreign keys; IDs crossing schemas are opaque UUIDs.
- Read-only view grants are added later only when a cross-schema read is justified (none at present).

Conventions: tables `snake_case` plural, columns `snake_case`, PK `id uuid` (generated in app code, UUID v7 in .NET via `Guid.CreateVersion7()`, `uuid7`/`uuid4` in Python), timestamps `timestamptz` in UTC named `*_at`. EF Core uses `UseSnakeCaseNamingConvention()` (EFCore.NamingConventions) and `HasDefaultSchema("app")`. Enums stored as lowercase `text` with check constraints in docs (not DB enums, to keep migrations simple).

### 3.1 Schema `app` (owner: .NET, EF Core migrations in `Sathi.Core`)

Identity tables (ASP.NET Core Identity, `Guid` keys) live in `app` with snake_case names: `users`, `roles`, `user_roles`, `user_claims`, `user_logins`, `user_tokens`, `role_claims`. `users` adds: `display_name text not null`, `created_at`, `last_active_at`, `deleted_at null`.

Roles: `Student`, `Instructor`, `Admin`.

| Table | Columns (type) | Keys / indexes / notes |
| --- | --- | --- |
| `user_preferences` | `user_id uuid PK FK users`, `level text` (`beginner`/`intermediate`/`advanced`), `timezone text` (IANA, default `Asia/Kolkata`), `reminder_hour int` (0–23, default 18), `reminders_enabled bool`, `active_course_id uuid null`, `onboarding_completed_at timestamptz null` | |
| `courses` | `id`, `slug text unique`, `title`, `description`, `domain text`, `is_published bool`, `created_by uuid null`, `created_at`, `updated_at` | |
| `enrollments` | `id`, `user_id`, `course_id`, `enrolled_at`, `diagnostic_completed_at null`, `current_lesson_id null` | unique (`user_id`,`course_id`) |
| `course_modules` | `id`, `course_id`, `title`, `summary`, `position int` | index (`course_id`,`position`) |
| `lessons` | `id`, `module_id`, `title`, `summary`, `content_markdown text`, `estimated_minutes int`, `position int`, `version int`, `document_id uuid null` (the indexed copy, see `documents`), `updated_at` | |
| `concepts` | `id`, `course_id`, `slug`, `name`, `description` | unique (`course_id`,`slug`) |
| `lesson_concepts` | `lesson_id`, `concept_id` | PK both |
| `learning_objectives` | `id`, `lesson_id`, `text`, `position` | |
| `concept_prerequisites` | `concept_id`, `prerequisite_concept_id` | PK both |
| `lesson_progress` | `id`, `user_id`, `lesson_id`, `status text` (`not_started`/`in_progress`/`completed`), `percent int`, `last_viewed_at`, `completed_at null` | unique (`user_id`,`lesson_id`) |
| `conversations` | `id`, `user_id`, `course_id`, `lesson_id null`, `title`, `created_at`, `updated_at`, `deleted_at null` | index (`user_id`,`updated_at desc`) |
| `messages` | `id`, `conversation_id`, `role text` (`user`/`assistant`), `content text`, `level text`, `mode text` (`explain`/`hint`/`quiz_me`), `adjust text null` (`simpler`/`harder`), `web_search bool`, `citations jsonb` (array of Citation, §5.3), `answer_basis text[]` (`course`/`upload`/`web`/`general`), `status text` (`streaming`/`complete`/`partial`/`failed`), `error_code null`, `run_id uuid null`, `idempotency_key text null`, `created_at`, `completed_at null` | index (`conversation_id`,`created_at`); unique (`conversation_id`,`idempotency_key`) where not null |
| `message_feedback` | `id`, `message_id`, `user_id`, `rating smallint` (+1/-1), `comment text null`, `created_at` | unique (`message_id`,`user_id`) |
| `documents` | `id`, `scope text` (`user`/`course`), `owner_user_id uuid null`, `course_id uuid null`, `lesson_id uuid null`, `source_type text` (`upload`/`course`), `file_name`, `content_type`, `size_bytes bigint`, `sha256 text`, `current_version int`, `status text` (`queued`/`processing`/`ready`/`failed`), `created_at`, `updated_at`, `deleted_at null` | index (`owner_user_id`,`created_at desc`) |
| `document_versions` | `id`, `document_id`, `version int`, `storage_key text`, `sha256`, `size_bytes`, `created_at` | unique (`document_id`,`version`) |
| `ingestion_jobs` | `id`, `document_id`, `document_version int`, `status text` (`queued`/`parsing`/`indexing`/`ready`/`failed`), `stage text`, `progress_percent int`, `passage_count int null`, `error_code null`, `error_message null`, `reference_id text null`, `trace_id text`, `hangfire_job_id text null`, `attempt int`, `created_at`, `updated_at`, `completed_at null` | unique (`document_id`,`document_version`) — idempotency key |
| `ai_runs` | `id uuid` (= run_id), `trace_id text`, `reference_id text` (8 chars), `user_id_hash text`, `user_id uuid null`, `type text` (`chat`/`ingestion`/`quiz_generation`/`grading`/`revision_plan`/`evaluation`), `status text` (`running`/`succeeded`/`failed`/`cancelled`), `started_at`, `finished_at null`, `hangfire_job_id null`, `model null`, `provider null`, `prompt_hash null`, `input_tokens int null`, `output_tokens int null`, `estimated_cost_usd numeric(12,6) null`, `ttft_ms int null`, `latency_ms int null`, `error_code null`, `error_message null`, `conversation_id null`, `document_id null` | index (`reference_id`), (`trace_id`), (`status`,`started_at desc`) |
| `ai_run_steps` | `id`, `run_id`, `step text` (`retrieve`/`web_search`/`llm`/`citation_check`/`grade`/`parse`/`index`/`generate`), `started_at`, `ended_at`, `outcome text` (`ok`/`empty`/`failed`/`skipped`), `metrics jsonb` | index (`run_id`) |
| `question_bank` | `id`, `course_id`, `concept_id`, `lesson_id null`, `type text` (`mcq`/`short`), `stem`, `explanation`, `difficulty real` (0–1), `source text` (`seed`/`generated`/`instructor`), `status text` (`draft`/`published`/`archived`), `is_diagnostic bool`, `created_by null`, `created_at`, `updated_at` | index (`course_id`,`concept_id`,`status`) |
| `question_options` | `id`, `question_id`, `label text` (A–D), `text`, `is_correct bool`, `position` | |
| `rubrics` | `id`, `question_id`, `version int`, `criteria jsonb` (`[{id, description, points}]`), `model_answer text`, `created_at` | unique (`question_id`,`version`) |
| `quizzes` | `id`, `course_id`, `title`, `kind text` (`diagnostic`/`practice`/`lesson_check`/`revision`), `concept_id null`, `lesson_id null`, `created_by null`, `created_at` | |
| `quiz_questions` | `quiz_id`, `question_id`, `position` | PK (`quiz_id`,`question_id`) |
| `quiz_attempts` | `id`, `quiz_id`, `user_id`, `started_at`, `completed_at null`, `correct_count int`, `question_count int` | index (`user_id`,`started_at desc`) |
| `submitted_answers` | `id`, `attempt_id`, `question_id`, `selected_option_id null`, `free_text null`, `is_correct bool null`, `mastery_before real null`, `mastery_after real null`, `submitted_at` | unique (`attempt_id`,`question_id`) |
| `grading_results` | `id`, `submitted_answer_id`, `rubric_version`, `score real`, `max_score real`, `confidence real`, `feedback text`, `criteria_scores jsonb`, `status text` (`pending`/`auto_accepted`/`needs_review`/`reviewed`/`failed`), `reviewed_by null`, `reviewed_at null`, `final_score real null`, `reviewer_feedback null`, `run_id null`, `created_at` | index (`status`) |
| `concept_mastery` | `user_id`, `concept_id`, `mastery real`, `attempts int`, `correct int`, `last_practiced_at`, `updated_at` | PK (`user_id`,`concept_id`) |
| `concept_mastery_history` | `id`, `user_id`, `concept_id`, `before real`, `after real`, `source text` (`diagnostic`/`practice`/`revision`/`grading`), `source_id uuid null`, `created_at` | index (`user_id`,`created_at`) |
| `revision_cards` | `id`, `user_id`, `course_id`, `question_id`, `concept_id`, `ease_factor real` (2.5), `interval_days int`, `repetitions int`, `due_at`, `last_reviewed_at null`, `last_quality int null`, `created_at` | unique (`user_id`,`question_id`); index (`user_id`,`due_at`) — this is the spec's `RevisionSchedules` |
| `recommendations` | `id`, `user_id`, `course_id`, `type text` (`lesson`/`concept_practice`/`quiz`/`revision`), `target_id uuid`, `title`, `reason`, `score real`, `created_at`, `dismissed_at null` | index (`user_id`,`course_id`,`created_at desc`) |
| `usage_records` | `id`, `user_id`, `day date`, `kind text` (`chat`/`web_search`/`upload`/`quiz_generation`/`grading`), `count int`, `input_tokens bigint`, `output_tokens bigint`, `cost_usd numeric(12,6)` | unique (`user_id`,`day`,`kind`) |
| `audit_events` | `id`, `actor_user_id null`, `action text` (e.g. `auth.login`, `document.delete`, `user.delete_requested`, `grading.review`, `debug_capture.enable`), `entity_type`, `entity_id null`, `metadata jsonb`, `trace_id`, `created_at` | index (`actor_user_id`,`created_at`); long retention |
| `outbox_messages` | `id`, `type text` (`document.deleted`/`user.deleted`), `payload jsonb`, `created_at`, `processed_at null`, `attempts int`, `last_error null` | index (`processed_at`) |
| `data_protection_keys` | EF Core DataProtection key store (shared by `api` and `jobs` so the auth cookie is valid on `/hangfire`) | |

### 3.2 Schema `ai` (owner: Python, Alembic in `services/ai-service/migrations`)

| Table | Columns | Notes |
| --- | --- | --- |
| `document_chunks` | `id uuid`, `document_id uuid`, `document_version int`, `scope text` (`user`/`course`), `owner_user_id uuid null`, `course_id uuid null`, `source_type text` (`course`/`upload`), `title text`, `page int null`, `section text null`, `chunk_index int`, `content text`, `token_count int`, `content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED`, `created_at` | unique (`document_id`,`document_version`,`chunk_index`); GIN on `content_tsv`; btree on (`scope`,`course_id`), (`owner_user_id`) |
| `chunk_embeddings` | `chunk_id uuid PK FK document_chunks ON DELETE CASCADE`, `model text`, `dim int`, `embedding vector(384)` | HNSW `vector_cosine_ops`. One model per index; a different model gets a new table + re-embedding job |
| `retrieval_runs` | `id`, `run_id`, `trace_id`, `query_hash`, `method text` (`vector`/`keyword`/`hybrid`), `scope_course_count int`, `scope_includes_uploads bool`, `top_k int`, `result_count int`, `timings jsonb`, `empty bool`, `created_at` | |
| `retrieved_sources` | `id`, `retrieval_run_id null`, `run_id`, `rank int`, `source_type text` (`course`/`upload`/`web`), `chunk_id null`, `document_id null`, `url text null`, `title`, `score real`, `vector_rank int null`, `keyword_rank int null`, `cited bool` | |
| `search_runs` | `id`, `run_id`, `trace_id`, `query_hash`, `provider`, `result_count`, `urls jsonb`, `latency_ms`, `cache_hit bool`, `outcome text` (`ok`/`empty`/`failed`/`skipped`), `error_code null`, `created_at` | |
| `search_cache` | `query_hash PK`, `provider`, `results jsonb`, `created_at`, `expires_at` | repeated-query cache (24 h) |
| `model_configurations` | `id`, `name`, `provider`, `model`, `params jsonb`, `is_active bool`, `created_at` | |
| `model_runs` | `id`, `run_id`, `trace_id`, `purpose text` (`tutor`/`query_rewrite`/`quiz_generation`/`grading`/`evaluation`), `provider`, `model`, `prompt_name`, `prompt_version`, `prompt_hash`, `params jsonb`, `input_tokens`, `output_tokens`, `estimated_cost_usd numeric(12,6)`, `ttft_ms null`, `latency_ms`, `retries int`, `finish_reason text`, `error_code null`, `fallback_used bool`, `created_at` | daily spend = sum(`estimated_cost_usd`) today |
| `agent_runs`, `tool_invocations` | reserved for the Stretch agents phase (create tables, unused) | |
| `debug_captures` | `id`, `run_id`, `conversation_id null`, `prompt text`, `response text`, `created_at`, `expires_at` | only written when debug capture is enabled for that conversation; retention 72 h |
| `evaluation_datasets`, `evaluation_cases`, `evaluation_runs`, `evaluation_results` | datasets (name, kind `retrieval`/`tutor`/`grading`/`injection`), cases (input jsonb, expected jsonb), runs (dataset_id, started/finished, metrics jsonb, git_sha), results (run_id, case_id, passed, scores jsonb, output jsonb) | |

### 3.3 Schema `hangfire`

Created and owned by `Hangfire.PostgreSql` (`SchemaName = "hangfire"`, `PrepareSchemaIfNecessary = true`) using role `sathi_hangfire`.

---

## 4. Correlation, IDs, errors

- **Trace context:** W3C `traceparent` is created in the browser by an Angular interceptor (new trace per user action) and forwarded by Nginx. .NET (ASP.NET Core + OpenTelemetry) continues it and propagates it on `HttpClient` calls; FastAPI continues it. Hangfire jobs receive `traceParent` as a job argument and restore it.
- **`X-Request-Id`:** set by Nginx (`$request_id`) if absent; echoed back in responses; logged as `request_id`.
- **Reference ID:** first 8 hex characters of the trace ID, upper-case, formatted `XXXX-XXXX` (e.g. trace `7f3a91c2…` → `7F3A-91C2`). Shown in the UI for every error. `ai_runs.reference_id` and `ingestion_jobs.reference_id` store it (without the dash, upper-case) for J8 lookup.
- **`user_id_hash`:** `HMAC-SHA256(key=LOG_HASH_SALT, message=user_id lower-case string)`, hex, first 16 chars. Identical in .NET and Python.

### 4.1 Error responses (RFC 9457 ProblemDetails)

All non-2xx responses from `api`, `jobs` and `ai-service` use `application/problem+json`:

```json
{
  "type": "https://sathi.app/errors/quota-exceeded",
  "title": "Daily limit reached",
  "status": 429,
  "detail": "You have used today's 20 web searches. They reset at midnight.",
  "code": "WEB_SEARCH_QUOTA_EXCEEDED",
  "traceId": "7f3a91c2e4b5...32 hex",
  "referenceId": "7F3A-91C2",
  "errors": { "email": ["Email is required."] }
}
```

`errors` only for `VALIDATION_FAILED`. `detail` is safe to show to users and never contains internals.

### 4.2 Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Request validation failed |
| `AUTH_UNAUTHENTICATED` | 401 | Not signed in |
| `AUTH_FORBIDDEN` | 403 | Signed in but not allowed (also used for other users' resources → prefer 404 `NOT_FOUND` to avoid leaking existence) |
| `AUTH_INVALID_CREDENTIALS` | 401 | Wrong email or password |
| `AUTH_EMAIL_NOT_CONFIRMED` | 403 | Must verify email first |
| `AUTH_LOCKED_OUT` | 423 | Too many failed attempts |
| `AUTH_EMAIL_TAKEN` | 409 | Registration with an existing email |
| `AUTH_INVALID_TOKEN` | 400 | Verification/reset token invalid or expired |
| `CSRF_INVALID` | 400 | Antiforgery check failed |
| `NOT_FOUND` | 404 | |
| `CONFLICT` | 409 | |
| `RATE_LIMITED` | 429 | Too many requests (has `Retry-After`) |
| `QUOTA_EXCEEDED` | 429 | Daily chat/upload quota used |
| `WEB_SEARCH_QUOTA_EXCEEDED` | 429 | Daily web-search quota used |
| `UPLOAD_INVALID_TYPE` | 415 | Extension/MIME/magic bytes not allowed |
| `UPLOAD_TOO_LARGE` | 413 | Over 25 MB or over storage quota |
| `LLM_TIMEOUT` | 504 | |
| `LLM_RATE_LIMITED` | 503 | Provider 429 after retries |
| `LLM_UNAVAILABLE` | 503 | Provider down after fallback |
| `LLM_REFUSED` | 422 | Model declined |
| `LLM_DISABLED` | 503 | Kill switch on |
| `SPEND_CAP_REACHED` | 503 | Global daily spend cap reached |
| `AI_SERVICE_UNAVAILABLE` | 503 | .NET could not reach the AI service |
| `RAG_NO_RESULTS` | — | Warning only (logged, `status` event) |
| `WEB_SEARCH_FAILED` | — | Warning only; answer continues without web |
| `INGEST_PARSE_FAILED` | — | Ingestion job error code |
| `INGEST_NO_TEXT` | — | No selectable text (e.g. scanned PDF) |
| `INGEST_UNSUPPORTED_TYPE` | — | |
| `INGEST_INDEX_FAILED` | — | |
| `GRADING_LOW_CONFIDENCE` | — | Routed to instructor review (not an error to the user) |
| `GRADING_FAILED` | — | |
| `QUIZ_GENERATION_FAILED` | — | |
| `SERVICE_TOKEN_INVALID` | 401 | Internal: bad/expired service token |
| `INTERNAL_ERROR` | 500 | Unhandled |

---

## 5. Public API `/api/v1` (Angular ↔ .NET)

- Auth: ASP.NET Core Identity **cookie** `sathi.auth` (HttpOnly, Secure outside development, SameSite=Lax, 14-day sliding). Unauthenticated API calls return 401 ProblemDetails (never a redirect).
- CSRF: antiforgery with cookie `XSRF-TOKEN` (readable by JS) and header `X-XSRF-TOKEN` on every non-GET request. Angular's `withXsrfConfiguration({cookieName:'XSRF-TOKEN', headerName:'X-XSRF-TOKEN'})`. `GET /api/v1/auth/csrf` (re)issues the cookie; the app calls it on startup and after login/logout. Note: Angular only attaches the header for relative URLs — always call `/api/...` relative.
- JSON: camelCase, ISO-8601 UTC dates, enums as lowercase strings.
- Pagination: cursor-based `?cursor=<opaque>&limit=20` → `{ "items": [...], "nextCursor": "..." | null }`.
- Mutations that create content accept an `Idempotency-Key` header (chat send, upload, attempt answers).
- Every response carries `X-Request-Id` and `traceparent`-derived `X-Trace-Id`.
- Rate limits: global per-user 120 req/min; auth endpoints 10 req/min per IP; `/client-errors` 30/min per IP.

### 5.1 Auth & me

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /auth/csrf` | — | 204, sets `XSRF-TOKEN` |
| `POST /auth/register` | `{email, password, displayName}` | 202 `{ "message": "Check your email" }` — sends verification email with link `${APP_BASE_URL}/auth/verify-email?userId=..&token=..` |
| `POST /auth/verify-email` | `{userId, token}` | 204 |
| `POST /auth/resend-verification` | `{email}` | 202 (always, no enumeration) |
| `POST /auth/login` | `{email, password, rememberMe}` | 200 `Me` |
| `POST /auth/logout` | — | 204 |
| `POST /auth/forgot-password` | `{email}` | 202 (always) — link `${APP_BASE_URL}/auth/reset-password?email=..&token=..` |
| `POST /auth/reset-password` | `{email, token, newPassword}` | 204 |
| `GET /auth/me` | — | 200 `Me` or 401 |
| `PUT /me/preferences` | `{level?, timezone?, reminderHour?, remindersEnabled?, activeCourseId?}` | 200 `Me` |
| `DELETE /me` | `{password}` | 202 — soft-deletes, writes `user.deleted` outbox event, signs out |

Password policy: min 10 chars, at least one letter and one digit. Lockout: 5 failures → 15 minutes.

```ts
interface Me {
  id: string; email: string; displayName: string;
  roles: ('Student'|'Instructor'|'Admin')[];
  emailConfirmed: boolean;
  preferences: { level: Level; timezone: string; reminderHour: number; remindersEnabled: boolean; activeCourseId: string|null };
  onboardingCompleted: boolean;
}
type Level = 'beginner'|'intermediate'|'advanced';
```

### 5.2 Courses, lessons, home, progress

| Method & path | Response |
| --- | --- |
| `GET /courses` | `CourseSummary[]` = `{id, slug, title, description, moduleCount, lessonCount, enrolled, diagnosticCompleted}` |
| `GET /courses/{courseId}` | `{id, slug, title, description, modules: [{id, title, summary, position, lessons: [{id, title, summary, position, estimatedMinutes, status, percent}]}], concepts: [{id, slug, name, description}]}` |
| `POST /courses/{courseId}/enroll` | 200 `CourseSummary` (idempotent; sets `activeCourseId`) |
| `GET /lessons/{lessonId}` | `{id, title, summary, contentMarkdown, estimatedMinutes, position, lessonCount (in module), module: {id, title, position}, course: {id, title}, objectives: string[], concepts: [{id, name}], progress: {status, percent}, previousLessonId, nextLessonId}` |
| `POST /lessons/{lessonId}/progress` | body `{percent, completed}` → 204 (updates `enrollments.current_lesson_id`) |
| `GET /home?courseId=` | `Home` (below) |
| `GET /progress?courseId=` | `{mastery: ConceptMastery[], masteryTrend: [{date, average}], quizzes: [{attemptId, title, completedAt, correct, total}], lessonsCompleted, lessonCount, streakDays, questionsAsked}` |

```ts
interface Home {
  course: { id: string; title: string };
  continueLesson: { lessonId: string; title: string; summary: string; courseTitle: string; moduleTitle: string; modulePosition: number; lessonPosition: number; lessonCount: number; percent: number } | null;
  revision: { dueCount: number; estimatedMinutes: number };
  mastery: ConceptMastery[];            // sorted strongest → weakest
  studyNext: StudyNextItem[];           // max 3
  streakDays: number;
}
interface ConceptMastery { conceptId: string; name: string; mastery: number /*0..1*/; attempts: number; needsWork: boolean /* mastery < 0.5 */ }
interface StudyNextItem { type: 'lesson'|'concept_practice'|'quiz'|'revision'; targetId: string; title: string; reason: string }
```

### 5.3 Tutor

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /conversations?courseId=&cursor=&limit=` | — | page of `{id, title, courseId, lessonId, updatedAt, lastMessagePreview}` |
| `POST /conversations` | `{courseId, lessonId?}` | 201 `{id, title, courseId, lessonId, createdAt}` |
| `GET /conversations/{id}` | — | `{id, title, courseId, lessonId, lessonTitle, messages: Message[]}` |
| `DELETE /conversations/{id}` | — | 204 |
| `POST /conversations/{id}/messages/stream` | `{content, level, mode, adjust?, webSearch, replyToMessageId?}` + `Idempotency-Key` header | `text/event-stream` (§5.3.1) |
| `POST /messages/{messageId}/feedback` | `{rating: 1 \| -1, comment?}` | 204 |

`adjust` (`simpler`/`harder`) re-explains the assistant message `replyToMessageId`; `content` may be empty then, and the stored user message reads "Explain that more simply" / "Go deeper".

```ts
interface Message {
  id: string; role: 'user'|'assistant'; content: string;
  level: Level; mode: 'explain'|'hint'|'quiz_me'; adjust: 'simpler'|'harder'|null; webSearch: boolean;
  citations: Citation[]; answerBasis: ('course'|'upload'|'web'|'general')[];
  status: 'streaming'|'complete'|'partial'|'failed'; errorCode: string|null; referenceId: string|null;
  feedback: 1|-1|null; createdAt: string;
}
interface Citation {
  index: number;                         // the [n] marker in content
  sourceType: 'course'|'upload'|'web';
  title: string;                          // file name, lesson title or page title
  documentId: string|null; lessonId: string|null; page: number|null;
  url: string|null;                       // web only
  snippet: string;                        // ≤ 240 chars
}
```

#### 5.3.1 SSE stream (browser ← .NET)

Wire format: `event: <name>\ndata: <json>\n\n`; comment keep-alive `: ping\n\n` every 15 s. Every `data` object includes `"requestId"`. The browser uses `fetch` + `ReadableStream` (POST with CSRF header), not `EventSource`.

| Event | Data |
| --- | --- |
| `start` | `{conversationId, userMessageId, assistantMessageId, runId, referenceId}` |
| `status` | `{stage: 'retrieving'\|'searching_web'\|'reading_sources'\|'generating', message: string}` — e.g. "Searching the web…" |
| `token` | `{text}` |
| `citation` | `Citation` — sent after generation, only for citations that passed the citation check |
| `usage` | `{inputTokens, outputTokens, costUsd, model, ttftMs, latencyMs}` |
| `error` | `{code, message, referenceId}` — terminal |
| `done` | `{messageId, content /* final text with invalid [n] markers removed */, answerBasis, citationsValid, citationsDropped, warnings: string[] /* e.g. WEB_SEARCH_FAILED, RAG_NO_RESULTS */}` — terminal |

.NET behaviour: checks auth, ownership, daily chat quota (and web-search quota if `webSearch`), creates the user message and an assistant message with `status='streaming'`, creates `ai_runs` row (`id` = new run id, `trace_id` = current trace), emits `start`, calls the AI service and relays events. It keeps consuming the upstream stream **even if the browser disconnects** (upstream uses its own cancellation token with a 180 s timeout), then saves the final content/citations/basis (`complete`, or `partial`/`failed` with `error_code`), writes `ai_run_steps` from the AI service `done.steps`, completes the `ai_runs` row and increments `usage_records`. On AI-service connection failure it emits `error` with `AI_SERVICE_UNAVAILABLE`.

### 5.4 Practice, quizzes, diagnostic, revision

| Method & path | Body | Response |
| --- | --- | --- |
| `POST /courses/{courseId}/diagnostic` | — | `Attempt` for the course's diagnostic quiz (one `is_diagnostic` question per concept, max 10) |
| `POST /practice/sessions` | `{courseId, conceptId?, lessonId?, count? (default 8)}` | `Attempt` — picks published questions for the concept/lesson, weakest concepts first when no concept given |
| `GET /attempts/{attemptId}` | — | `Attempt` (with answers so far) |
| `POST /attempts/{attemptId}/answers` | `{questionId, selectedOptionId?, freeText?}` + `Idempotency-Key` | `AnswerResult` |
| `GET /attempts/{attemptId}/answers/{answerId}` | — | `AnswerResult` (poll while `grading.status == 'pending'`) |
| `POST /attempts/{attemptId}/complete` | — | `{attemptId, correct, total, masteryChanges: [{conceptId, name, before, after}], studyNext: StudyNextItem[]}` (diagnostic completion also sets `enrollments.diagnostic_completed_at`, `user_preferences.onboarding_completed_at`) |
| `GET /revision/due?courseId=` | — | `{dueCount, cards: [{cardId, dueAt, question: AttemptQuestion}]}` |
| `POST /revision/cards/{cardId}/review` | `{selectedOptionId?, freeText?, quality? /*0..5 self-rating*/}` | `{isCorrect, correctOptionId, explanation, nextDueAt, intervalDays}` |
| `GET /revision/schedule?courseId=` | — | `{days: [{date, count}] /* next 14 days */}` |

```ts
interface Attempt {
  attemptId: string; quizId: string; title: string; kind: 'diagnostic'|'practice'|'lesson_check'|'revision';
  conceptName: string|null; questions: AttemptQuestion[]; answers: AnswerResult[]; completed: boolean;
}
interface AttemptQuestion { id: string; position: number; type: 'mcq'|'short'; stem: string; conceptId: string; conceptName: string; options: {id: string; label: string; text: string}[] }
interface AnswerResult {
  answerId: string; questionId: string; isCorrect: boolean|null;
  selectedOptionId: string|null; correctOptionId: string|null; explanation: string;
  mastery: {conceptId: string; name: string; before: number; after: number} | null;
  grading: {status: 'pending'|'auto_accepted'|'needs_review'|'reviewed'|'failed'; score: number|null; maxScore: number|null; feedback: string|null} | null;
}
```

MCQ answers are graded instantly in .NET. Short answers create a `grading_results` row (`pending`) and enqueue the `GradeAnswerJob`; low confidence (< `Grading__AutoAcceptConfidence`) → `needs_review` with code `GRADING_LOW_CONFIDENCE` logged. Every answered question creates or updates a `revision_cards` row (SM-2: correct → quality 4, incorrect → quality 1).

### 5.5 Notes (uploads)

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /documents` | — | `DocumentItem[]` (user's own uploads) |
| `POST /documents` | multipart `file` + `Idempotency-Key` | 202 `DocumentItem` |
| `GET /documents/{id}` | — | `DocumentItem` (UI polls every 2 s while not terminal) |
| `POST /documents/{id}/retry` | — | 202 `DocumentItem` (new ingestion attempt for the same version) |
| `DELETE /documents/{id}` | — | 204 (soft delete + `document.deleted` outbox event → chunks removed) |

```ts
interface DocumentItem {
  id: string; fileName: string; sizeBytes: number; contentType: string;
  status: 'queued'|'processing'|'ready'|'failed';
  stage: 'queued'|'parsing'|'indexing'|'ready'|'failed'; progressPercent: number;
  passageCount: number|null; errorCode: string|null; errorMessage: string|null; referenceId: string|null;
  createdAt: string; updatedAt: string;
}
```

Allowed: `.pdf` (`%PDF-` magic), `.docx` (`PK\x03\x04` zip + `word/` entry), `.md`, `.txt` (valid UTF-8, no NUL bytes). Max 25 MB each, 200 MB per user, 20 uploads/day. Storage key: `uploads/{ownerUserId}/{documentId}/v{version}/{sanitizedFileName}`. Stage → percent: queued 5, parsing 30, indexing 70, ready 100.

### 5.6 Instructor (role `Instructor` or `Admin`)

| Method & path | Notes |
| --- | --- |
| `GET /instructor/courses` | courses the instructor can edit (all for Admin) |
| `POST /instructor/courses`, `PUT /instructor/courses/{id}` | `{title, slug, description, isPublished}` |
| `POST /instructor/courses/{id}/modules`, `PUT /instructor/modules/{id}`, `DELETE /instructor/modules/{id}` | `{title, summary, position}` |
| `POST /instructor/modules/{id}/lessons`, `PUT /instructor/lessons/{id}`, `DELETE /instructor/lessons/{id}` | `{title, summary, contentMarkdown, estimatedMinutes, position, conceptIds[], objectives[]}` — saving content bumps `version` and enqueues `IndexLessonJob` |
| `POST /instructor/courses/{id}/concepts`, `PUT /instructor/concepts/{id}` | `{name, slug, description, prerequisiteIds[]}` |
| `GET /instructor/courses/{id}/documents`, `POST /instructor/courses/{id}/documents` | course-scope uploads (same rules as §5.5, `scope='course'`) |
| `GET /instructor/questions?courseId=&status=&conceptId=` | list with options/rubric |
| `POST /instructor/questions` / `PUT /instructor/questions/{id}` | create/edit; `{conceptId, lessonId?, type, stem, explanation, difficulty, status, isDiagnostic, options[{label,text,isCorrect}], rubric?{criteria[], modelAnswer}}` |
| `POST /instructor/questions/generate` | `{courseId, conceptId, count (1–10), difficulty}` → 202 `{runId, referenceId}`; `GenerateQuestionsJob` creates `draft` questions |
| `GET /instructor/grading-queue?courseId=` | `[{gradingId, studentDisplayName, questionStem, answerText, aiScore, maxScore, confidence, aiFeedback, rubric, submittedAt}]` (`needs_review`) |
| `POST /instructor/grading/{gradingId}/review` | `{finalScore, feedback}` → 204, audit event, updates mastery |
| `GET /instructor/insights?courseId=` | `{enrolled, activeLast7Days, questionsAsked7Days, helpfulRate /*0..1 or null*/, conceptMastery: [{conceptId, name, averageMastery, studentsBelowHalf}], pendingReviews}` |

### 5.7 Admin / AI engineer (role `Admin`) — journey J8

| Method & path | Response |
| --- | --- |
| `GET /admin/runs?status=&type=&cursor=` | page of `AiRunSummary` |
| `GET /admin/runs/lookup/{referenceOrTraceOrRunId}` | `AiRunDetail` — accepts `7F3A-91C2`, `7F3A91C2`, a 32-hex trace ID or a run UUID; also searches `ingestion_jobs.reference_id` |
| `GET /admin/usage?days=7` | `{days: [{date, chatMessages, webSearches, uploads, inputTokens, outputTokens, costUsd}], activeUsers}` |
| `PUT /admin/debug-capture/{conversationId}` | `{enabled, hours (≤ 24)}` → audit event |

```ts
interface AiRunDetail {
  run: { id; traceId; referenceId; type; status; startedAt; finishedAt; model; provider; promptHash; inputTokens; outputTokens; estimatedCostUsd; ttftMs; latencyMs; errorCode; errorMessage; hangfireJobId; conversationId; documentId; userIdHash };
  steps: { step; startedAt; endedAt; outcome; metrics: Record<string, unknown> }[];
  ingestionJob: { id; documentId; status; stage; attempt; errorCode; errorMessage; hangfireJobId } | null;
  aiService: InternalRunDetail | null;      // from GET /internal/v1/runs/{runId}
  links: { grafanaLogs: string; grafanaTrace: string; hangfireJob: string | null };
}
```

### 5.8 Client error reporting

`POST /client-errors` (anonymous allowed, rate limited, no CSRF required): `{kind: 'unhandled'|'http'|'sse_drop', message (≤ 300 chars, no user content), traceId?, route, appVersion, userAgent, status?, url?}` → 204, logged at Warning with `source=web`.

### 5.9 Health

`GET /health/live` (process up) and `GET /health/ready` (DB reachable; AI service reachable for `api`) on `api`, `jobs` and `ai-service`. Not exposed through `web`.

---

## 6. Internal API `/internal/v1` (.NET → FastAPI)

Private network only. Every request carries:

- `Authorization: Bearer <service token>` — JWT **RS256** since Release 2 (see §11.7: .NET signs with its private key and always sends `kid`; FastAPI verifies with public keys only). Originally HS256 with a shared secret. Claims: `iss="sathi-api"` (or `"sathi-jobs"`), `aud="ai-service"`, `sub` = user id (or `"system"`), `uh` = user_id_hash, `scp` = space-separated scopes from `tutor ingest quiz grade mastery runs eval admin`, `rscope` = `{"course_ids": ["uuid",...], "user_id": "uuid"|null}` (retrieval scope), `rid` = request id, `iat`, `exp` = iat + 300 s. FastAPI rejects missing/expired/wrong-audience tokens with 401 `SERVICE_TOKEN_INVALID` and missing scope with 403.
- `traceparent`, `X-Request-Id`, `X-Run-Id`.

**Retrieval must filter inside SQL before ranking**, using only the token's `rscope` — never request-body fields:
`WHERE (c.scope = 'course' AND c.course_id = ANY(:course_ids)) OR (c.scope = 'user' AND c.owner_user_id = :user_id)`.

| Method & path | Scope | Request | Response |
| --- | --- | --- | --- |
| `POST /internal/v1/tutor/stream` | `tutor` | `TutorRequest` | SSE (§6.1) |
| `POST /internal/v1/ingest/parse` | `ingest` | `{documentId, documentVersion, storageKey, contentType, fileName}` | `{pageCount, charCount, parsedKey}` — writes `parsed/{documentId}/v{version}.json` to storage; errors 422 with code `INGEST_PARSE_FAILED` / `INGEST_NO_TEXT` / `INGEST_UNSUPPORTED_TYPE` |
| `POST /internal/v1/ingest/index` | `ingest` | `{documentId, documentVersion, parsedKey, scope, ownerUserId?, courseId?, lessonId?, sourceType, title}` | `{passageCount, embeddingModel}` — idempotent: deletes chunks for (`documentId`, any version) then inserts, in one transaction |
| `POST /internal/v1/ingest/text` | `ingest` | `{documentId, documentVersion, scope, courseId, lessonId, sourceType:'course', title, markdown}` | `{passageCount, embeddingModel}` — lesson content (no file) |
| `DELETE /internal/v1/documents/{documentId}` | `ingest` | — | 204 (all versions' chunks) |
| `DELETE /internal/v1/users/{userId}` | `admin` | — | 204 (chunks owned by the user, debug captures) |
| `POST /internal/v1/quiz/generate` | `quiz` | `{courseId, concept: {id, name, description}, count, difficulty, lessonTitles: []}` | `{questions: [{stem, explanation, difficulty, options: [{label, text, isCorrect}]}], model, promptHash, inputTokens, outputTokens, costUsd}` — exactly one correct option; validated with Pydantic; grounded in course retrieval |
| `POST /internal/v1/grade` | `grade` | `{questionStem, rubric: {version, criteria: [{id, description, points}], modelAnswer}, answerText}` | `{score, maxScore, confidence /*0..1*/, feedback, criteriaScores: [{id, points, comment}], model, promptHash, inputTokens, outputTokens, costUsd}` — answer text is passed as quoted data, never as instructions |
| `POST /internal/v1/mastery/update` | `mastery` | `{prior, attempts, correct: bool, difficulty, score?: 0..1}` | `{mastery}` (§7) |
| `POST /internal/v1/recommendations` | `mastery` | `{concepts: [{id, name, mastery, attempts, lastPracticedAt, prerequisiteIds}], nextLesson: {id, title} \| null, revisionDue: int, lessonConcepts: {lessonId: [conceptId]}}` | `{items: [{type, targetId, title, reason, score}]}` (max 3) |
| `GET /internal/v1/runs/{runId}` | `runs` | — | `InternalRunDetail = {modelRuns: [...], retrievalRuns: [{..., sources: [...]}], searchRuns: [...]}` |
| `POST /internal/v1/eval/run` | `eval` | `{dataset: 'retrieval'\|'tutor'\|'injection'\|'all'}` | `{evaluationRunId, metrics}` |
| `PUT /internal/v1/admin/log-level` | `admin` | `{level}` | 204 |
| `PUT /internal/v1/admin/debug-capture` | `admin` | `{conversationId, enabled, expiresAt}` | 204 |
| `GET /health/live`, `GET /health/ready` | none | — | |

```ts
interface TutorRequest {
  runId: string; conversationId: string;
  course: { id: string; title: string }; lesson: { id: string; title: string } | null;
  question: string; level: Level; mode: 'explain'|'hint'|'quiz_me'; adjust: 'simpler'|'harder'|null;
  previousAnswer: string | null;          // set when adjust != null
  webSearch: boolean;
  history: { role: 'user'|'assistant'; content: string }[];   // last 8 turns, oldest first, .NET-trimmed
  weakConcepts: { name: string; mastery: number }[];          // up to 3
}
```

### 6.1 SSE stream (.NET ← FastAPI)

Same wire format and event names as §5.3.1 except: no `start` event, and `done` adds `steps` and run metrics:

```json
{ "content": "...", "answerBasis": ["course","web"], "citationsValid": 2, "citationsDropped": 0,
  "warnings": [], "requestId": "...",
  "steps": [{"step": "retrieve", "startedAt": "...", "endedAt": "...", "outcome": "ok", "metrics": {"method": "hybrid", "resultCount": 6}}],
  "run": {"provider": "anthropic", "model": "claude-opus-5-5", "promptHash": "sha256:…", "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0, "ttftMs": 0, "latencyMs": 0} }
```

`citation` events carry the `Citation` shape (camelCase) and are sent before `done`. On failure the AI service sends `error` `{code, message}` and closes. Before the first token it sends `status` events in order: `retrieving`, (`searching_web`, `reading_sources` when web search is on), `generating`.

---

## 7. Learning algorithms (shared definitions)

**Mastery update (AI service, stateless).** Mastery `m ∈ [0.02, 0.98]`, default prior 0.30. Difficulty `d ∈ [0,1]` (easy 0.3, medium 0.5, hard 0.7). Expected success `p = 1 / (1 + e^(−6·(m − d)))`. Outcome `o = 1` correct / `0` wrong (or rubric `score` fraction for short answers). Learning rate `k = max(0.06, 0.30 / √(1 + attempts))`. Update `m' = clamp(m + k·(o − p))`. Worked example: `m = 0.42`, `d = 0.5`, attempts = 3, correct → `p = 1/(1+e^{0.48}) = 0.382`, `k = 0.30/2 = 0.15`, `m' = 0.42 + 0.15·0.618 = 0.513`. Diagnostic sets the prior directly: correct → 0.60, wrong → 0.25.

**Revision (SM-2, .NET).** Quality `q ∈ 0..5`. If `q < 3`: repetitions = 0, interval = 1 day. Else repetitions += 1, interval = 1 (rep 1), 3 (rep 2), `round(interval · EF)` afterwards. `EF' = max(1.3, EF + 0.1 − (5 − q)·(0.08 + (5 − q)·0.02))`. `due_at = now + interval`. ~1.2 minutes per card for time estimates.

**Recommendations (AI service).** Candidates: weakest concepts with prerequisites ≥ 0.5 mastery (score `1 − m`, reason names the concept and recent misses), revision when `revisionDue > 0` (score 0.6), next lesson (score 0.5), lesson-check quiz for the most recent lesson's concepts. Return top 3 with a one-sentence human reason each.

---

## 8. Logging contract

Structured JSON to stdout in every service (Serilog `CompactJsonFormatter`-style renamed fields in .NET; structlog JSON in Python). Also exported via OTLP logs to the collector when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

Required fields on every line: `timestamp` (ISO-8601 UTC), `level` (`debug`/`info`/`warning`/`error`), `message`, `service` (`web`/`api`/`jobs`/`ai-service`/`ai-ingest`), `env`, `version`, `trace_id`, `span_id`, `request_id`, `user_id_hash` (when a user is known). Contextual: `conversation_id`, `job_id`, `document_id`, `run_id`, `attempt`, `error_code`, `exception_type`, `exception_message`, `stack` (errors only), `duration_ms`.

Never log: passwords, tokens, cookies, API keys, raw emails, raw user IDs, document text, prompts, model answers, learner answers. A redaction layer masks values whose key matches `password|secret|token|authorization|cookie|api[_-]?key|email` and string values matching email / bearer / `sk-` patterns. Tests assert seeded secrets never appear in captured logs.

Log each failure **once**, at the boundary that handles it. Levels as in master spec §7.2. AI-specific events and their fields are listed in master spec §7.3 (LLM call: `provider, model, prompt_name, prompt_hash, params, input_tokens, output_tokens, cost_usd, ttft_ms, latency_ms, retries, finish_reason, error_code`; retrieval: `query_hash, method, scope_size, top_k, chunk_ids, scores, timings, empty`; etc.).

Event names (field `event` in Python, `EventId.Name` in .NET) use dotted lowercase: `http.request`, `llm.call`, `retrieval.run`, `web_search.run`, `citation.check`, `ingest.step`, `job.state`, `grading.routed`, `auth.login_failed`, `client.error`.

---

## 9. Seed content

`content/ai-engineering/` (read by `Sathi.Migrator`, idempotent upsert by slug):

- `course.json`: `{slug, title, description, domain, concepts: [{slug, name, description, prerequisites: [slug]}], modules: [{title, summary, lessons: [{slug, title, summary, estimatedMinutes, concepts: [slug], objectives: [string], file: "lessons/xx-name.md"}]}]}`
- `lessons/*.md`: lesson content (Markdown with `$...$` / `$$...$$` LaTeX).
- `questions.json`: `[{concept: slug, lesson: slug|null, type: "mcq"|"short", stem, explanation, difficulty, isDiagnostic, options: [{label, text, isCorrect}], rubric: {criteria: [{id, description, points}], modelAnswer} | null}]`

After seeding, the Jobs host's recurring `SyncLessonIndexJob` (and a one-off on startup) enqueues `IndexLessonJob` for every lesson whose `version` has no `ready` ingestion job.

Golden evaluation sets live in `tests/ai-evaluation/datasets/*.jsonl`.

---

## 10. Hangfire jobs (`Sathi.Jobs`)

Queues: `critical` (grading, deletion), `default` (reminders, rollups, lesson indexing), `ai-heavy` (document ingestion, question generation). Workers: critical 2, default 2, ai-heavy 1. `[AutomaticRetry(Attempts = 3, DelaysInSeconds = new[] {10, 60, 300})]`, per-job timeout via `CancellationToken`. Jobs take IDs + `traceParent` + `runId` only. A server filter restores trace context and logs `job.state` lines (`created`, `processing`, `succeeded`, `failed`, `retrying`) with `job_id`, `attempt`.

The API enqueues jobs through the shared Hangfire storage (`BackgroundJobClient` configured with the same Postgres storage, client only — no server in the API process).

| Job | Queue | Trigger |
| --- | --- | --- |
| `IngestDocumentJob(documentId, version, traceParent, runId)` | ai-heavy | upload, retry |
| `IndexLessonJob(lessonId, version, traceParent)` | default | lesson save, sync |
| `SyncLessonIndexJob` | default | recurring hourly + startup |
| `GradeAnswerJob(gradingResultId, traceParent, runId)` | critical | short-answer submit |
| `GenerateQuestionsJob(courseId, conceptId, count, difficulty, requestedBy, traceParent, runId)` | ai-heavy | instructor request |
| `RecomputeRecommendationsJob(userId, courseId)` | default | after attempt complete (also done inline) |
| `SendRevisionRemindersJob` | default | recurring hourly — emails users whose local hour = `reminder_hour` and due cards > 0 |
| `ProcessOutboxJob` | critical | recurring every minute — delivers `document.deleted`/`user.deleted` to the AI service and storage |
| `UsageRollupJob`, `RetentionCleanupJob` | default | recurring daily — expire debug captures, purge soft-deleted rows after 30 days, delete stale `ai_run_steps` metrics older than 90 days |
| `NightlyEvaluationJob` | default | recurring daily 02:00 UTC — calls `/internal/v1/eval/run` |
| `HeartbeatJob` | default | recurring every 5 minutes — logs `job.heartbeat` (Phase 1 baseline) |
| `RecoverStaleStreamsJob` | default | recurring every 5 minutes — see §11.5 |

---

## 11. Release 2 additions (2026-10-22) — these override earlier sections where they conflict

### 11.1 Course access: visibility, co-instructors, classes

**Schema (`app`)**

| Table / column | Definition |
| --- | --- |
| `courses.visibility` | `text not null default 'public'` — `public` (any signed-in student can see and self-enrol) or `private` (reachable only through class membership) |
| `course_instructors` | `course_id`, `user_id`, `role text` (`owner`/`instructor`), `added_at`; PK (`course_id`,`user_id`). The migration backfills an `owner` row from `courses.created_by` when not null |
| `classes` | `id`, `course_id`, `name`, `description null`, `join_code text unique` (8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, displayed `XXXX-XXXX`), `join_enabled bool default true`, `created_by`, `created_at`, `archived_at null` |
| `class_members` | `class_id`, `user_id`, `joined_at`, `joined_via text` (`code`/`invite`/`added`), `removed_at null`; PK (`class_id`,`user_id`) |
| `class_invites` | `id`, `class_id`, `email_normalized`, `token_hash` (SHA-256 hex of the raw token), `invited_by`, `created_at`, `expires_at` (14 days), `accepted_at null`, `accepted_user_id null`, `revoked_at null`; unique (`class_id`,`email_normalized`) where `accepted_at is null and revoked_at is null` |

**Access rules (enforced in the API, never only in the UI)**

- A student can see a course when it is published **and** (`visibility = 'public'` **or** they are an active member (`removed_at is null`) of a non-archived class of that course). Otherwise every course, lesson, practice and tutor endpoint for it returns 404 `NOT_FOUND`.
- Joining a class (code or invite) enrols the student in the course (idempotent) and sets `activeCourseId` when it is empty.
- Instructors manage only courses where they have a `course_instructors` row; Admin manages all. `POST /instructor/courses` makes the creator `owner`. Instructor insights, grading queue and question bank are limited to those courses.
- Raw invite tokens: 32 random bytes, base64url; only the SHA-256 hash is stored. Invite emails link to `${APP_BASE_URL}/join/{token}`; join-code links are `${APP_BASE_URL}/join?code=XXXX-XXXX`.

**Student endpoints**

| Method & path | Body | Response / errors |
| --- | --- | --- |
| `POST /classes/join` | `{code}` (dash- and case-insensitive) | 200 `{classId, className, course: CourseSummary}`; 404 `CLASS_CODE_INVALID`; 409 `CLASS_JOIN_DISABLED` |
| `GET /classes/invites/{token}` (anonymous) | — | `{className, courseTitle, instructorName, emailMasked, status: 'valid'\|'expired'\|'accepted'\|'revoked'}` |
| `POST /classes/invites/{token}/accept` | — | 200 same as join; 403 `CLASS_INVITE_EMAIL_MISMATCH` (signed-in email ≠ invited email); 410 `CLASS_INVITE_EXPIRED` |
| `GET /me/classes` | — | `[{classId, name, course: {id, title}, joinedAt}]` |
| `DELETE /me/classes/{classId}` | — | 204 (leave the class) |

`CourseSummary` gains `visibility` and `classes: [{id, name}]` (the student's classes for that course).

**Instructor endpoints** (course instructor or Admin)

| Method & path | Body | Response |
| --- | --- | --- |
| `POST /instructor/courses`, `PUT /instructor/courses/{id}` | `{title, slug, description, isPublished, visibility}` | `InstructorCourse` = `{id, slug, title, description, isPublished, visibility, moduleCount, lessonCount, conceptCount, questionCount, studentCount, classCount, myRole: 'owner'\|'instructor'\|'admin'}` |
| `DELETE /instructor/courses/{id}` | — | 204 only when no student is enrolled, else 409 `COURSE_HAS_STUDENTS` (unpublish instead) |
| `GET /instructor/courses/{id}/instructors` | — | `[{userId, displayName, email, role, addedAt}]` |
| `POST /instructor/courses/{id}/instructors` | `{email}` (owner or Admin; the user must already have the Instructor role) | 201; 404 `USER_NOT_FOUND`; 409 `USER_NOT_INSTRUCTOR` |
| `DELETE /instructor/courses/{id}/instructors/{userId}` | — | 204; 409 `COURSE_LAST_OWNER` |
| `GET /instructor/courses/{courseId}/classes` | — | `ClassSummary[]` = `{id, courseId, name, description, joinCode, joinEnabled, memberCount, pendingInvites, createdAt, archivedAt}` |
| `POST /instructor/courses/{courseId}/classes` | `{name, description?}` | 201 `ClassSummary` |
| `PUT /instructor/classes/{id}` | `{name, description, joinEnabled}` | `ClassSummary` |
| `POST /instructor/classes/{id}/regenerate-code` | — | `ClassSummary` |
| `POST /instructor/classes/{id}/archive`, `POST /instructor/classes/{id}/unarchive` | — | `ClassSummary` |
| `GET /instructor/classes/{id}/members` | — | `[{userId, displayName, email, joinedAt, joinedVia, lastActiveAt, averageMastery}]` |
| `DELETE /instructor/classes/{id}/members/{userId}` | — | 204 |
| `POST /instructor/classes/{id}/invites` | `{emails: string[]}` (≤ 100) | `{invited: number, alreadyMembers: string[], invalid: string[]}` — one email each |
| `GET /instructor/classes/{id}/invites` | — | `[{id, email, createdAt, expiresAt, status}]` |
| `DELETE /instructor/invites/{inviteId}`, `POST /instructor/invites/{inviteId}/resend` | — | 204 |

`GET /instructor/insights` and `GET /instructor/grading-queue` accept an optional `classId`.

### 11.2 Roles, staff invites, user administration

- Self-registration always creates a **Student**; users never choose their role.
- Roles live in `user_roles`; the auth cookie carries role claims; `GET /auth/me` returns them; the UI uses them only to show navigation — the API enforces every rule with authorization policies.
- `SecurityStampValidatorOptions.ValidationInterval = 1 minute`; every role change, lock and password reset updates the security stamp, so the change reaches an active session within a minute.
- `staff_invites`: `id`, `email_normalized`, `role text` (`Instructor`/`Admin`), `course_id null`, `token_hash`, `invited_by`, `created_at`, `expires_at` (7 days), `accepted_at null`, `accepted_user_id null`, `revoked_at null`. Email link: `${APP_BASE_URL}/auth/register?staffInvite={token}`. Registering with that token **and the same email** adds the invited role (in addition to Student) and, when `course_id` is set, an `instructor` row in `course_instructors`. An existing account accepts with `POST /auth/staff-invites/{token}/accept` while signed in with the invited email.

| Method & path (Admin) | Body | Response |
| --- | --- | --- |
| `GET /admin/users?query=&role=&status=&cursor=&limit=` | — | page of `AdminUser` = `{id, email, displayName, roles, emailConfirmed, lockedOut, accountStatus: 'active'\|'pending_guardian'\|'deleted', isMinor, createdAt, lastActiveAt}` |
| `GET /admin/users/{id}` | — | `AdminUser` + `{courses: [{id, title, role}], classes: [{id, name, courseTitle}]}` |
| `PUT /admin/users/{id}/roles` | `{roles: ('Student'\|'Instructor'\|'Admin')[]}` (non-empty) | `AdminUser`; 409 `ROLE_SELF_DEMOTION` (removing your own Admin role), 409 `ROLE_LAST_ADMIN` |
| `POST /admin/users/{id}/lock` | `{minutes?: number}` (null = until unlocked) | 204; locking yourself → 409 `ROLE_SELF_DEMOTION` |
| `POST /admin/users/{id}/unlock` | — | 204 |
| `POST /admin/users/{id}/resend-verification` | — | 202 |
| `POST /admin/staff-invites` | `{email, role, courseId?}` | 201 `{id, email, role, courseId, expiresAt}` |
| `GET /admin/staff-invites` | — | `[{id, email, role, courseTitle, createdAt, expiresAt, status}]` |
| `DELETE /admin/staff-invites/{id}` | — | 204 |

Public: `GET /auth/staff-invites/{token}` (anonymous) → `{emailMasked, role, courseTitle, status}`; `POST /auth/staff-invites/{token}/accept` (signed in) → `Me`. `POST /auth/register` gains optional `staffInviteToken`. Every role, lock and invite action writes `audit_events` (`user.roles_changed` with before/after, `user.locked`, `staff_invite.created`, …).

### 11.3 Profile

`PUT /me/profile {displayName}` (1–60 chars) → `Me`.

### 11.4 Under-18 learners (India DPDP Act 2023, s.9 — verifiable guardian consent)

- `POST /auth/register` requires `dateOfBirth` (`YYYY-MM-DD`). Age < `Privacy:MinimumAge` (default 8) → 400 `AUTH_TOO_YOUNG`. Age < `Privacy:AgeOfMajority` (default 18) → `guardianEmail` is required and must differ from the learner's email (else 400 `VALIDATION_FAILED`).
- `users` gains `date_of_birth date null` (null for existing/seeded accounts = adult), `is_minor bool`, `guardian_email_normalized text null`, `guardian_consent_status text` (`not_required`/`pending`/`granted`/`declined`/`withdrawn`), `guardian_consent_at null`.
- `guardian_consents`: `id`, `user_id`, `guardian_email_normalized`, `token_hash`, `policy_version text`, `requested_at`, `expires_at` (7 days), `decided_at null`, `decision text null` (`granted`/`declined`/`withdrawn`), `ip_hash null`, `user_agent_hash null` — the verifiable consent record (long retention).
- Registering a minor sends the normal verification email to the learner **and** a consent email to the guardian with `${APP_BASE_URL}/consent/{token}`. Sign-in requires a confirmed email **and** consent `not_required` or `granted`; otherwise 403 `AUTH_GUARDIAN_CONSENT_PENDING` (or `AUTH_GUARDIAN_CONSENT_DECLINED`).
- `GET /guardian-consent/{token}` (anonymous) → `{learnerDisplayName, learnerEmailMasked, policyVersion, dataWeProcess: string[], status: 'pending'|'granted'|'declined'|'withdrawn'|'expired'}`.
- `POST /guardian-consent/{token}` `{decision: 'granted'|'declined'|'withdrawn'}` → 204. `declined`/`withdrawn` soft-delete the learner and emit the `user.deleted` outbox event. The email confirming `granted` contains the same link for later withdrawal.
- `POST /auth/resend-guardian-consent {email}` → 202 (always).
- `Me` gains `isMinor`. Sathi has no advertising or behavioural tracking; learning analytics are used only for tutoring.

### 11.5 Tutor: cancel, stale streams, history paging

- New message status **`cancelled`** and message error code **`STREAM_INTERRUPTED`**.
- `POST /conversations/{id}/messages/{messageId}/cancel` → 202 (idempotent; owner only, else 404). The API keeps an in-process registry of active runs (`messageId → CancellationTokenSource`). Cancel aborts the upstream request to the AI service, saves the text produced so far with status `cancelled`, completes `ai_runs` with status `cancelled`, and records usage for tokens already generated. If the run is not active on this instance and the message is still `streaming`, it is marked `cancelled` directly. (Cancel across several API instances needs a shared channel such as Redis pub/sub — documented for later.)
- The AI service stops the LLM stream promptly when .NET closes the connection (client disconnect) and records `model_runs.finish_reason = 'cancelled'`.
- Stale streams: an assistant message still `streaming` more than `Tutor:StaleStreamMinutes` (default 3) after creation is interrupted — `GET /conversations/{id}` returns and persists it as `failed` with `STREAM_INTERRUPTED`, and the recurring `RecoverStaleStreamsJob` does the same for all users and fails the matching `ai_runs`.
- `GET /conversations` uses cursor paging (§5); the UI loads more on demand.

### 11.6 Upload idempotency

`documents.idempotency_key text null` with unique (`owner_user_id`,`idempotency_key`) where not null; a repeated key returns the original document (no in-memory cache).

### 11.7 Service tokens: RS256 (replaces HS256 in §6)

- .NET (`api`, `jobs`) signs with an RSA private key: `ServiceToken__PrivateKeyPem` = base64 of a PKCS#8 PEM (2048-bit), `ServiceToken__KeyId` (e.g. `k1`); JWT header `alg=RS256`, `kid`.
- FastAPI verifies with `SERVICE_TOKEN_PUBLIC_KEYS` = comma-separated `kid:base64(SPKI PEM)` entries (e.g. `k1:BASE64,k0:BASE64`) to allow rotation. It accepts **only** RS256 and never holds a signing key.
- `.env`: `SERVICE_TOKEN_PRIVATE_KEY_PEM_B64`, `SERVICE_TOKEN_PUBLIC_KEY_PEM_B64`, `SERVICE_TOKEN_KEY_ID`; `SERVICE_TOKEN_SECRET` is removed. `scripts/generate-secrets.*` generate the key pair.

### 11.8 Object storage: per-service credentials (replaces root keys in §2)

`minio-init` creates two MinIO users with policies; apps never use the root account.

| User (env) | Used by | Policy on bucket `sathi-documents` |
| --- | --- | --- |
| `STORAGE_APP_ACCESS_KEY` / `STORAGE_APP_SECRET_KEY` | api, jobs | Get/Put/Delete on `uploads/*` and `lessons/*`; Delete on `parsed/*`; ListBucket |
| `STORAGE_AI_ACCESS_KEY` / `STORAGE_AI_SECRET_KEY` | ai-service, ai-ingest | Get on `uploads/*` and `lessons/*`; Get/Put/Delete on `parsed/*`; ListBucket |

### 11.9 OpenAPI contracts

- `contracts/openapi/api.v1.json` — generated from `Sathi.Api` at build time (built-in OpenAPI document generation); committed.
- `contracts/openapi/ai-internal.v1.json` — exported by `python -m app.export_openapi`; committed.
- CI fails when a generated file differs from the committed one, and runs a breaking-change diff (oasdiff) against the target branch.

### 11.10 Hangfire dashboard

`StatsPollingInterval = 5000` ms (live counters and realtime graph); a custom stylesheet limits both graphs to about 220 px high; a custom script adds an **Auto-refresh (10 s)** toggle to job list pages (on by default, remembered in `localStorage`, paused while the tab is hidden). The web app shows a **Hangfire jobs** sidebar item for Admins (opens `/hangfire` in a new tab).

### 11.11 New error codes

`CLASS_CODE_INVALID` (404), `CLASS_JOIN_DISABLED` (409), `CLASS_INVITE_EMAIL_MISMATCH` (403), `CLASS_INVITE_EXPIRED` (410), `COURSE_HAS_STUDENTS` (409), `COURSE_LAST_OWNER` (409), `USER_NOT_FOUND` (404), `USER_NOT_INSTRUCTOR` (409), `ROLE_SELF_DEMOTION` (409), `ROLE_LAST_ADMIN` (409), `STAFF_INVITE_INVALID` (410), `AUTH_TOO_YOUNG` (400), `AUTH_GUARDIAN_CONSENT_PENDING` (403), `AUTH_GUARDIAN_CONSENT_DECLINED` (403), `STREAM_INTERRUPTED` (message error code).
