# Sathi — Master Prompt v2 (Local-first, Production-ready)

Paste everything below the line into a new chat to start the build. It replaces the original prompt and includes the review changes, the user-journey approach, the logging requirements, the web search toggle, a product and stack guide and pre-start suggestions (Sections 18–21).

---

## 0. Role and working mode

Act as a Senior AI Engineer, Software Architect, ML Engineer, DevOps/SRE Engineer and Technical Mentor.

Help me design and build **Sathi**, a production-grade adaptive AI tutoring platform. I am an experienced .NET and Angular full-stack developer who is new to Python and AI engineering, so spend most of the teaching effort on Python, ML, LLM and RAG concepts and move quickly through .NET and Angular basics.

**Environment decision:** for now the system runs **locally with Docker Compose**. Everything must still be **designed, coded and documented as production-ready**: nothing may depend on being local, and moving to a cloud later must need configuration and infrastructure work only, not code changes. The production target is not fixed yet; assume a managed container platform (for example Azure Container Apps with managed PostgreSQL, object storage and a secret store) and keep the design portable.

**How to teach.** For every concept: explain the idea first, derive the maths where relevant with a fully worked numeric example, then show code, then run a minimal experiment, then integrate it into the product, then evaluate it. If something is unclear, rebuild the explanation from fundamentals instead of adding hints. Do not claim a topic is covered just because a framework exposes an API for it.

## 1. Objectives

1. Build a useful AI tutoring product that real students could use.
2. Learn AI engineering end to end: classical ML, deep learning, LLMs, RAG, agents, evaluation, fine-tuning and MLOps.
3. Learn to design, test, secure, containerize, observe and operate a production-style application, including **diagnosing production failures from logs and traces**.

Timeline: about 26 weeks at roughly 10–12 focused hours per week, including two buffer weeks. Treat it as an estimate. If I fall more than one week behind, drop Stretch items before dropping tests, evaluation, logging or security work.

## 2. Build from the user's perspective

Build in **vertical slices**, each one a journey a student or instructor can complete end to end. Every slice includes UI states (empty, loading, slow LLM, error, offline), accessibility checks (WCAG 2.2 AA target), API, data, tests, logging and a Playwright test of the journey.

| Journey | Description |
| --- | --- |
| J1 | Register, verify email, sign in, choose a course, take a short diagnostic quiz |
| J2 | Home screen: continue learning, what to study next, progress |
| J3 | Ask the tutor, receive a streamed answer with citations, give feedback, ask for a simpler or harder explanation, optionally with the Web search toggle on (web sources are cited and labelled separately from course sources) |
| J4 | Upload notes, watch processing progress, ask questions grounded in them |
| J5 | Practice quiz, instant feedback, mastery updates, recommended next activity |
| J6 | Revision schedule and reminders |
| J7 | Instructor: manage content, review uncertain AI grading, see class insights |
| J8 | Admin or AI engineer: inspect a failed run by its reference ID (Section 7) |

Success metrics to instrument: activation rate, week-1 return rate, time to first token, answer helpfulness (thumbs), citation accuracy, quiz improvement, grading agreement, cost per active user.

## 3. Scope tiers

- **Core (must ship):** auth, courses, tutor with streaming and history, document ingestion and RAG with citations, quizzes and grading, baseline mastery and recommendations, evaluation harness, Docker, CI, logging and observability, security baseline.
- **Stretch:** agents with LangGraph and MCP, AI admin dashboard UI, Bayesian Knowledge Tracing, cross-encoder reranking.
- **Lab (learning only, outside the runtime):** neural network from scratch, attention, a small Transformer, optional LoRA fine-tune, one OCR or vision experiment, classical ML experiments.

Challenge any requirement that adds cost without learning value, and say what we would otherwise have to build ourselves when adopting a framework.

## 4. Architecture

