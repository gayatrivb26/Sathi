# Logging, tracing and metrics

Goal (master spec §7): any problem a user reports is traceable from the **reference ID** on their screen to the exact request, service, dependency call and failure reason within minutes, without reproducing it. This page is the single log schema for every service; [contracts.md §8](contracts.md#8-logging-contract) is the binding summary.

## 1. Pipeline

```
service ── JSON to stdout (always) ──► docker json-file (10 MB × 3 per container)
        └─ OTLP gRPC (when OTEL_EXPORTER_OTLP_ENDPOINT is set) ──► otel-collector
              memory_limiter → attributes/redact → transform/redact → tail_sampling (traces) → batch
              ├─ traces  ──► Tempo        (OTLP)
              ├─ logs    ──► Loki 3       (native OTLP, /otlp)
              └─ metrics ──► Prometheus   (collector prometheus exporter :8889, scraped)
Grafana: Loki ⇄ Tempo links (trace_id), Prometheus exemplars → Tempo
```

`OTEL_EXPORTER_OTLP_ENDPOINT` is **empty by default** (`.env.example`): services must start and log to stdout without a collector. `scripts/up-observability.(sh|ps1)` sets it to `http://otel-collector:4317` and starts the `observability` profile. Production swaps only the collector exporters (ADR 0010).

## 2. The log schema

One JSON object per line. Field names are identical in .NET (Serilog, renamed fields) and Python (structlog).

| Field | Required | Example | Notes |
| --- | --- | --- | --- |
| `timestamp` | yes | `2026-10-17T10:21:13.604Z` | ISO-8601 UTC |
| `level` | yes | `info` | `debug` / `info` / `warning` / `error` |
| `message` | yes | `LLM call completed` | Human sentence, no user content |
| `event` | business events | `llm.call` | Dotted lowercase; `EventId.Name` in .NET |
| `service` | yes | `api` | `web` / `api` / `jobs` / `ai-service` / `ai-ingest` |
| `env` | yes | `production` | from `SATHI_ENV` |
| `version` | yes | `0.1.0` | from `SATHI_VERSION` |
| `trace_id` | yes | `7f3a91c2e4b5…` (32 hex) | W3C trace; first 8 hex = reference ID |
| `span_id` | yes | `1a2b3c4d5e6f7a8b` | |
| `request_id` | yes | `65c9ed5e…` | `X-Request-Id` set by nginx if absent |
| `user_id_hash` | when known | `9c1f0a2b3d4e5f60` | `HMAC-SHA256(LOG_HASH_SALT, lower(user_id))[:16]` |
| `conversation_id`, `document_id`, `run_id`, `job_id`, `attempt` | contextual | | IDs only |
| `error_code` | on failures | `LLM_TIMEOUT` | Stable code from [contracts §4.2](contracts.md#42-error-codes) |
| `exception_type`, `exception_message`, `stack` | errors only | | Logged once, at the handling boundary |
| `duration_ms` | timed ops | `412` | |

Nginx writes the same core fields (`service=web`, `event=http.request`, `request_id`, `trace_id`, `http_*`) but its timing field is `request_time_s` (seconds) and it logs `$uri` only — never the query string, which can carry verification/reset tokens.

### AI-specific events (master spec §7.3)

| `event` | Fields |
| --- | --- |
| `llm.call` | `provider, model, prompt_name, prompt_hash, params, input_tokens, output_tokens, cost_usd, ttft_ms, latency_ms, retries, finish_reason, error_code, fallback_used` |
| `retrieval.run` | `query_hash, method, scope_size, top_k, chunk_ids, scores, timings, empty` |
| `web_search.run` | `query_hash, provider, result_count, urls, latency_ms, cache_hit, quota_remaining, error_code` |
| `citation.check` | `citations_valid, citations_dropped, dropped_reasons` |
| `ingest.step` | `document_id, document_version, step, attempt, duration_ms, outcome, error_code` |
| `job.state` | `job_id, job_type, queue, state (created/processing/succeeded/failed/retrying), attempt, retry_reason` |
| `grading.routed` | `question_id, rubric_version, confidence, route (auto_accepted/needs_review)` |
| `auth.login_failed` | `user_id_hash` if the account exists, `reason`, never the email |
| `client.error` | `kind, route, app_version, status, source=web` (from `POST /api/v1/client-errors`) |

## 3. Level policy

| Level | Use for | Production default |
| --- | --- | --- |
| `error` | A request or job **failed** and someone should look (final job failure, unhandled exception, 5xx) | on |
| `warning` | Degraded but recovered: retry, fallback model used, `WEB_SEARCH_FAILED`, `RAG_NO_RESULTS`, client errors | on |
| `info` | Business events and lifecycle (`llm.call`, `job.state`, startup, migrations) | on |
| `debug` | Detail for diagnosis | **off**; switch at runtime: AI service `PUT /internal/v1/admin/log-level`; .NET via configuration reload |

Rules: log each failure **once**, at the boundary that handles it (the code that turns it into a ProblemDetails, an SSE `error` or a failed job), with exception type, message, stack and the IDs/sizes/config needed to reproduce — not the learner's content. Lower layers add context and rethrow.

## 4. Error codes

The full list is in [contracts §4.2](contracts.md#42-error-codes). Every error response is RFC 9457 ProblemDetails with `code`, `traceId` and `referenceId`; the UI shows `referenceId` (`XXXX-XXXX`). Nginx itself only produces `RATE_LIMITED` (429) and, when `api`/`jobs` are unreachable, a 503 ProblemDetails with `code=INTERNAL_ERROR` plus `traceId`/`requestId`.

## 5. Redaction

Never log: passwords, tokens, cookies, API keys, raw emails, raw user IDs, document text, prompts, model answers, learner answers.

Three layers:

1. **In each service** (authoritative): a redaction processor masks values whose key matches `password|secret|token|authorization|cookie|api[_-]?key|email` and string values matching email / `Bearer …` / `sk-…` patterns. Unit tests seed a known secret in a request body and assert it never appears in captured logs.
2. **In the collector** (`infrastructure/monitoring/otel-collector/config.yaml`): deletes sensitive attributes (`http.request.header.authorization`, `cookie`, `set-cookie`, `x-xsrf-token`, `user.email`, `enduser.id`, `db.query.parameters`, `gen_ai.prompt`, …), masks email / bearer / `sk-` patterns in log bodies and attributes, strips `token|code|password|secret|key` query parameters from `url.*`, and drops attributes whose key is exactly a secret name (so `input_tokens` survives). Verified locally: a log body containing an email, a bearer token and an `sk-` key arrived in Loki as `[REDACTED_EMAIL] … Bearer [REDACTED] … [REDACTED_KEY]`, and a `password` attribute was dropped.
3. **In CI** (`stack` job): every generated secret from `.env` is grepped for in all container logs; a hit fails the build.

Postgres: `log_min_duration_statement` logs slow statements verbatim, so the init script disables statement logging for its own session (an `ALTER ROLE … PASSWORD` would otherwise be logged on a slow machine — found during local verification). Application SQL uses parameters, which are not logged.

## 6. Debug capture

Off by default. An Admin enables it per conversation with `PUT /api/v1/admin/debug-capture/{conversationId}` `{enabled, hours ≤ 24}`, which writes an `audit_events` row (`debug_capture.enable`) and tells the AI service (`PUT /internal/v1/admin/debug-capture`). While active, full prompts and responses for that conversation are stored in `ai.debug_captures` (restricted table, never in logs) and expire after **72 h** (`RetentionCleanupJob`). Use it only to reproduce a reported answer-quality problem; tell the user when policy requires it.

## 7. Retention and sampling

| Signal | Development | Test / CI | Production rehearsal (`compose.prod.yaml`) | Production target |
| --- | --- | --- | --- | --- |
| Container stdout (json-file) | 10 MB × 3 per container | same | same | Platform log store (e.g. Log Analytics) 30 d |
| Loki logs | 7 d (`LOKI_RETENTION_PERIOD=168h`) | not running | 30 d (`720h`) | 30 d hot; security/audit export 1 y |
| Tempo traces | 72 h | not running | 7 d | 7–14 d |
| Prometheus metrics | 15 d | not running | 15 d | 30–90 d (managed) |
| `app.audit_events` | DB | DB | DB | long (≥ 1 y, legal review) |
| `ai.debug_captures` | 72 h | 72 h | 72 h | 72 h |
| `app.ai_run_steps.metrics` | 90 d | — | 90 d | 90 d |
| Hangfire job history | Hangfire default expiry | — | same | same (ledger is the permanent record) |

**Trace sampling** happens in the collector (`tail_sampling`), so a whole trace is kept or dropped together: every trace with an error status and every trace slower than 2 s is **always kept**; the rest is sampled at `TRACE_SAMPLE_PERCENT` (100 in dev, 20 in the production rehearsal). SDKs use `parentbased_always_on` so the decision is made once, centrally. Logs and metrics are not sampled — every log line keeps its `trace_id`, so a reference ID is always findable in Loki even when its (successful, fast) trace was sampled out.

## 8. Metrics

Exported via OTLP and exposed by the collector's Prometheus exporter with unit/type suffixes added. Names below are the **Prometheus** names that dashboards and `infrastructure/monitoring/prometheus/alerts.yml` use.

| Prometheus name | Type | Labels | Emitted by |
| --- | --- | --- | --- |
| `http_server_request_duration_seconds` | histogram | `http_route`, `http_request_method`, `http_response_status_code` | api, jobs, ai (OTel semantic conventions) |
| `sathi_tutor_ttft_ms` | histogram | | api |
| `sathi_ai_cost_usd_total` | counter | `type` (optional) | api |
| `sathi_ingestion_failures_total` | counter | `error_code` | jobs |
| `sathi_grading_routed_total` | counter | `route` = `auto_accepted` / `needs_review` | jobs / api |
| `sathi_jobs_failed_total` | counter | `queue`, `job_type` | jobs (final failure only) |
| `sathi_jobs_queue_oldest_age_seconds` | gauge | `queue` | jobs |
| `sathi_llm_calls_total` | counter | `outcome` = `ok` / `timeout` / `rate_limited` / `refused` / `error` / `disabled` | ai-service |
| `sathi_llm_latency_ms` | histogram | | ai-service |
| `sathi_retrieval_latency_ms` | histogram | | ai-service |
| `sathi_web_search_total` | counter | `outcome` = `ok` / `empty` / `failed` / `skipped` | ai-service |

**Instrument naming rule (verified against the collector):** the exporter appends the unit to the name. An OTel histogram named `sathi.tutor.ttft_ms` with unit `ms` becomes `sathi_tutor_ttft_ms_milliseconds_*` (wrong); with unit `{ms}` (or no unit) it becomes `sathi_tutor_ttft_ms_*` (right). Use annotation units (`{ms}`, `{USD}`, `{call}`) for the custom `sathi.*` instruments; keep real units (`s`) for semantic-convention instruments such as `http.server.request.duration`. Counters get `_total` automatically. The `job` label is the OTel `service.name` (prefixed by `service.namespace/` if one is set); queries use `job=~"(.+/)?api"`.
