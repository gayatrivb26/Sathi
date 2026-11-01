# Runbook — debug a failure from its reference ID

Target: from the reference ID a user quotes to the failing service, dependency call and reason in **under two minutes**, without reproducing the problem (master spec §7.8, §22).

Prerequisites: an Admin account; for steps 3–4 the observability profile (`scripts/up-observability.sh` / `.ps1`, Grafana at http://localhost:3000).

## The two-minute path

| # | Where | Do | You learn |
| --- | --- | --- | --- |
| 1 | User / support ticket | Get the **reference ID** shown in the error (e.g. `7F3A-91C2`), roughly when it happened, and what they were doing | Reference = first 8 hex chars of the trace ID |
| 2 | Sathi → **Admin** (`/admin`) → *Look up run* | Paste `7F3A-91C2` (also accepts `7F3A91C2`, a 32-hex trace ID or a run UUID). Backed by `GET /api/v1/admin/runs/lookup/{id}`, which also searches `ingestion_jobs.reference_id` | `ai_runs` row: type, status, `error_code`, `error_message`, model, tokens, cost, TTFT, latency; `ai_run_steps` (retrieve / web_search / llm / citation_check / grade / parse / index) with outcome and metrics; ingestion job (stage, attempt, Hangfire job ID); AI-service detail (`model_runs`, `retrieval_runs` with sources, `search_runs`) |
| 3 | Click **Open logs in Grafana** (`links.grafanaLogs`) — or Grafana → Dashboards → Sathi → **API & errors**, type `7F3A91C2` in *Reference / trace ID* | Read the lines top-down; filter `detected_level=error` | Every service's log lines for that trace (web, api, jobs, ai-service, ai-ingest) with `error_code`, exception type/message/stack |
| 4 | Click **View trace** on any line (derived field `trace_id` → Tempo) — or **Open trace** (`links.grafanaTrace`) | Look for the red span; open its attributes and events; *Logs for this span* jumps back to Loki | Which hop failed and how long each took (nginx → api → ai-service → LLM / DB / MinIO) |
| 5 | If the run was a job: **Open Hangfire job** (`links.hangfireJob`, `/hangfire/jobs/details/{id}`, Admin only) | Check *State history* and the exception per attempt | Retry history (3 attempts: 10 s, 60 s, 300 s), final exception |

Manual equivalents when Grafana is not running:

```bash
scripts/logs.sh --trace 7F3A-91C2            # bash: grep container stdout for trace_id prefix
.\scripts\logs.ps1 -Trace 7F3A-91C2          # PowerShell
```

LogQL used by the dashboard (paste into Grafana → Explore → Loki):

```logql
{service_name=~".+"} | trace_id=~"(?i)^7f3a91c2.*"
{service_name=~".+"} | trace_id="7f3a91c2e4b5d6a7b8c9d0e1f2a3b4c5" | detected_level="error"
{service_name=~"(.+/)?jobs"} |= "job.state" | job_id="1234"
```

SQL fallback (read-only, superuser session; see [backup-restore.md](backup-restore.md) for connecting):

```sql
SELECT id, type, status, error_code, error_message, hangfire_job_id, started_at, finished_at
FROM app.ai_runs WHERE reference_id = '7F3A91C2';
SELECT step, outcome, metrics FROM app.ai_run_steps WHERE run_id = '<run id>' ORDER BY started_at;
SELECT purpose, model, finish_reason, error_code, retries, fallback_used, latency_ms
FROM ai.model_runs WHERE run_id = '<run id>';
```

## Reading common outcomes

| `error_code` | Where to look next |
| --- | --- |
| `AI_SERVICE_UNAVAILABLE` | api span shows connection refused/reset to `ai-service:8000`; check `docker compose ps ai-service`, its logs around the time, OOM kills (`docker inspect … .State.OOMKilled`) |
| `LLM_TIMEOUT` / `LLM_RATE_LIMITED` / `LLM_UNAVAILABLE` | `llm.call` line: `retries`, `fallback_used`, provider status; Grafana *AI quality* dashboard error-rate panel |
| `LLM_REFUSED` | `finish_reason=refusal`, refusal category in `model_runs`; enable debug capture for that conversation only if needed |
| `LLM_DISABLED` / `SPEND_CAP_REACHED` | `AI_KILL_SWITCH`, `LLM_DAILY_SPEND_CAP_USD`; *LLM spend* panel |
| `RAG_NO_RESULTS` (warning) | `retrieval.run` with `empty=true`, `scope_size`; was the document `ready`? |
| `INGEST_PARSE_FAILED` / `INGEST_NO_TEXT` / `INGEST_UNSUPPORTED_TYPE` | `ingest.step` lines per attempt; `ingestion_jobs.error_message`; file type/size in the log, not its content |
| `SERVICE_TOKEN_INVALID` | ai-service log `internal` reason: unknown `kid` (signer's `SERVICE_TOKEN_KEY_ID` not in the verifier's `SERVICE_TOKEN_PUBLIC_KEYS`), signature mismatch (private and public key in `.env` are not one pair — regenerate both with `scripts/generate-secrets.* --add-missing` after deleting both lines), wrong algorithm, or clock skew. Never paste key values into tickets |
| `STREAM_INTERRUPTED` | The assistant message was still `streaming` after `Tutor:StaleStreamMinutes` — the API process that owned the stream died or was restarted. See [Cancelled and interrupted answers](#cancelled-interrupted) |
| `STORAGE_UNAVAILABLE` / S3 `AccessDenied` | Wrong storage user or prefix: api/jobs use `STORAGE_APP_*`, ai uses `STORAGE_AI_*`; check `docker compose logs minio-init` and the policy table in ADR-0016 |

<a id="cancelled-interrupted"></a>
### Cancelled and interrupted answers (`cancelled`, `STREAM_INTERRUPTED`)

Two different outcomes of a tutor run ([ADR-0017](../decisions/0017-tutor-cancellation-and-stale-stream-recovery.md)):

| Message status | `ai_runs.status` / `error_code` | Meaning | Action |
| --- | --- | --- | --- |
| `cancelled` | `cancelled` | The learner pressed **Stop** (`POST …/messages/{id}/cancel`). Partial text is saved; usage counts only generated tokens; `ai.model_runs.finish_reason = 'cancelled'` | None — expected. Repeated cancels right after start may point to slow TTFT (*AI quality* dashboard) |
| `failed` | `failed` / `STREAM_INTERRUPTED` | The stream had no owner any more (API crash, OOM kill, deploy/restart) and was swept after `Tutor:StaleStreamMinutes` (3) — on the next `GET /conversations/{id}` or by `RecoverStaleStreamsJob` (every 5 min) | Find why the API stopped (below). The learner can resend |

Find out what happened to an interrupted run:

1. Look up its reference ID (step 2 above): `started_at`, last `ai_run_steps`, `finished_at` set by the sweep.
2. Did the API restart around `started_at`? `docker compose ps api` (uptime), `docker inspect --format '{{.RestartCount}} {{.State.OOMKilled}}' $(docker compose ps -q api)`, and `job.state` lines of `RecoverStaleStreamsJob`.
3. In Tempo the api span of the stream ends abruptly with no `done` event; the ai-service span shows a client disconnect.

```sql
-- runs swept as interrupted in the last day, and who cancelled what
SELECT status, error_code, count(*) FROM app.ai_runs
WHERE type = 'chat' AND started_at > now() - interval '1 day' GROUP BY 1, 2 ORDER BY 3 DESC;
SELECT id, conversation_id, created_at FROM app.messages
WHERE status = 'streaming' AND created_at < now() - interval '3 minutes';   -- should be empty after the next sweep
```

A cancel that "does nothing" usually means the request reached an API instance that does not own the run (only possible with more than one `api` replica — not supported yet) or the run had already finished (cancel is idempotent and returns 202 either way).

<a id="api-errors"></a>
### API 5xx alert (`ApiHighErrorRate`)

Grafana → *API & errors* → *5xx by route* → pick the route → *Errors and warnings* logs panel → open one trace. Correlate with deploys (`version` field) and dependency health (`/health/ready`).

<a id="hangfire-job"></a>
### Job failed after all retries (`HangfireJobsFailing`)

*Jobs & ingestion* dashboard → *Job state transitions* (`job.state`, `state=failed`) → `job_id` → Hangfire dashboard details → the job's `traceParent` argument gives the originating trace.

<a id="ingestion-failure"></a>
### Ingestion failure (`IngestionFailures`)

The user sees *Failed* with a reference ID and Retry on **My notes**. Look it up as above; `ingestion_jobs.attempt`, `stage` and `error_code` explain it. Retry (`POST /api/v1/documents/{id}/retry`) creates a new attempt for the same version — safe, never duplicates chunks.

## Drills (run weekly; record results in the PR or a learning note)

Run against the dev stack with the observability profile. Use `LLM_PROVIDER=fake` unless the drill is about the provider.

### D1 — Kill the AI service mid-stream (§7.8)

1. Ask the tutor a question; while tokens stream: `docker compose kill ai-service`.
2. **Expect:** the chat shows a friendly error with a reference ID (SSE `error` `AI_SERVICE_UNAVAILABLE`); the assistant message is saved `partial` or `failed`; `ai_runs.status=failed` with `error_code`.
3. Follow the reference ID: one trace shows the api → ai-service span ending in error at the kill time.
4. `docker compose start ai-service`; `api` `/health/ready` recovers.

### D2 — Force an ingestion parse failure (§7.8)

1. Create a file with a `.pdf` extension and valid magic bytes but a corrupt body: `printf '%%PDF-1.7\n%%garbage' > broken.pdf`; upload it on **My notes**.
2. **Expect:** status *Failed*, `INGEST_PARSE_FAILED`, reference ID; `ingestion_jobs.attempt` shows the retries; `job.state` lines show `retrying` ×2 then `failed`; alert `IngestionFailures` fires in Prometheus (http://localhost:9090/alerts).
3. Explain the failure from logs and the ledger only — never open the file.

### D3 — Seeded secret never logged (§7.8)

1. `curl -s -X POST http://localhost:8080/api/v1/auth/login -H 'Content-Type: application/json' -d '{"email":"canary@sathi.local","password":"CANARY-9f8e7d6c5b4a"}'` (expect 400 CSRF or 401).
2. `scripts/logs.sh | grep -c CANARY-9f8e7d6c5b4a` → **0**; in Grafana Explore `{service_name=~".+"} |= "CANARY-9f8e7d6c5b4a"` → no lines; also search for `canary@sathi.local` → no lines (emails are masked).
3. CI repeats this automatically for every generated secret (`stack` job).

### D4 — Browser disconnect mid-answer (§22)

1. Start a long tutor answer; close the tab (or kill the `curl -N` client) after the first tokens.
2. Reopen the conversation after ~30 s. **Expect:** the full assistant message (`status=complete`) and a completed `ai_runs` row with tokens, cost, TTFT and latency — .NET kept consuming the upstream stream.

### D5 — Kill the AI service during ingestion (§22)

1. Upload a large document; during *Indexing* run `docker compose kill ai-ingest`.
2. **Expect:** the job retries up to 3 attempts, then fails with an error code, the `IngestionFailures` alert and a visible reference ID. `docker compose start ai-ingest` and press Retry: the document becomes *Ready* and `SELECT count(*) FROM ai.document_chunks WHERE document_id = …` equals `passage_count` — no duplicates.

### D6 — Same ingestion job twice (§22)

Trigger Retry on a *Ready* document (or re-enqueue the job from the Hangfire dashboard). **Expect:** chunk count unchanged (delete-then-insert per document version).

### D8 — Stop an answer and recover a stuck stream (ADR-0017)

1. Ask a long question and press **Stop** after the first tokens. **Expect:** message `cancelled` with the partial text, `ai_runs.status=cancelled`, `model_runs.finish_reason=cancelled`, usage > 0 but smaller than a full answer.
2. Ask again and, while streaming, `docker compose restart api`. Wait `Tutor:StaleStreamMinutes` (3 min) and reopen the conversation. **Expect:** message `failed` with `STREAM_INTERRUPTED` and a reference ID; within 5 minutes `RecoverStaleStreamsJob` has also failed the `ai_runs` row.

### D7 — Reference ID to everything in < 2 minutes (§22)

Time steps 1–5 above from a fresh reference ID produced by D1 or D2. Record the time. If it takes longer, fix the gap (missing link, missing field) and update this runbook.