- **Angular** (`apps/web`): UI, forms, SSE client, guards, interceptors, PWA, error reporting to the API.
- **ASP.NET Core on .NET 10 LTS** (`services/api`): modular monolith with modules Identity, Courses, Assessments, Progress and AiGateway. Owns users, courses, conversations and messages, document metadata, quizzes and grading records, mastery and recommendation records, usage quotas and audit events. Authenticates users, authorizes every resource, applies rate limits, and is the only public backend.
- **FastAPI** (`services/ai-service`): prompting, LLM and embedding calls, retrieval and RAG, question generation, grading assistance, stateless mastery and recommendation computation, model and agent run logs, evaluation. Private network only.
- **Jobs host (Hangfire)** (`services/jobs`): a separate .NET process running Hangfire with PostgreSQL storage in its own `hangfire` schema and an admin-only dashboard. It orchestrates document ingestion, quiz and revision-plan generation, batch grading, recurring jobs (reminders, nightly evaluation, retention cleanup, usage rollups) and deletion events by calling the AI service's internal endpoints. Queues `critical`, `default` and `ai-heavy` with limited workers; every job is idempotent with bounded retries. Heavy ingestion runs on a second instance of the AI service container with its own concurrency limit. Live tutor chat is never a job (Section 22). RabbitMQ is added later only through an ADR that states what Hangfire cannot do.
- **PostgreSQL + pgvector** (HNSW index, `tsvector` full-text search). One instance, two schemas: `app` (.NET, EF Core migrations) and `ai` (Python, SQLAlchemy and Alembic). Separate DB roles, writes only to the owner's schema, no foreign keys across schemas (opaque UUIDs plus reconciliation jobs), cross-schema reads only through read-only views.
- **Object storage:** MinIO locally, S3-compatible or Azure Blob in production, behind one interface.
- **Redis:** added when a shared store is justified (multiple API instances, distributed rate limits, SSE state), not before.
- **Internal trust:** .NET issues a short-lived signed service token (audience `ai-service`, user ID, allowed scope, request ID). FastAPI verifies it. Retrieval **must filter by the allowed scope inside the SQL query before ranking**; the scope is never taken from the client. Network isolation is a second layer.
- **Streaming:** SSE only (events `token`, `citation`, `usage`, `error`, `done`, each with a request ID).
- **Models:** hosted LLM behind an `LlmProvider` interface with a deterministic `FakeProvider` (CI and tests), record/replay, a second provider for fallback, a daily spend cap and a kill switch. Prompts are versioned files in `prompts/`; each run records the prompt hash.
- **Embeddings:** hosted or a small CPU model chosen by benchmark and recorded in an ADR. Store model name and dimension with every vector; never mix models in one index; plan a re-embedding job.
- **Orchestration:** hand-written tool loop first; LangGraph only after we can state what it adds.

Mermaid diagram and data flow are produced in the blueprint step.

## 5. Technology and version rules

Pin exact versions in lock files at kickoff and verify current support status then.

| Area | Choice |
| --- | --- |
| .NET | .NET 10 LTS, EF Core, FluentValidation, built-in OpenAPI, Serilog (JSON) with OpenTelemetry, xUnit, Testcontainers |
| Angular | Latest stable, standalone components, signals for local state, RxJS for streams, Angular Material, Playwright |
| Python | Current stable supported by PyTorch, `uv`, Ruff, mypy, pytest, FastAPI, Pydantic v2, structlog, SQLAlchemy 2, Alembic |
| Auth | ASP.NET Core Identity, cookie sessions on same origin (CSRF protected), email verification, password reset, lockout; OIDC social login later |
| ML | NumPy, Pandas, scikit-learn, PyTorch (CPU), Transformers, PEFT, MLflow (dev profile only, kept out of runtime images) |
| Observability | OpenTelemetry SDKs and Collector, Prometheus, Grafana, Tempo (traces), **Loki (logs)** |
| Delivery | Docker multi-stage, non-root, Compose, GitHub Actions or Azure DevOps (choose one), Trivy, gitleaks, Dependabot or Renovate |

Not used unless later justified: Kubernetes, SignalR, multi-agent frameworks, TTS and STT.

## 6. Repository

```text
sathi/
  apps/web/
  services/api/  services/ai-service/  services/jobs/
  contracts/        # OpenAPI specs, schemas, generated clients
  prompts/          # versioned prompt templates
  ml/experiments/  ml/training/
  infrastructure/docker/  nginx/  monitoring/  iac/
  tests/integration/  e2e/  ai-evaluation/  load/
  docs/architecture/  decisions/  learning-notes/  runbooks/
  compose.yaml  compose.override.yaml  compose.test.yaml  compose.prod.yaml
  .env.example  README.md
```

## 7. Logging, debugging and observability (first-class requirement)

Goal: **any production problem a user reports must be traceable from a reference ID to the exact request, service, dependency call and failure reason within minutes, without reproducing it.** Build this from week 1, not at the end.

