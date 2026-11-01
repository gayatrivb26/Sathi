# Troubleshooting

Start with `docker compose ps -a` (state + health of every container) and `scripts/logs.sh <service>` (or `.\scripts\logs.ps1 <service>`). For a user-reported error with a reference ID, use [debugging.md](debugging.md) instead.

## Stack does not start

| Symptom | Cause | Fix |
| --- | --- | --- |
| `required variable X is missing a value` | No `.env`, or a key missing | `scripts/generate-secrets.sh` (new checkout) or copy the missing key from `.env.example` |
| `api`/`jobs` stay *Created*, `dependency failed to start` | A dependency is unhealthy or a migrator exited non-zero | `docker compose ps -a`; `docker compose logs migrator-app migrator-ai postgres` |
| `postgres` unhealthy for minutes on first start | `initdb` + init script still running (slow disks / busy laptop); health check uses TCP on purpose so it stays unhealthy until init has finished | Wait (start period 120 s); check `docker compose logs postgres` for `sathi-init: done` |
| `password authentication failed for user "sathi_app"` | `.env` was regenerated after the Postgres volume was created — role passwords live in the volume | Restore the old `.env`, or `scripts/reset-db.sh` (destroys local data) |
| `permission denied for schema app` / `ai` | A service is using the wrong role (cross-schema access is denied by design) | Check `ConnectionStrings__App` / `DATABASE_URL`; never grant cross-schema access without an ADR |
| `minio-init` fails | MinIO not ready, wrong root credentials, or missing/invalid `STORAGE_APP_*` / `STORAGE_AI_*` (empty, equal to the root user, secret < 8 chars) | `docker compose logs minio minio-init`; root credentials come from `MINIO_ROOT_USER/PASSWORD`; add missing storage users with `scripts/generate-secrets.sh --add-missing` |
| `AccessDenied` from storage in api/jobs/ai logs | The service uses a key outside its policy (ADR-0016), e.g. writing `parsed/` from api or `uploads/` from ai, or creating the bucket | Fix the code path or extend the policy file in `infrastructure/docker/minio/` in the same change (and the ADR); re-run `docker compose up minio-init` |
| `required variable SERVICE_TOKEN_PRIVATE_KEY_PEM_B64 / STORAGE_APP_ACCESS_KEY … is missing` | `.env` predates Release 2 | `scripts/generate-secrets.sh --add-missing` (keeps existing values), then `docker compose up -d --build` |
| Port already allocated (8080, 5432, 3000…) | Another process/stack uses it | Set `WEB_PORT` in `.env`; stop the other stack; dev ports are bound to 127.0.0.1 in `compose.override.yaml` |
| Shell script fails with `$'\r': command not found` | Checked out with CRLF line endings | `.gitattributes` enforces LF for `*.sh`; run `git add --renormalize . && git checkout -- .` |
| Everything slow / OOM kills | Machine below ~8 GB free for Docker | Start without the observability profile; give Docker Desktop more memory; `docker stats` |

## Web / browser

| Symptom | Cause | Fix |
| --- | --- | --- |
| 503 JSON `Service temporarily unavailable` on `/api/...` | nginx cannot resolve/reach `api` (restarting, crashed) | `docker compose ps api`, `docker compose logs api`; nginx keeps serving the SPA meanwhile |
| 429 `RATE_LIMITED` on sign-in | Edge limit: 20 POST/min per IP on `/api/v1/auth/` (burst 10) or 30/min on `/api/v1/client-errors`; the API adds its own 10/min | Wait a minute; for shared IPs (schools) raise the nginx zone rate |
| 400 `CSRF_INVALID` | Missing `X-XSRF-TOKEN` header; Angular only adds it for relative URLs | Call `/api/...` relatively; `GET /api/v1/auth/csrf` on startup and after login/logout |
| Styles missing in production build, CSP error in console | Inline script/style not allowed by CSP | The CSP allows inline styles and the hash of Angular's `onload="this.media='all'"`; any other inline script must be removed or its hash added in `infrastructure/nginx/default.conf` |
| Tutor answer arrives all at once | A proxy buffers SSE | The stream location sets `proxy_buffering off` and disables gzip; check any extra proxy/LB in front (e.g. disable response buffering on the platform ingress) |

