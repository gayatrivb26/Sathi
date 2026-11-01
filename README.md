# Sathi

**Sathi** is an adaptive AI tutor. Students follow a course, ask a tutor that answers from course lessons, their own uploaded notes and (optionally) the web — always with citations — practise with quizzes graded instantly or by AI with instructor review, and get a revision schedule driven by a per-concept mastery model. Instructors manage content and review uncertain grading; admins can trace any failed AI run from the reference ID a user quotes.

It runs locally with Docker Compose and is designed, configured and documented for production on a managed container platform.

## Architecture in one paragraph

An Angular SPA is served by **nginx** (`web`, the only public container), which proxies `/api` to an **ASP.NET Core (.NET 10)** modular monolith (`api`) and `/hangfire` to a **Hangfire** jobs host (`jobs`). Both call a private **FastAPI** AI service (`ai-service`, plus `ai-ingest` for heavy ingestion) with a short-lived RS256-signed service token (the AI side holds only the public key). Data lives in one **PostgreSQL 17 + pgvector** database with separate schemas and roles (`app`, `ai`, `hangfire`); files in **MinIO** (S3-compatible), accessed with a separate, prefix-scoped user per service. Tutor answers stream over SSE; retrieval is hybrid (vector + full-text, fused with RRF) and filtered by the caller's scope inside SQL. Every service emits structured JSON logs, traces and metrics through **OpenTelemetry** to Loki, Tempo and Prometheus, viewed in Grafana.

- Diagrams and data flows: [docs/architecture/overview.md](docs/architecture/overview.md)
- The contract every component is built against: [docs/architecture/contracts.md](docs/architecture/contracts.md)
- Logging and observability: [docs/architecture/logging.md](docs/architecture/logging.md) · Threat model: [docs/architecture/threat-model.md](docs/architecture/threat-model.md)
- Decisions (ADRs): [docs/decisions](docs/decisions/README.md) · Runbooks: [debugging](docs/runbooks/debugging.md), [troubleshooting](docs/runbooks/troubleshooting.md), [backup & restore](docs/runbooks/backup-restore.md) · [Production checklist](docs/production-checklist.md)

## Repository layout

```text
apps/web/                 Angular app (Dockerfile serves it with nginx)
services/api/             ASP.NET Core API + migrator (Dockerfile, Dockerfile.migrator)
services/jobs/            Hangfire jobs host
services/ai-service/      FastAPI AI service (also used for ai-ingest and migrator-ai)
content/ai-engineering/   seed course (lessons, questions)
prompts/                  versioned prompt templates
infrastructure/           docker/postgres init, nginx/default.conf, monitoring/ (collector, Loki, Tempo, Prometheus, Grafana)
tests/                    integration, e2e, ai-evaluation datasets, load
docs/                     architecture, decisions, runbooks
scripts/                  dev helpers (bash .sh and PowerShell .ps1)
compose.yaml              base, production-shaped
compose.override.yaml     development (auto-loaded): dev ports, demo users
compose.test.yaml         CI / E2E: fake AI providers, data in RAM
compose.prod.yaml         production-profile rehearsal: limits, read-only, no dev ports
```

## Prerequisites

