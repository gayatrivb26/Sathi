# 0001 — Modular monolith (.NET) plus a separate AI service (Python)

- Status: Accepted
- Date: 2026-10-17
- Deciders: project owner (architect/developer)
- Related: [contracts.md](../architecture/contracts.md) §1, §3, §6; ADR-0002, ADR-0009

## Context and Problem Statement

Sathi needs a secure public backend (auth, courses, conversations, quizzes, quotas, audit) and an AI layer (prompting, LLM calls, embeddings, retrieval, grading assistance, evaluation). The developer is experienced in .NET and Angular and new to Python; the AI ecosystem (embedding libraries, evaluation tooling, LangGraph later) is Python-first. One person builds and operates the system, locally on Docker Compose first, with a later move to a managed container platform that must need configuration only.

How should the backend be split into deployable services?

## Decision Drivers

- One-person operability: few deployables, one database, simple local start.
- Use each ecosystem where it is strongest: .NET for the secure, transactional product core; Python for AI work.
- A hard security boundary: the AI layer is never public and never authenticates end users itself.
- Clear data ownership with no shared writes, so each side can migrate independently.
- Learning value: Python/AI skills are a goal, but not at the expense of product security.
- Heavy ingestion must not slow live chat.

## Considered Options

1. Modular monolith in .NET (`api` + `jobs` hosts from one codebase) plus a separate Python AI service (`ai-service`, with a second `ai-ingest` instance of the same image).
2. Microservices per domain (identity, courses, assessments, tutor, ingestion…).
3. Single Python backend (FastAPI for everything, including auth).
4. Single .NET backend with AI in .NET (e.g. Semantic Kernel, ONNX runtime in .NET).

## Decision Outcome

Chosen option: **1 — .NET modular monolith plus a separate Python AI service**.

- `Sathi.Api` is the only public backend (reached through `web`/Nginx). Modules: Identity, Courses, Assessments, Progress, AiGateway. Modules talk through in-process interfaces, not HTTP; each owns its tables in schema `app`.
- `Sathi.Jobs` is a second process from the same codebase hosting Hangfire (ADR-0002).
- `ai-service` (FastAPI) owns schema `ai` and is reachable only on the `internal` network via `/internal/v1`, authenticated with a short-lived service token (ADR-0009). `ai-ingest` is the same image with `AI_INSTANCE_ROLE=ingest` and `INGEST_CONCURRENCY=2`.
- One Postgres database, three schemas (`app`, `ai`, `hangfire`), three roles, each with `USAGE` only on its own schema, no cross-schema foreign keys; IDs crossing schemas are opaque UUIDs. Cross-service deletion uses the outbox (`outbox_messages` → `ProcessOutboxJob`).
- The AI service is stateless with respect to users: .NET decides who the user is and what they may read, and passes that as token claims (`sub`, `scp`, `rscope`).

### Consequences

- Good: one public attack surface; auth, authorization, quotas and audit live in one place.
- Good: Python is confined to the area where it adds value; the developer learns it without it carrying security-critical auth code.
- Good: modules can be extracted later because boundaries and data ownership are already explicit.
- Good: `ai-ingest` isolates CPU-heavy parsing and embedding from live tutor latency.
- Bad: two languages, two toolchains, two migration systems (EF Core, Alembic) and two log/trace setups to keep consistent.
- Bad: an extra network hop for every AI call; contract drift risk between C# and Python (mitigated by OpenAPI-generated clients and OpenAPI diff in CI).
- Bad: no cross-schema FKs means orphaned rows are possible; reconciliation and outbox delivery must be tested.

### Confirmation

- Architecture tests in .NET assert modules do not reference each other's internals or `DbContext` sets.
- Integration test: `ai-service` has no route reachable from the `public`/`app` networks; a request without a service token gets 401 `SERVICE_TOKEN_INVALID`.
- DB test: role `sathi_ai` cannot read `app.*`, role `sathi_app` cannot read `ai.*`.
- Load test (k6): tutor TTFT does not regress while an ingestion batch runs on `ai-ingest`.

## Pros and Cons of the Options

### 1. Modular monolith + AI service

- Good: smallest number of services that still gives a real trust boundary and ecosystem fit.
- Good: matches the developer's strengths for the security-critical parts.
- Bad: polyglot overhead (see Consequences).

### 2. Microservices per domain

- Good: independent scaling and deployment per domain.
- Bad: distributed transactions, many deployables, service discovery and contract versioning for one developer; no current scaling need justifies it.

### 3. Single Python backend

- Good: one language, direct access to AI libraries.
- Bad: auth, Identity-equivalent features, antiforgery and lockout must be rebuilt or assembled from less familiar libraries; the AI layer would be public-facing.

### 4. Single .NET backend

- Good: one language the developer already knows.
- Bad: weaker ecosystem for embeddings, evaluation and agent frameworks; defeats the Python/AI learning objective.

## Links

- Master spec §4 (Architecture), §8 (Security), §22 (jobs)
- ADR-0002 (Hangfire), ADR-0003 (retrieval), ADR-0009 (service token)