**7.1 Correlation**

- Every request gets a W3C `traceparent` at the edge (browser or Nginx) and flows through Angular → .NET → FastAPI → LLM and DB calls. Hangfire jobs carry the originating trace ID and their own Hangfire job ID in their parameters and restore both into the log context.
- Every log line carries `trace_id`, `span_id`, `request_id`, `service`, `env`, `version`, `user_id_hash` (never the raw user ID or email), and where relevant `conversation_id`, `job_id`, `document_id`, `run_id`.
- Every error response uses RFC 9457 ProblemDetails with a stable `code`, a human message and the `traceId`. The UI shows a short **reference ID** the user can quote. Admin journey J8 looks up a run by that ID.

**7.2 Log format and levels**

- Structured JSON to stdout in every service (Serilog in .NET, structlog in Python); no free-text-only logs; one schema documented in `docs/architecture/logging.md`.
- Level policy: `Error` = a request or job failed and someone should look; `Warning` = degraded or retried and recovered; `Information` = business events and lifecycle; `Debug` = detail, off by default in production, switchable per service at runtime without redeploy.
- Log each failure **once**, at the boundary that handles it, with the exception type, message, stack trace and the inputs needed to reproduce (IDs, sizes, configuration), not the learner's content.
- Stable error codes by area, for example `AUTH_*`, `LLM_TIMEOUT`, `LLM_RATE_LIMITED`, `RAG_NO_RESULTS`, `INGEST_PARSE_FAILED`, `QUOTA_EXCEEDED`, `GRADING_LOW_CONFIDENCE`.

**7.3 What to log for AI-specific work**

- LLM call: provider, model, prompt name and hash, parameters, input and output token counts, estimated cost, time to first token, total latency, retries, finish reason, error code. **Not** the full prompt or answer by default.
- Retrieval: query hash, filters and scope size, method (vector, keyword, hybrid), top-k chunk IDs with scores, timings per stage, whether results were empty.
- Citation check: which citations were valid, which were dropped and why.
- Jobs: job ID, document version, attempt number, every state transition, duration per step, final outcome, retry reason.
- Agents: run ID, each step, tool name, arguments hash, authorization decision, duration, result status, limit reached.
- Grading: question ID, rubric version, confidence, routed to auto-accept or review.

**7.4 Privacy and debug capture**

- Never log passwords, tokens, API keys, cookies, full documents, or learner answers by default. Add a redaction layer with tests that fail the build if known secret or email patterns appear in logs.
- A time-limited **debug capture mode** (per conversation or run, with an expiry) may store full prompts and responses in a separate restricted table with a short retention period and an audit event. It is off by default.
- Separate **audit events** (who did what, stored in the database, long retention) from **diagnostic logs** (operational, short retention).

**7.5 Frontend and database**

- Angular reports unhandled errors, failed HTTP calls and SSE drops to a rate-limited API endpoint with the trace ID, route, app version and browser, never user content.
- Log slow queries (threshold configurable), connection pool saturation, migration runs and lock waits.

**7.6 Local stack that mirrors production** The Compose `observability` profile runs OTel Collector, Loki, Tempo, Prometheus and Grafana, with provisioned dashboards and a Grafana Explore link from a trace ID to its logs. Production sends the same signals to the chosen backend. Log rotation, retention periods and sampling rules are documented per environment.

**7.7 Dashboards and alerts** Dashboards: API latency and errors, AI latency and time to first token, token and cost, retrieval quality, queue depth and job failures, grading routing. Alert rules written now (error rate, p95 latency, queue age, spend, failed ingestion, LLM error rate) and tested locally; paging is connected when a production target exists.

**7.8 Debuggability acceptance tests**

- Kill the AI service during a tutor stream: the user sees a friendly error with a reference ID, and one trace shows the failure point.
- Force a parse failure in ingestion: the job log, error code and retry history explain it without opening the file.
- A seeded secret in a request body never appears in any log.
- Following one reference ID from the UI to Loki and Tempo takes under two minutes and is documented in `docs/runbooks/debugging.md`.

## 8. Security and reliability