<a id="slow-api"></a>
## Slow API (`ApiHighLatencyP95`)

Grafana *API & errors* → *Slowest routes* → open a slow trace. Look for DB spans (slow-query log `log_min_duration_statement=500` in `docker compose logs postgres`), lock waits (`log_lock_waits=on`), connection pool saturation warnings, or calls to the AI service on a non-streaming route.

<a id="slow-tutor"></a>
## Slow tutor (`TutorTimeToFirstTokenP95High`, `RetrievalLatencyP95High`)

*AI quality* dashboard: compare TTFT with retrieval latency and LLM latency. Retrieval slow → HNSW index present? (`\d ai.chunk_embeddings`), `EXPLAIN ANALYZE` the hybrid query, scope too large. LLM slow → provider status, effort level (`low` for chat), prompt size (`input_tokens` in `llm.call`). Web search adds a search + page fetch before generation.

<a id="llm-errors"></a>
## LLM errors (`LlmHighErrorRate`)

`{service_name=~"(.+/)?ai-service"} |= "llm.call" | detected_level=~"warn|error"`. `rate_limited` → lower concurrency / ask for higher limits; `timeout` → provider latency, `Ai__TimeoutSeconds`; `refused` → check refusal categories; `disabled` → `AI_KILL_SWITCH=true`. To stop all LLM traffic immediately: set `AI_KILL_SWITCH=true` in `.env` and `docker compose up -d ai-service ai-ingest`.

<a id="llm-spend"></a>
## LLM spend (`LlmDailySpendNearCap`, `LlmDailySpendCapReached`)

At `LLM_DAILY_SPEND_CAP_USD` the AI service fails calls with `SPEND_CAP_REACHED`. Find heavy users/routes in `app.usage_records` and `ai.model_runs` (`purpose`, `input_tokens`). Raise the cap only deliberately; per-user quotas are `Quotas__*`.

<a id="web-search"></a>
## Web search (`WebSearchFailing`)

Answers continue without web sources (`WEB_SEARCH_FAILED` warning). Check `SEARCH_PROVIDER`, the API key, provider status and `WEB_SEARCH_DAILY_SPEND_CAP_USD`. `SEARCH_PROVIDER=none` disables it cleanly.

<a id="jobs-stuck"></a>
## Jobs stuck (`HangfireQueueBacklog`)

`/hangfire` → *Servers* (is the jobs host alive?) and *Enqueued* per queue. Worker counts: critical 2, default 2, ai-heavy 1. A long ai-heavy job blocks the next one by design (protects the LLM rate limit and CPU). `docker compose restart jobs` is safe — jobs are idempotent and re-queued.

<a id="grading"></a>
## Grading review rate high (`GradingReviewRateHigh`)

More than half of short answers go to instructors. Check rubric quality for the affected questions and the `Grading__AutoAcceptConfidence` threshold (default 0.75); compare with instructor agreement before lowering it.

<a id="observability"></a>
## Observability stack

| Symptom | Fix |
| --- | --- |
| No logs/traces in Grafana | Was the stack started with `scripts/up-observability.*` (sets `OTEL_EXPORTER_OTLP_ENDPOINT`)? `docker compose logs otel-collector`; Prometheus target `otel-collector` up? |
| Loki `empty ring` errors right after start | Loki still starting; wait for `/ready` (health check) |
| Tempo `permission denied` on `/var/tempo` | `tempo-init` fixes volume ownership; `docker compose --profile observability up -d tempo-init tempo` |
| Metric missing or named `…_milliseconds_…` | Instrument unit: use `{ms}` / `{USD}` annotation units for `sathi.*` instruments (see [logging.md §8](../architecture/logging.md#8-metrics)) |
| Grafana asks for a login in dev | Only `compose.override.yaml` enables anonymous admin; with `-f compose.yaml` use `GRAFANA_ADMIN_USER/PASSWORD` from `.env` |
| Validate configs | `scripts/check-monitoring.sh` (compose, promtool rules + unit tests, otelcol validate, nginx -t) |