- Docker Desktop (or Docker Engine) with **Compose v2.24+**, at least **8 GB RAM** for Docker (≈ 4 GB without the observability profile)
- Git with LF line endings for shell scripts (enforced by `.gitattributes`)
- For working on the code outside containers: **.NET 10 SDK**, **Python 3.12 + [uv](https://docs.astral.sh/uv/)**, **Node.js 22**

## Quick start

```bash
# 1. Secrets: copy .env.example to .env and fill every __GENERATE__ placeholder with random values
./scripts/generate-secrets.sh              # PowerShell: .\scripts\generate-secrets.ps1

# 2. Build and start (compose.override.yaml is loaded automatically)
docker compose up -d --build               # or: ./scripts/dev-up.sh  /  .\scripts\dev-up.ps1

# 3. Open the app
#    http://localhost:8080
```

> **Existing `.env`?** Release 2 adds new variables (RS256 service-token key pair, per-service storage users, privacy settings). Upgrade your file without rotating database passwords, then rebuild:
>
> ```bash
> scripts/generate-secrets.sh --add-missing      # PowerShell: .\scripts\generate-secrets.ps1 -AddMissing
> docker compose up -d --build
> ```
>
> It keeps every existing value, appends only the missing variables (fresh secrets and a new key pair), removes the obsolete `SERVICE_TOKEN_SECRET`, writes a backup `.env.bak-<timestamp>` and prints variable names only. `minio-init` creates the new storage users in your existing MinIO volume on the next start.

The first start builds every image and runs the one-shot migrators (database schema + seed course); it can take several minutes. `docker compose ps -a` shows progress — `migrator-app`, `migrator-ai` and `minio-init` end as *Exited (0)*.

| What | Where | Sign in |
| --- | --- | --- |
| Sathi | http://localhost:8080 | Student `demo@sathi.local` / `Demo!12345` · Instructor `instructor@sathi.local` / `Teach!12345` · Admin `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env` |
| Mailpit (verification & reset e-mails) | http://localhost:8025 | — |
| MinIO console | http://localhost:9001 | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` (operators only; the services use `STORAGE_APP_*` / `STORAGE_AI_*`) |
| Hangfire dashboard | http://localhost:8080/hangfire | Admin account |
| Grafana (observability profile) | http://localhost:3000 | anonymous admin in dev |
| Prometheus alerts (observability profile) | http://localhost:9090/alerts | — |

Demo accounts exist only when `SEED_DEMO_USERS=true` (forced on by `compose.override.yaml` and `compose.test.yaml`, off in production). New registrations need e-mail verification: open the link in Mailpit.

**By default no paid API is called**: with `ANTHROPIC_API_KEY` empty the AI service uses a deterministic fake LLM, embeddings run locally (`BAAI/bge-small-en-v1.5` via fastembed — downloaded once on first use), and web search is off (`SEARCH_PROVIDER=none`).

## Roles and access

Sathi has three roles — **Student**, **Instructor**, **Admin** — and the API enforces every rule; the UI only hides navigation ([ADR-0013](docs/decisions/0013-roles-self-registration-student-only-staff-invites.md), [ADR-0012](docs/decisions/0012-course-access-public-private-courses-and-classes.md)).

**Signing up.** Anyone can register at `/auth/register`; a new account is always a **Student** (nobody picks a role). The e-mail must be verified (locally: open the link in Mailpit). Registration asks for the date of birth: under 8 is refused; under 18 requires a parent/guardian e-mail, and the account can sign in only after the guardian approves the consent e-mail ([ADR-0014](docs/decisions/0014-under-18-learners-verifiable-guardian-consent.md)).

**Making someone an instructor (Admin).** Either

- **Users page** (`/admin/users`): find the existing account and add the *Instructor* (or *Admin*) role, or
- **Staff invite** (Admin area, staff invites): enter an e-mail, the role and optionally a course. The person receives a 7-day link; registering — or signing in with an existing account — **with that same e-mail** adds the role and, if a course was chosen, makes them a co-instructor of it.

Role changes, locks and password resets reach active sessions within about a minute. You cannot remove your own Admin role or the last Admin.

**Sharing a course (Instructor).** In the Instructor area:

- **Public course** — every signed-in student sees it in the catalogue and can enrol themselves.
- **Private course + class** — the course is visible only to members of one of its classes. Create a class to get a **join code** (`XXXX-XXXX`) and a **join link** (`/join?code=XXXX-XXXX`) to share, and/or **invite by e-mail** (up to 100 addresses; each gets a personal 14-day link that only works for that e-mail). Regenerate the code, turn joining off, archive the class or remove members at any time.
- **Co-instructors** — the course owner can add other users who already have the Instructor role.

**Joining (Student).** Enter the join code in the app (*Join a class*), open the join link, or open the invite e-mail and sign in / register with the invited address. Joining enrols you in the course; you can leave a class again from your class list.

Demo data: the seeded instructor (`instructor@sathi.local`) and student (`demo@sathi.local`) exist only with `SEED_DEMO_USERS=true`.

### Observability profile

```bash
./scripts/up-observability.sh              # PowerShell: .\scripts\up-observability.ps1
```

This sets `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317` for every service and starts the OTel Collector, Loki, Tempo, Prometheus and Grafana. Dashboards are in the Grafana folder **Sathi** (*API & errors*, *AI quality, latency & cost*, *Jobs & ingestion*). Paste a reference ID (e.g. `7F3A91C2`) into the *API & errors* dashboard to see every log line of that request; click *View trace* to jump to Tempo. Without the profile, `OTEL_EXPORTER_OTLP_ENDPOINT` stays empty and services log JSON to stdout only.

### Everyday commands

| Task | bash | PowerShell |
| --- | --- | --- |
| Start / rebuild | `scripts/dev-up.sh [service…]` | `.\scripts\dev-up.ps1 [service…]` |
| Stop (keep data) | `scripts/dev-down.sh` | `.\scripts\dev-down.ps1` |
| Stop and delete data | `scripts/dev-down.sh -v` | `.\scripts\dev-down.ps1 -Volumes` |
| Follow logs | `scripts/logs.sh [service…]` | `.\scripts\logs.ps1 [service…]` |
| Only errors / one reference ID | `scripts/logs.sh --errors` · `scripts/logs.sh --trace 7F3A-91C2` | `.\scripts\logs.ps1 -Errors` · `-Trace 7F3A-91C2` |
| Recreate the database + seed | `scripts/reset-db.sh` | `.\scripts\reset-db.ps1` |
| Production-profile rehearsal | `scripts/prod-rehearsal.sh [--observability]` · `… down -v` | `.\scripts\prod-rehearsal.ps1 [-Observability]` · `-Down -Volumes` |
| Validate infra config | `scripts/check-monitoring.sh` | `.\scripts\check-monitoring.ps1` |

## Developing without containers

Run only the infrastructure in Docker and the app you are working on natively (contracts §1):

```bash
docker compose up -d postgres minio minio-init mailpit   # published on 127.0.0.1: 5432, 9000/9001, 1025/8025
```

Run the migrators once (`docker compose up migrator-app migrator-ai`) or from your IDE, then:

| Component | Command | URL |
| --- | --- | --- |
| Angular | `cd apps/web && npm ci && npx ng serve` (proxies `/api` and `/hangfire` to `:5080` via `proxy.conf.json`) | http://localhost:4200 |
| API | `dotnet run --project services/api/...` with `ASPNETCORE_URLS=http://localhost:5080` | http://localhost:5080 |
| Jobs | `dotnet run --project services/jobs/...` with `ASPNETCORE_URLS=http://localhost:5090` | http://localhost:5090/hangfire |
| AI service | `cd services/ai-service && uv sync && uv run uvicorn app.main:app --reload --port 8000` | http://localhost:8000 |

Outside Docker, point the configuration at `localhost` instead of the container names (e.g. `ConnectionStrings__App=Host=localhost;Port=5432;Database=sathi;Username=sathi_app;Password=<APP_DB_PASSWORD>`, `Ai__BaseUrl=http://localhost:8000`, `DATABASE_URL=postgresql+psycopg://sathi_ai:<AI_DB_PASSWORD>@localhost:5432/sathi`, `STORAGE_ENDPOINT=http://localhost:9000`, `Email__Host=localhost`). Each service team documents its own user-secrets / `.env` setup in its folder. To debug the containerised AI service directly, it is published on `127.0.0.1:8000` in development.

## Tests

| Suite | Command |
| --- | --- |
| .NET unit + integration (Testcontainers needs Docker) | `dotnet test` |
| Python (fake providers) | `cd services/ai-service && uv run ruff check . && uv run mypy app && uv run pytest` |
| Angular unit | `cd apps/web && npm run test:ci` |
| Playwright journeys, mocked API | `cd apps/web && npm run e2e:mock` |
| Whole stack, fake AI (as CI) | `docker compose -p sathi-test -f compose.yaml -f compose.test.yaml up -d --build --wait`, run E2E against http://localhost:8080 (Mailpit API on :8025), then `… down -v` |
| Infrastructure config | `scripts/check-monitoring.sh` (compose, `promtool check/test rules`, `otelcol validate`, `nginx -t`) |
| OpenAPI contracts | `dotnet build` regenerates `contracts/openapi/api.v1.json`; `cd services/ai-service && uv run python -m app.export_openapi` regenerates `contracts/openapi/ai-internal.v1.json` — commit both |
| Real-stack E2E (once `tests/e2e/` exists) | stack up as above, then `npx playwright test -c tests/e2e/playwright.config.ts` |

CI (`.github/workflows/ci.yml`) runs all of the above plus image builds, Trivy (fails on CRITICAL), a non-root check and gitleaks. It fails when a generated OpenAPI file differs from the committed one, and on pull requests runs `oasdiff breaking` against the target branch (label a PR `openapi-breaking-ok` to accept an intentional breaking change). Install the git hooks with `pre-commit install` (ruff, gitleaks, whitespace, shellcheck).

## Using real Claude and web search

Edit `.env`, then `docker compose up -d ai-service ai-ingest` (they are recreated with the new values):

```dotenv
# Claude
ANTHROPIC_API_KEY=sk-ant-...
LLM_PROVIDER=anthropic
LLM_MODEL=claude-opus-5-5            # fallback: LLM_FALLBACK_MODEL=claude-sonnet-5-5
LLM_DAILY_SPEND_CAP_USD=5            # hard daily cap; then SPEND_CAP_REACHED
AI_KILL_SWITCH=false                 # true = every LLM call fails fast with LLM_DISABLED

# Web search ("Search the web" toggle in the tutor)
SEARCH_PROVIDER=tavily               # or brave (BRAVE_API_KEY), fake, none
TAVILY_API_KEY=tvly-...
WEB_SEARCH_DAILY_SPEND_CAP_USD=1
```

Use separate, low-limit development keys and set a spend limit at the provider too. Per-user quotas (200 chat messages, 20 web searches, 20 uploads per day) are `Quotas__*` settings.

## Troubleshooting

See [docs/runbooks/troubleshooting.md](docs/runbooks/troubleshooting.md). The usual suspects:

- **`required variable … is missing`** — no `.env` yet: run `scripts/generate-secrets.*`; an older `.env`: run `scripts/generate-secrets.sh --add-missing` (PowerShell `-AddMissing`).
- **`SERVICE_TOKEN_INVALID` in the tutor** — the key pair in `.env` is inconsistent: delete both `SERVICE_TOKEN_*_PEM_B64` lines and run `--add-missing` again, then `docker compose up -d`.
- **`password authentication failed`** after regenerating `.env` — the database volume keeps the old role passwords: restore the old `.env` or run `scripts/reset-db.*` (deletes local data).
- **`api`/`jobs` never start** — a migrator failed: `docker compose logs migrator-app migrator-ai`.
- **A user reports an error** — follow their reference ID: [docs/runbooks/debugging.md](docs/runbooks/debugging.md).
- **Slow machine** — start without the observability profile; first starts of Postgres, MinIO and Grafana can take minutes.