Secure auth and resource-level authorization, input validation, upload limits (size, type, magic bytes), rate limits and usage quotas, timeouts and bounded retries, idempotent jobs and idempotency keys, transactions, secret management, prompt-injection defenses, safe server-side tool allowlists, audit logging, data deletion through an outbox event consumed by both services, retention rules, backup and recovery, dependency and image scanning. Treat uploaded files and retrieved text as untrusted. The LLM never gets unrestricted DB access, shell access or unrestricted document access. Follow India's DPDP Act 2023 principles and extra care if users may be minors. Never commit credentials or bake keys into images.

## 9. Docker and environments

- Multi-stage, non-root Dockerfiles for web, api, ai-service and jobs; health checks (live and ready); restart policies; resource limits; log rotation; pinned base images; image scanning in CI.
- Networks: `public` (proxy only), `app`, `internal` (api, ai-service, jobs, postgres, storage), `observability`. Postgres and ai-service are never public.
- Separate configs for development, test, staging and production; one validated config class per service that fails fast; `.env.example` for every variable; migrations run by one-shot migrator containers, not at app start.
- `compose.prod.yaml` must run locally as a **production-profile rehearsal** (no dev volumes, no debug, real limits) so production behaviour is tested before any cloud exists.
- Infrastructure as code (Bicep or Terraform) is written in the last phase for the chosen target.

## 10. Database design

Design the logical schema before features and create tables incrementally. For each entity define purpose, fields and types, keys, relationships, constraints, indexes, owning service, migration strategy and retention.

- **`app` (.NET):** Users, Roles, UserPreferences, Courses, Enrollments, CourseModules, Lessons, Concepts, LearningObjectives, ConceptPrerequisites, Conversations, Messages, MessageFeedback, Documents, DocumentVersions, IngestionJobs, AiRuns, AiRunSteps, QuestionBank, QuestionOptions, Quizzes, QuizQuestions, QuizAttempts, SubmittedAnswers, Rubrics, GradingResults, ConceptMasteryHistory, RevisionSchedules, Recommendations, UsageRecords, AuditEvents.
- **`ai` (Python):** DocumentChunks, ChunkEmbeddings, RetrievalRuns, RetrievedSources, ModelConfigurations, ModelRuns, AgentRuns, ToolInvocations, DebugCaptures, EvaluationDatasets, EvaluationCases, EvaluationRuns, EvaluationResults.

## 11. API contracts

Public `/api/v1` (Angular ↔ .NET) and internal `/internal/v1` (.NET ↔ FastAPI). OpenAPI generated from code, TypeScript and C# clients generated from it, OpenAPI diff in CI to block breaking changes, ProblemDetails errors, cursor pagination, idempotency keys on mutations, correlation headers on every call.

## 12. Testing strategy

xUnit, pytest, Angular tests, Playwright for every journey, Testcontainers integration tests, FakeProvider for deterministic AI tests, golden datasets for retrieval, tutor, grading and agents, k6 load tests, dependency and container scans, backup-restore drills, access-isolation tests (user A can never read user B's data). Define measurable acceptance criteria for every feature and write the acceptance criteria and evaluation case **before** the code. LLM-as-judge results are calibrated against human labels and reported with agreement (Cohen's kappa). Personalization claims use simulated learners offline and are never presented as proof of real learning gains.

## 13. Roadmap (26 weeks)

Each phase has a learning track (theory and experiments) beside a product track (journeys).

| Weeks | Phase | Journeys and focus | Tier |
| --- | --- | --- | --- |
| 1–2 | 1. Foundation | Repo, Compose, health checks, auth skeleton, Hangfire jobs host with one recurring job, CI, **logging and tracing baseline**, ADRs | Core |
| 3–4 | 2. Data and classical ML + Courses | J1 (partial); regression, classification, metrics, calibration, MLflow | Core + Lab |
| 5–6 | 3. Tutor MVP + evaluation harness v0 | J3; tokens, prompting, streaming, cost, golden prompts | Core |
| 7–9 | 4. Documents and RAG | J4; chunking, embeddings, pgvector, hybrid search, RRF, retrieval metrics; web search toggle in weeks 8–9 | Core |
| 10–12 | 5. Quizzes, grading, mastery | J1, J2, J5, J6, J7; rubrics, mastery, SM-2, simulation | Core |
| 13 | Buffer | Full production-profile rehearsal locally, security review 1, debugging drill | Core |
| 14–16 | 6. Agents and workflows | Tool loop, limits, approvals, LangGraph, MCP | Stretch |
| 17–19 | 7. Deep learning lab | Backprop, attention, Transformer, optional LoRA, one OCR experiment | Lab |
| 20–21 | 8. Evaluation and AI operations | Datasets, judge calibration, CI regression gate, cost analysis, J8 | Core + Stretch |
| 22–23 | 9. Hardening and resilience | Threat model, load, chaos, backup restore, scan gates | Core |
| 24–25 | 10. Production readiness | Prod profile validated, IaC, release and rollback checklist, final E2E | Core |
| 26 | Buffer | Final documentation, retrospective, final evaluation report | Core |

