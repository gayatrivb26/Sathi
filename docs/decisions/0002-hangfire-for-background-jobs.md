# 0002 — Hangfire (PostgreSQL storage) for background jobs; no RabbitMQ yet

- Status: Accepted
- Date: 2026-10-17
- Deciders: project owner
- Related: [contracts.md](../architecture/contracts.md) §3.3, §10; ADR-0001, ADR-0007

## Context and Problem Statement

Sathi has slow, scheduled, retryable or batch work: document ingestion, lesson indexing, short-answer grading, question generation, revision reminders, outbox delivery of deletions, nightly evaluation, retention cleanup and usage rollups. This work must not block user requests, must survive restarts, must retry with bounds, and must be traceable from a reference ID. What should run it?

## Decision Drivers

- No new infrastructure beyond Postgres for a one-person, local-first system.
- Persistence, retries with backoff, recurring schedules and an operator dashboard out of the box.
- Fits the .NET codebase (jobs reuse `Sathi.Core` domain code and EF Core).
- Trace continuity: jobs restore the originating `traceparent` and `run_id`.
- Isolation from API latency (separate process).
- Live tutor chat must never wait in a queue.

## Considered Options

1. Hangfire with `Hangfire.PostgreSql` in a separate `jobs` container.
2. RabbitMQ (with MassTransit) plus .NET consumers.
3. Python worker (Celery/arq/RQ) with Redis.
4. Custom Postgres-polling queue table.
5. Quartz.NET or plain `BackgroundService` + `Channel<T>`.

## Decision Outcome

Chosen option: **1 — Hangfire with PostgreSQL storage**.

- Storage: schema `hangfire`, owned by role `sathi_hangfire` (`SchemaName = "hangfire"`, `PrepareSchemaIfNecessary = true`). The API holds a client-only `BackgroundJobClient` on the same storage; only `Sathi.Jobs` runs a Hangfire server.
- Queues and workers: `critical` (grading, deletion/outbox) × 2, `default` (reminders, rollups, lesson indexing, evaluation, heartbeat) × 2, `ai-heavy` (document ingestion, question generation) × 1. Worker limits protect LLM rate limits, the spend cap and CPU on `ai-ingest`.
- Retries: `[AutomaticRetry(Attempts = 3, DelaysInSeconds = new[] {10, 60, 300})]` instead of Hangfire's default 10; per-job timeout through `CancellationToken`. After the last retry the job fails, the domain row (`ingestion_jobs`, `grading_results`, `ai_runs`) gets an error code and reference ID, and an alert fires.
- Arguments: IDs, `traceParent` and `runId` only — never learner content. Jobs are idempotent (e.g. `ingestion_jobs` unique on `document_id, document_version`; `/ingest/index` deletes then inserts chunks in one transaction).
- A server filter restores trace context and logs `job.state` (`created`, `processing`, `succeeded`, `failed`, `retrying`) with `job_id` and `attempt`.
- Dashboard at `/hangfire`, Admin role only (cookie shared via DataProtection keys, ADR-0008). Job history expires; the permanent record is `app.ai_runs` / `ai_run_steps`.
- **Chat is never a job.** A queue adds latency before the first token and needs a second channel to return tokens; chat streams directly over SSE (ADR-0007).

### What would trigger adding RabbitMQ (new ADR required)

Add a broker only when at least one of these is observed and documented:

- Several independent consumers need the same event (pub/sub fan-out), e.g. analytics, search indexing and notifications all reacting to `lesson.published`.
- A non-.NET consumer (the Python service) must consume work directly instead of being called over HTTP.
- Measured job throughput or Hangfire storage polling causes visible Postgres load or queue latency that tuning (poll interval, worker counts, indexes) cannot fix.
- Integration with external systems that publish or subscribe to messages.
- Need for broker features Hangfire lacks: message TTL/dead-letter routing per consumer, ordering guarantees per key, back-pressure across services.

### Consequences

- Good: zero new infrastructure; backups of Postgres include job state.
- Good: dashboard, retries and recurring jobs without custom code.
- Good: separate container keeps API latency unaffected by job load.
- Bad: jobs are .NET-only; Python work is triggered by HTTP calls from jobs to `ai-service`/`ai-ingest`, so the HTTP call timeout (`Ai__TimeoutSeconds=120`) must be less than the job timeout.
- Bad: at-least-once execution; every job must be idempotent and tested twice-run.
- Bad: Postgres-backed queue polling adds some DB load and pickup latency (acceptable for background work, unacceptable for chat — hence chat is not a job).
- Bad: dashboard history is not an audit trail; operators must use the run ledger.

### Confirmation

- Test: run the same `IngestDocumentJob` twice → no duplicate chunks.
- Test: kill `ai-ingest` during ingestion → 3 retries at 10/60/300 s, then `failed` with error code, alert and reference ID; nothing duplicated.
- Test: `/hangfire` returns 401/403 for a Student and for anonymous requests.
- Log check: a job's `job.state` lines share the originating `trace_id`.

## Pros and Cons of the Options

### 1. Hangfire + Postgres

- Good: mature, .NET-native, dashboard, recurring jobs, Postgres storage.
- Bad: .NET-only consumers; polling-based storage.

### 2. RabbitMQ + MassTransit

- Good: real broker semantics, fan-out, polyglot consumers.
- Bad: another stateful service to run, secure, back up and monitor; recurring jobs and a dashboard still need separate tooling; no current need.

### 3. Python worker + Redis

- Good: work runs next to the AI code.
- Bad: adds Redis and a second job system; .NET domain logic (mastery records, ingestion status) would be split across languages.

### 4. Custom Postgres queue

- Good: minimal dependencies.
- Bad: rebuilds retries, scheduling, locking and a dashboard by hand.

### 5. Quartz.NET / BackgroundService

- Good: lightweight.
- Bad: no built-in retry/backoff dashboard (Quartz) or no persistence at all (`Channel<T>`).

## Links

- Master spec §4, §22
- Hangfire documentation: https://docs.hangfire.io/
- Hangfire.PostgreSql: https://github.com/hangfire-postgres/Hangfire.PostgreSql
