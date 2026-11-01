# Architecture Decision Records

Significant, hard-to-reverse choices for Sathi are recorded here in [MADR](https://adr.github.io/madr/) format. The system contract is [../architecture/contracts.md](../architecture/contracts.md); the threat model is [../architecture/threat-model.md](../architecture/threat-model.md).

## Index

| # | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-modular-monolith-and-separate-ai-service.md) | Modular monolith (.NET) plus a separate AI service (Python) | Accepted | 2026-10-17 |
| [0002](0002-hangfire-for-background-jobs.md) | Hangfire (PostgreSQL storage) for background jobs; no RabbitMQ yet | Accepted | 2026-10-17 |
| [0003](0003-postgres-pgvector-hybrid-search-rrf.md) | PostgreSQL + pgvector hybrid search fused with Reciprocal Rank Fusion | Accepted | 2026-10-17 |
| [0004](0004-embedding-model-bge-small-fastembed.md) | Local embeddings: `BAAI/bge-small-en-v1.5` via fastembed | Accepted | 2026-10-17 |
| [0005](0005-llm-claude-behind-llmprovider.md) | Hosted LLM: Claude behind an `LlmProvider` interface | Accepted | 2026-10-17 |
| [0006](0006-web-search-tavily-behind-searchprovider.md) | Web search: Tavily behind a `SearchProvider` interface | Accepted | 2026-10-17 |
| [0007](0007-sse-over-signalr.md) | Server-Sent Events (fetch + ReadableStream) for tutor streaming, not SignalR | Accepted | 2026-10-17 |
| [0008](0008-cookie-auth-antiforgery-same-origin.md) | Same-origin cookie authentication with antiforgery | Accepted | 2026-10-17 |
| [0009](0009-hs256-short-lived-service-token.md) | HS256 short-lived service token for .NET → AI service calls | Superseded by [0015](0015-rs256-service-tokens.md) | 2026-10-17 |
| [0010](0010-observability-stack-otel-loki-tempo-prometheus-grafana.md) | Observability: OpenTelemetry → Collector → Tempo, Loki, Prometheus → Grafana | Accepted | 2026-10-17 |
| [0011](0011-github-actions-ci.md) | GitHub Actions for CI (not Azure DevOps) | Accepted | 2026-10-17 |
| [0012](0012-course-access-public-private-courses-and-classes.md) | Course access through public/private courses and classes (join codes, email invites) | Accepted | 2026-10-22 |
| [0013](0013-roles-self-registration-student-only-staff-invites.md) | Roles: self-registration is Student-only; staff roles granted by admins or staff invites | Accepted | 2026-10-22 |
| [0014](0014-under-18-learners-verifiable-guardian-consent.md) | Under-18 learners: verifiable guardian consent (DPDP Act 2023, s.9) | Accepted (legal review pending) | 2026-10-22 |
| [0015](0015-rs256-service-tokens.md) | RS256 service tokens for .NET → AI service calls (supersedes 0009) | Accepted | 2026-10-22 |
| [0016](0016-per-service-object-storage-credentials.md) | Per-service object-storage credentials (no root keys in applications) | Accepted | 2026-10-22 |
| [0017](0017-tutor-cancellation-and-stale-stream-recovery.md) | Tutor cancellation and stale-stream recovery | Accepted | 2026-10-22 |

## How to add an ADR

1. Write one when a choice is significant, costly to reverse, or the master spec asks for it (e.g. adding RabbitMQ, Redis, LangGraph, a new embedding model, a new provider).
2. Copy the template below to `NNNN-short-kebab-title.md` using the next number. Numbers are never reused.
3. Start as `Proposed`; change to `Accepted` when merged. To change a decision, write a new ADR and set the old one to `Superseded by NNNN` (do not rewrite history).
4. If the decision changes a service, port, config key, schema, API, event or error code, update `contracts.md` in the same pull request.
5. Add a row to the index above.
6. Keep it short (roughly 60–120 lines). State how the decision will be verified.

### Template

```markdown
# NNNN — Title

- Status: Proposed | Accepted | Deprecated | Superseded by NNNN
- Date: YYYY-MM-DD
- Deciders: …
- Related: contracts.md §…, ADR-…

## Context and Problem Statement

What problem, in which part of the system, and why decide now? End with the question being decided.

## Decision Drivers

- Driver (security, cost, operability, learning value, …)

## Considered Options

1. Option A
2. Option B

## Decision Outcome

Chosen option: **A**, because …

### Consequences

- Good: …
- Bad: …

### Confirmation

How we verify the decision is implemented and still holds (tests, metrics, reviews).

## Pros and Cons of the Options

### Option A

- Good: …
- Bad: …

### Option B

- Good: …
- Bad: …

## Links

- …
```