For each phase define: learning objectives, theoretical concepts, practical exercises, product features, technologies, implementation tasks, unit and integration tests, AI evaluation tasks, **logging and debuggability checks**, acceptance criteria, deliverables and common failure scenarios.

## 14. Per-feature method

1. Problem, user journey and expected behaviour.
2. Acceptance criteria and evaluation case (written first).
3. Theory, including worked maths.
4. Architecture and data flow.
5. Technology choice, alternatives and trade-offs.
6. API contract and data model.
7. Smallest working implementation, explained section by section.
8. Tests and failure handling.
9. Logging, metrics and traces for the feature.
10. Docker integration.
11. Performance, security and AI-quality evaluation.
12. Documentation and learning note.
13. Completion checklist before moving on.

Never dump the whole codebase in one response. Keep naming, error handling, logging, configuration and API versioning consistent. Avoid unnecessary abstractions and services.

## 15. Documentation to maintain

README, architecture and ER diagrams, generated API docs, ADRs, logging guide, debugging runbook, threat model, evaluation reports, experiment results, learning notes, troubleshooting guide, backup and recovery runbook, production deployment checklist.

## 16. Syllabus (teach theory, run an experiment, integrate, evaluate)

**Foundations:** Python for AI, NumPy, Pandas, linear algebra, probability and statistics, data preparation and leakage, cross-validation, supervised and unsupervised learning, loss functions, overfitting, regularization, precision, recall, F1, calibration.

**Deep learning:** neural networks, forward and backward propagation, optimizers, activations, embeddings, attention, Transformer, positional information, pretraining and inference, quantization.

**LLM engineering:** tokenization, context windows, prompting, system and user instructions, sampling, structured output validation, function calling, model selection, latency and cost, prompt caching, guardrails.

**RAG:** parsing, chunking, embeddings, similarity, ANN indexes (HNSW, IVF), BM25, hybrid search and Reciprocal Rank Fusion, reranking, metadata filtering, grounded generation, citation validation, Recall@k, MRR, nDCG.

**Agents:** tool calling, loops, planning and state, memory, orchestration, MCP, human approval, bounded execution, failure handling.

**Advanced:** multimodal and OCR, fine-tuning with LoRA and QLoRA, model serving, experiment tracking, RLHF, DPO and distillation at concept level.

**Production AI:** evaluation and statistics (confidence intervals, inter-rater agreement), groundedness, versioning, observability, cost optimization, caching, async processing, privacy, prompt-injection defense, CI/CD, MLOps.

## 17. How to begin

Do not write the application yet. First produce the implementation blueprint: final architecture with a Mermaid diagram, service boundaries and data ownership, stack with version rules, repository structure, container inventory and networks, configuration and secret plan, initial database design and migration ownership, API contract strategy, **logging and observability design**, security baseline, milestones with acceptance criteria, and open risks and decisions. Point out any contradiction or unnecessary technology, and recommend simplifications that keep the learning goals.

Then wait for my approval. After approval, work one phase and one manageable task at a time, starting with Phase 1, and give a completion checklist before each next step.

**Decisions I will confirm at the start:** weekly hours, who the first real users are, LLM provider and monthly budget cap, embedding model (hosted or local), future hosting target, GPU access for Phase 7, CI platform, the first course domain (my own AI engineering syllabus), and the web search API provider with its per-user quota and spend cap.

## 18. Web search toggle (available to every user)

Sections 18–21 are part of the specification and override earlier text where they conflict.

**Behaviour.** The tutor input has a **Search the web** toggle, off by default and available to every user. With it on, the tutor searches the web, then answers from the results and any course passages, and cites both. Each answer shows what it used: course material, uploads, web, or general knowledge. Course material takes priority over web results when both exist.

**Flow.**

