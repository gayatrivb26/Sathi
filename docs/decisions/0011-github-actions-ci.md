# 0011 — GitHub Actions for CI (not Azure DevOps)

- Status: Accepted
- Date: 2026-10-17
- Deciders: project owner, DevOps engineer
- Related: master spec §5 (Delivery), §12; ADR-0010

## Context and Problem Statement

Sathi is a polyglot monorepo (.NET 10, Python 3.12 with `uv`, Angular) built into Docker images. Every pull request must build and test all three stacks, run integration tests with real Postgres (Testcontainers), build images, scan images and secrets, and keep dependencies current. The master spec allows GitHub Actions or Azure DevOps; we must pick one.

## Decision Drivers

- Code hosting is on GitHub; CI should live next to pull requests, checks and Dependabot.
- First-class support for .NET, Python, Node and Docker on hosted Linux runners (Docker available for Testcontainers).
- Built-in secret scanning/dependency tooling and SARIF upload for findings.
- Low cost for a one-person project.
- Future deployment to a cloud without long-lived cloud secrets (OIDC federation).

## Considered Options

1. GitHub Actions (`.github/workflows/ci.yml`) with Dependabot.
2. Azure DevOps Pipelines (repository on GitHub or Azure Repos).
3. Self-hosted CI (Jenkins, GitLab CI runner).

## Decision Outcome

Chosen option: **1 — GitHub Actions**, single workflow `.github/workflows/ci.yml` on pull requests and pushes to `main`.

Jobs (parallel where independent):

| Job | Steps |
| --- | --- |
| `dotnet` | restore (locked), build, xUnit unit + integration tests (Testcontainers Postgres/pgvector), OpenAPI generation + diff against `main` |
| `python` | `uv sync --frozen`, Ruff, mypy, pytest with `FakeProvider`/fake embeddings/fake search, Alembic upgrade on a test DB |
| `web` | `npm ci`, lint, unit tests, production build; Playwright journeys against `compose.test.yaml` (fake AI providers) |
| `docker` | build all images (multi-stage, non-root, pinned base images) with layer cache |
| `trivy` | scan each image; **fail on CRITICAL**, report HIGH; upload SARIF |
| `gitleaks` | scan the diff and history for secrets; fail on any finding |

- Dependabot: weekly updates for NuGet, `uv`/pip, npm, Docker base images and GitHub Actions, grouped by ecosystem.
- Hardening: workflow `permissions: contents: read` by default (escalated per job only where needed, e.g. `security-events: write` for SARIF); third-party actions pinned to commit SHAs; no secrets exposed to workflows from forks; CI uses no real LLM/search keys (fake mode, ADR-0005/0006).
- Branch protection on `main` requires all jobs green.
- Deployment (later): GitHub OIDC federation to the cloud (e.g. Entra workload identity federation for Azure) — no stored cloud credentials.

### Consequences

- Good: CI, PR checks, Dependabot and security findings in one place next to the code.
- Good: hosted runners have Docker, .NET, Python and Node; Testcontainers works out of the box.
- Good: large marketplace; SHA-pinned actions keep supply-chain risk manageable.
- Bad: lock-in to GitHub workflow syntax (moderate; steps are mostly shell commands and could be ported).
- Bad: hosted-runner minutes are limited on private repositories; Playwright + Docker builds are the main consumers — use path filters and caching.
- Bad: third-party actions are a supply-chain risk (mitigated by SHA pinning and Dependabot for actions).

### Confirmation

- A PR introducing a fake secret is blocked by gitleaks.
- A PR introducing an image with a known CRITICAL CVE is blocked by Trivy.
- A breaking OpenAPI change is flagged by the diff step.
- Dependabot PRs appear for each configured ecosystem.

## Pros and Cons of the Options

- **1. GitHub Actions** — Good: native to the repo host, Dependabot, SARIF code scanning, OIDC to clouds, free tier. Bad: GitHub-specific syntax.
- **2. Azure DevOps** — Good: strong Azure integration, environments and approvals, Boards. Bad: a second platform to manage when code is on GitHub; Dependabot/code-scanning integration is weaker; extra service connections.
- **3. Self-hosted CI** — Good: full control, no minute limits. Bad: servers to patch and secure; not justified for one developer.

## Links

- GitHub Actions security hardening: https://docs.github.com/actions/security-guides/security-hardening-for-github-actions
- Trivy: https://trivy.dev/
- gitleaks: https://github.com/gitleaks/gitleaks
- Dependabot: https://docs.github.com/code-security/dependabot
