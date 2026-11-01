# 0010 — Observability: OpenTelemetry → Collector → Tempo, Loki, Prometheus → Grafana

- Status: Accepted
- Date: 2026-10-17
- Deciders: project owner, DevOps engineer
- Related: [contracts.md](../architecture/contracts.md) §1, §4, §8; ADR-0002, ADR-0005

## Context and Problem Statement

Any problem a user reports must be traceable from the reference ID on screen to the exact request, service, dependency call and failure reason within minutes, without reproducing it (master spec §7). Signals come from Nginx, .NET (`api`, `jobs`), Python (`ai-service`, `ai-ingest`) and Postgres. Locally the stack runs on Docker Compose; production is not yet chosen and may be a managed backend. Which telemetry pipeline and backends do we use?

## Decision Drivers

- One trace across browser → Nginx → .NET → FastAPI → LLM/DB, and logs linked to that trace.
- Vendor-neutral instrumentation so production can change backend without code changes.
- A central place to redact sensitive attributes.
- Free, local, production-like stack that fits in developer RAM.
- Bounded storage: explicit sampling and retention per environment.

## Considered Options

1. OpenTelemetry SDKs → OTel Collector → Tempo (traces), Loki 3 (logs, native OTLP), Prometheus (metrics) → Grafana.
2. Elastic stack (Elasticsearch, Kibana, APM).
3. Managed SaaS from day one (Grafana Cloud, Azure Monitor/Application Insights, Datadog) with vendor SDKs.
4. Logs only (stdout + `docker logs`), no tracing.

## Decision Outcome

Chosen option: **1 — OTel SDKs and Collector with Tempo, Loki, Prometheus and Grafana** (Compose `observability` profile; network `observability`).

- **Instrumentation:** OpenTelemetry SDKs in .NET (ASP.NET Core, HttpClient, EF Core/Npgsql, Hangfire filter) and Python (FastAPI, httpx, SQLAlchemy/psycopg). Serilog/structlog JSON to stdout always; OTLP export when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Propagation:** W3C `traceparent` created by the Angular interceptor and forwarded by Nginx; Nginx sets `X-Request-Id`. Jobs receive `traceParent` as an argument. Reference ID = first 8 hex chars of the trace ID.
- **Collector pipeline:** `otlp` receiver → `memory_limiter` → **attributes/redaction processor** (deletes or hashes keys matching `password|secret|token|authorization|cookie|api[_-]?key|email`, masks email/bearer/`sk-` patterns) → `batch` → exporters (Tempo via OTLP, Loki via native OTLP endpoint, Prometheus via remote-write or scrape). App-level redaction remains the first layer; the collector is defence in depth.
- **Loki labels:** only low-cardinality resource attributes (`service`, `env`, `level`); `trace_id`, `request_id`, `user_id_hash`, `run_id` are structured metadata, not labels.
- **Grafana:** provisioned data sources with trace→logs (Tempo → Loki by `trace_id`) and logs→trace (derived field on `trace_id`) links, metric exemplars → traces; dashboards for API latency/errors, AI TTFT/latency, tokens and cost, retrieval quality, queue depth and job failures, grading routing. Alert rules for error rate, p95 latency, queue age, daily spend, failed ingestion and LLM error rate.

**Sampling:**

| Environment | Policy |
| --- | --- |
| development, test | 100% (`parentbased_always_on`) |
| staging | 100%, or head-sampled 50% if volume demands |
| production | head sampling `parentbased_traceidratio` 10–20% **plus** collector tail sampling that keeps 100% of traces with errors, with `ai_runs` failures, or slower than 2 s. Tail sampling requires all spans of a trace on one collector instance (single collector, or a load-balancing exporter tier). Logs are not sampled. |

**Retention (proposed defaults, tuned per environment):**

| Signal | Local/dev | Production |
| --- | --- | --- |
| Logs (Loki) | 7 days | 30 days |
| Traces (Tempo) | 3 days | 14 days |
| Metrics (Prometheus) | 15 days | 90 days (longer via downsampled remote storage if needed) |
| Audit events (`app.audit_events`, DB) | long retention, not in the telemetry stack | long retention |
| Debug captures (`ai.debug_captures`, DB) | 72 h | 72 h |

Container log rotation (Docker `json-file` `max-size`/`max-file`) bounds stdout logs.

**Portability:** moving to a managed backend changes only collector exporters and credentials — e.g. `azuremonitor` exporter for Azure Monitor/Application Insights, or OTLP/HTTP with basic auth to Grafana Cloud (Tempo, Loki, Mimir). Application code, SDK configuration and the log schema do not change.

### Consequences

- Good: one reference ID leads to the trace, logs and run ledger; same pipeline locally and in production.
- Good: vendor-neutral; redaction centralised; sampling and retention controlled in one place.
- Bad: five extra containers locally (RAM); run them only via the profile.
- Bad: tail sampling adds collector memory and a stateful routing constraint.
- Bad: self-hosting in production would add backup/upgrade work; managed backends are preferred there.

### Confirmation

- Debuggability drill (master spec §7.8): kill the AI service during a stream; from the UI reference ID reach the Tempo trace and Loki logs in under 2 minutes (documented in `docs/runbooks/debugging.md`).
- Test: a seeded secret in a request body appears in no Loki line and no span attribute.
- Test: a job's `job.state` logs carry the same `trace_id` as the originating request.

## Pros and Cons of the Options

- **1. OTel + Grafana stack** — Good: open, portable, production-like, trace↔logs links. Bad: several components to run locally.
- **2. Elastic** — Good: powerful search. Bad: heavy RAM, licence considerations, less natural OTLP-first workflow.
- **3. Managed SaaS now** — Good: no ops. Bad: cost and data egress during development, account dependency in CI, vendor SDK lock-in if not OTLP.
- **4. Logs only** — Good: trivial. Bad: cannot meet the "reference ID to failure point" goal across services.

## Links

- OpenTelemetry Collector: https://opentelemetry.io/docs/collector/
- Loki OTLP ingestion: https://grafana.com/docs/loki/latest/send-data/otel/
- Tempo: https://grafana.com/docs/tempo/latest/
- Master spec §7