1. .NET checks the user's identity and daily web-search quota, then passes `web_search: true` to the AI service.
2. The AI service writes a short topic-only search query from the question and recent turns, calls a `SearchProvider`, fetches the top few pages, strips them to clean text and keeps the relevant passages.
3. The prompt is built from tutor rules, the student's level, course passages and web passages, each labelled with its source type.
4. The model answers with citations; a check confirms every citation matches a source actually supplied.
5. SSE adds a `status` event ("Searching the web…") and a `source_type` on each `citation`.

**Implementation rules.**

- `SearchProvider` interface (Brave, Tavily, Bing or similar, chosen by ADR) plus a `FakeSearchProvider` for tests. Search runs only in the Python service; Angular never calls it.
- Start with search-then-answer. In the agents phase the model may decide when to search, within step and spend limits.
- Per-user daily quota, global daily spend cap, cached repeated queries, timeouts and bounded retries. If the search API fails, answer without web results and tell the user.
- Schema: `ai.SearchRuns` (query hash, provider, result count, latency, outcome); `RetrievedSources` gains `source_type` (`course`, `upload`, `web`) and `url`.

**Safety.**

- Treat web pages as untrusted data: pass them to the model as quoted data, never as instructions; include a hostile-page prompt-injection test in the golden set.
- Block fetching private or internal addresses (SSRF), cap page size and fetch time, allow only http and https.
- Never send names, emails, uploaded-file text or full conversation text in the search query.
- Rank reputable domains higher; when sources disagree, say so.

**Logging for web search.** Query hash, provider, URLs used, result count, per-step timings, cache hit, quota remaining, citation validity and error code, all under the same trace ID. Do not log page contents.

**Evaluation.** Golden questions with expected web sources, citation-validity rate, injection-test pass rate, latency and cost per search-enabled answer.

## 19. How the tutor gets its knowledge

The model is not trained on our data. It receives the right material at question time (RAG).

- **Sources:** instructor-written lessons and objectives, uploaded PDF, Word, Markdown and text files, the first course built from my own AI engineering notes, and (when toggled) the web. Only content we own or are licensed to use.
- **Ingestion (Hangfire job calling the AI service):** extract text with page and source metadata, chunk, embed, store in pgvector, build the keyword index.
- **Per question:** .NET builds the allowed scope; the AI service searches only that scope (vector + keyword, fused with RRF); the prompt combines tutor rules, level, weak concepts, recent conversation and passages; the answer streams with validated citations. With no relevant source it says so and gives a clearly marked general explanation.
- **Guidance:** Socratic mode and stepwise hints come from prompt rules plus the student's mastery data, not from the model alone.
- **Build order:** model-only tutor (weeks 5–6), data and retrieval (weeks 7–9), web search (weeks 8–9), mastery-aware guidance (weeks 10–12). Fine-tuning is not needed and stays an optional lab.

## 20. Product and stack guide

**Before building any product, settle:** the user and the problem; the smallest useful first version; success metrics; non-functional requirements (speed, uptime, security, privacy, accessibility, cost); data rights, retention and law (India's DPDP Act); security and privacy by design; recorded trade-offs (ADRs); automated tests; operability (logs, metrics, traces, alerts, backups, a tested restore); cost per user; delivery (CI/CD, environments, migrations, rollback); dependency lock-in; a feedback loop. **AI products also need:** measured quality, hallucination and citation checks, prompt-injection defences, spend caps and a plan for provider changes.

**Stack and why:**

| Layer | Technology | Why it is needed |
| --- | --- | --- |
| Frontend | Angular, TypeScript, Angular Material, RxJS, Playwright | Typed structured UI, accessible components, streaming events, journey tests |
| Main backend | ASP.NET Core (.NET 10 LTS), EF Core, Identity, FluentValidation, Serilog with OpenTelemetry | Secure API, data access and migrations, login and roles, validation, logs and traces |
| AI backend | Python, FastAPI, Pydantic, hosted LLM behind an interface, embeddings, search API, NumPy, Pandas, scikit-learn, LangGraph (later) | AI ecosystem lives in Python; typed streaming API; validated model output; swappable providers; mastery calculations |
| Data | PostgreSQL, pgvector, Postgres full-text search, object storage (MinIO locally), Redis (when scaling) | One reliable database for relational, vector and keyword data; files kept out of the DB; shared limits across servers |
| Background work | Hangfire jobs host (.NET, PostgreSQL storage); RabbitMQ only if outgrown | Document processing with retries without blocking users |
| Delivery | Docker, Compose, Nginx or platform ingress, GitHub Actions or Azure DevOps, Trivy, gitleaks, Key Vault | Same environment everywhere, automated checks, safe secrets |
| Observability | OpenTelemetry Collector, Loki, Tempo, Prometheus, Grafana | Debug production from one reference ID |
| Testing and AI quality | xUnit, pytest, Angular tests, Testcontainers, k6, golden datasets and evaluation runner, MLflow (lab only) | Prevent regressions and measure answer and retrieval quality |
| Lab only | PyTorch, Transformers, PEFT/LoRA | Learning deep learning; never in the product runtime |
| External services | Transactional email, frontend error tracker, LLM and search APIs | Verification and reminders, frontend diagnostics, AI capabilities |

## 21. Suggestions before starting

1. **Build a walking skeleton first.** One thin path through all services (sign in, ask, streamed answer, one trace) before any deep ML study, then alternate product and learning tracks.
2. **Prepare the data early.** Collect 20–30 documents for the first course and write 50 golden questions with expected sources before building RAG; they become the evaluation set.
3. **Set budgets on day one.** A monthly LLM cap, separate development keys, a search API free tier or low cap, and a spend alert.
4. **Check the machine.** The full observability profile plus Postgres and services needs roughly 8–16 GB of RAM; run profiles and start with only what the phase needs.
5. **Read provider terms.** Confirm data retention and training opt-out for the LLM and search providers before sending any learner data.
6. **Work in small pull requests** with trunk-based flow, pre-commit hooks (Ruff, formatting, gitleaks), and an ADR for every significant choice.
7. **Contract first.** Generate API clients from OpenAPI so the .NET, Python and Angular sides cannot drift.
8. **Rehearse failure weekly.** Kill a service or break a parse on purpose and debug it from the reference ID; keep the debugging runbook current.
9. **Write injection and isolation tests from week 5**, not at the end.
10. **Keep a learning note per phase** in your own words, including the maths worked by hand; teaching it back is the real test of understanding.
11. **Guard scope.** Start Stretch items only after the Core acceptance criteria for that phase pass.
12. **Decide who the first real users are** (only me, a few learners, or students), since that sets privacy duties and what can be claimed about learning outcomes.

## 22. Background jobs with Hangfire and the AI run ledger

This section overrides any earlier mention of a Python worker or a Postgres-polling queue.

**Principle.** Live tutor chat is never a job. A queue adds delay before the first token and needs a second channel to return tokens, so chat streams directly over SSE. Everything that is slow, scheduled, retryable or batch work runs as a Hangfire job.

**Chat flow (live, fully recorded).**

1. Angular opens an SSE request to .NET. .NET checks auth, scope and quota and creates an `AiRun` row whose `run_id` is the trace ID.
2. .NET calls the AI service, which retrieves, optionally searches the web, and calls the LLM, writing its own `ModelRuns`, `RetrievalRuns` and `SearchRuns`.
3. Tokens stream back through .NET to the browser.
4. .NET keeps consuming the stream and saves the complete message even if the browser disconnects, so a reload shows the answer.
5. .NET completes the `AiRun` with status, error code, tokens, cost, time to first token, total latency, model and prompt hash.

**AI run ledger.** `app.AiRuns` (run\_id, user hash, type such as `chat`, `ingestion`, `quiz_generation`, `grading`, `revision_plan`, `evaluation`, status, started and finished times, `hangfire_job_id` when async, model, prompt hash, tokens, estimated cost, latency, error code) and `app.AiRunSteps` (run\_id, step such as `retrieve`, `web_search`, `llm`, `citation_check`, `grade`, start, end, outcome, metrics). Python's `ai` tables hold the model-level detail and join on `run_id`. The ledger is the permanent record; the Hangfire dashboard is not, because job history expires. It stores metadata and hashes, not learner content (debug capture rules in Section 7 apply).

**Jobs that use Hangfire.**

| Job | Trigger | Notes |
| --- | --- | --- |
| Document ingestion | After upload | Calls AI service parse, chunk and embed steps; updates `IngestionJobs` status for the UI; safe to repeat for the same document version |
| Quiz and revision-plan generation | User or instructor request | Validates output before publishing |
| Batch grading | Quiz submission with free text | Low-confidence results go to the instructor queue |
| Revision reminders | Recurring | Sends email at the user's local time |
| Nightly evaluation | Recurring | Runs golden datasets and stores results |
| Retention cleanup and usage rollups | Recurring | Deletes expired data and aggregates usage |
| Deletion events | Outbox | Delivers "delete my data" to both services |

**Hangfire rules.**

- A separate `jobs` container from the same .NET codebase, so API latency is never affected. Storage: `Hangfire.PostgreSql` in a `hangfire` schema with its own database role.
- Queues `critical`, `default` and `ai-heavy`; limit workers per queue to respect LLM rate limits and CPU.
- Jobs run at least once, so every job is idempotent (idempotency key per document version, attempt or request). Set automatic retries to about 3 with backoff instead of the default 10, with a timeout per job.
- Pass only IDs as job arguments, never learner content. Include the trace ID and `run_id`; a job filter restores them into the log context and writes start, success, retry and failure lines with the Hangfire job ID.
- Failed jobs after the last retry raise an alert and appear on a dashboard; the user sees a friendly status with a reference ID.
- The dashboard is admin-only, behind authentication and not exposed publicly.
- Heavy ingestion runs on a second instance of the AI service container with its own concurrency limit, so uploads cannot slow live chat.

**Introduced in:** Phase 1 (jobs host, dashboard and one recurring job with the logging filter), Phase 4 (ingestion), Phase 5 (grading, reminders), Phase 8 (nightly evaluation).

**Acceptance tests.**

- Kill the AI service during ingestion: the job retries up to its limit, then fails with an error code, an alert and a visible reference ID; nothing is duplicated.
- Run the same ingestion job twice: no duplicate chunks.
- Disconnect the browser mid-answer: the full message and a completed `AiRun` exist after reload.
- Follow one reference ID from the UI to the `AiRun`, its steps, the Hangfire job and the logs in under two minutes.

## 23. UI and UX design reference

The sample screens are an interactive design canvas, not image files: [Sathi — Sample Screens](https://claude.ai/artifact/6FChS5NNHvmHXQJM8qKGie). Use them as the visual reference. Recreate them in Angular Material with a custom theme built from the tokens below; do not copy the design HTML into the app.

**Design tokens.**

| Token | Value |
| --- | --- |
| Ink (text, sidebar) | `#12192B` |
| Primary indigo | `#4B3FE4` |
| Accent amber (highlights, weak concepts) | `#FFB547`, text-safe `#E0861A` on bars |
| Success mint | `#0F7B63` |
| Background and cards | `#F4F6FB`, white cards with 18 px radius |
| Muted text | `#4A5470` |
| Fonts | Space Grotesk (headings), DM Sans (body) |
| Layout | Fixed 220 px sidebar on desktop; collapses to a single column under 720 px |

**Screens designed so far.**

| Screen | Purpose | Key components |
| --- | --- | --- |
| Home | Show where to continue and what to study next | Continue-lesson hero card, revision-due card, per-concept mastery bars, study-next suggestions with the reason for each |
| Tutor chat | Ask and learn with sources | Level switcher (Beginner, Intermediate, Advanced), mode chips (Explain, Give a hint, Quiz me), streamed answer with numbered citation chips, Simpler / Harder / Helpful / Not helpful buttons, Search the web toggle, sources panel |
| Practice quiz | Practise and get feedback | Progress bar, question card, answer states labelled with text as well as colour, explanation panel, mastery change bar, next-question action |
| My notes | Upload and track processing | Drop zone, per-file progress, ready state, failed state with reference ID and Retry |

**Screens still to design.** Sign-in and onboarding with the diagnostic quiz; progress overview; revision schedule; instructor course editor and grading review queue; admin or AI-engineer run view opened by reference ID (journey J8); phone layouts for every screen; empty, loading, slow-answer and error states for every screen; web-source labels (course, upload, web) in the sources panel.

**UX rules.**

- WCAG 2.2 AA: contrast, keyboard use, visible focus, labelled inputs, minimum 44 px touch targets; never rely on colour alone.
- Every screen needs empty, loading, slow-LLM, offline and error states.
- Every error shows a short reference ID the user can quote (Section 7).
- Citations are chips linking to the exact source and page; web sources look different from course sources.
- The Search the web toggle is off by default and visible beside the input.
- Streaming shows a status line (for example "Searching the web…") before the first token.
