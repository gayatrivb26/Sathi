# Production checklist

Sathi runs locally with Docker Compose but is built so that moving to a managed platform is configuration and infrastructure work only. Rehearse every release with `compose.prod.yaml` first (`scripts/prod-rehearsal.sh`).

## 1. Before the first production deployment

### Secrets and configuration
- [ ] Every value in `.env.example` exists in a **secret store** (Azure Key Vault, AWS Secrets Manager…); nothing is read from a file in production. No `.env` in images (`.dockerignore`), none committed (gitleaks in CI + pre-commit).
- [ ] Fresh, environment-specific values: `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `AI_DB_PASSWORD`, `HANGFIRE_DB_PASSWORD`, the RS256 service-token key pair `SERVICE_TOKEN_PRIVATE_KEY_PEM_B64` / `SERVICE_TOKEN_PUBLIC_KEY_PEM_B64` + `SERVICE_TOKEN_KEY_ID` (private key only in the api/jobs secret scope), `LOG_HASH_SALT`, storage keys (`STORAGE_APP_*`, `STORAGE_AI_*`), `SEED_ADMIN_PASSWORD`, SMTP credentials, `GRAFANA_ADMIN_PASSWORD`.
- [ ] Separate Anthropic / Tavily keys per environment with **provider-side spend limits**; `LLM_DAILY_SPEND_CAP_USD` and `WEB_SEARCH_DAILY_SPEND_CAP_USD` set; kill switch procedure known (`AI_KILL_SWITCH=true`).
- [ ] Provider terms reviewed: data retention, training opt-out, region (DPDP Act cross-border notes in the [threat model](architecture/threat-model.md)).
- [ ] `SATHI_ENV=production`, `ASPNETCORE_ENVIRONMENT=Production`, `LOG_LEVEL=INFO`, `SEED_DEMO_USERS=false`, `APP_BASE_URL=https://<domain>`.
- [ ] Object storage: two **scoped identities** with the prefix policies of ADR-0016 (app: `uploads/*`, `lessons/*` read/write, `parsed/*` delete; AI: `uploads/*`, `lessons/*` read, `parsed/*` read/write) — the local stack already does this with MinIO users created by `minio-init`; no application holds root/owner credentials. Bucket provisioned outside the apps.
- [ ] Third-party images are pinned and mirrored into your own registry. Note: `minio/minio` and `minio/mc` are no longer on Docker Hub; the stack defaults to the community builds `pgsty/minio` / `pgsty/mc` (`MINIO_IMAGE`, `MINIO_MC_IMAGE`). Production should use managed object storage instead (section 4).
- [ ] Rotation plan written for the service-token key pair (`kid` rotation, ADR 0015), storage user secrets (ADR 0016) and DB passwords.
- [ ] `PRIVACY_AGE_OF_MAJORITY=18` (DPDP), `PRIVACY_CONSENT_POLICY_VERSION` matches the published privacy notice; legal review of the guardian-consent flow done (ADR 0014).

### TLS and edge
- [ ] TLS terminated at the platform ingress / load balancer (managed certificate, TLS 1.2+); HTTP → HTTPS redirect.
- [ ] The ingress sets `X-Forwarded-Proto: https` (nginx then sends HSTS) and the API trusts forwarded headers **only** from the ingress network (ASP.NET `ForwardedHeadersOptions.KnownNetworks`).
- [ ] Auth cookie `Secure` (automatic outside Development), `SameSite=Lax`; antiforgery on.
- [ ] Ingress does not buffer `text/event-stream` and allows ≥ 300 s responses on `/api/v1/conversations/*/messages/stream`; request body limit ≥ 26 MB.
- [ ] Nginx `resolver 127.0.0.11` is Docker-specific: on the target platform set the platform DNS resolver and the internal host names of `api` / `jobs` in `infrastructure/nginx/default.conf` (or route `/api` and `/hangfire` at the ingress and keep nginx for static files only).
- [ ] `/hangfire` reachable only by Admins (enforced by the jobs host) — optionally also IP-restricted at the ingress.

### Database
- [ ] **Managed PostgreSQL 17 with the `vector` extension** (Azure Database for PostgreSQL Flexible Server: allow-list `VECTOR`, `PG_TRGM`, `PGCRYPTO` in `azure.extensions`; AWS RDS/Aurora support pgvector). Version of pgvector ≥ 0.8 (HNSW).
- [ ] Run `infrastructure/docker/postgres/init/01-init.sh` once against the server as the admin user (it is idempotent): roles, schemas, extensions, grants, search paths. On managed servers without a true superuser, the admin role must be allowed to create extensions.
- [ ] Private networking only (VNet integration / private endpoint); no public IP. TLS required (`SSL Mode=Require` in `ConnectionStrings__*`, `sslmode=require` in `DATABASE_URL`).
- [ ] Automated backups with point-in-time restore (≥ 7 days), plus the logical backup in [backup-restore.md](runbooks/backup-restore.md) before each migration; a **restore has been tested**.
- [ ] Connection limits sized: (api + jobs + ai instances) × pool size < `max_connections`.

### Observability
- [ ] Collector exporters point at the production backends (Grafana Cloud, Azure Monitor / Application Insights, or self-hosted Loki/Tempo/Prometheus); apps keep `OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4317`.
- [ ] Retention per [logging.md §7](architecture/logging.md#7-retention-and-sampling); `TRACE_SAMPLE_PERCENT` set (errors and slow traces are always kept).
- [ ] Alert rules from `infrastructure/monitoring/prometheus/alerts.yml` loaded and **routed to a pager/email** (Alertmanager or the platform's alerting); a test alert received.
- [ ] Grafana not anonymous; SSO or strong admin password; `Observability__GrafanaUrl` points at it for admin links.
- [ ] Redaction verified on the production pipeline (seeded-secret drill D3 in [debugging.md](runbooks/debugging.md)).

### Security and compliance
- [ ] CI green: build, tests, Playwright, Trivy (no CRITICAL), gitleaks; Dependabot PRs triaged.
- [ ] Threat model reviewed for this release; open risks accepted or fixed.
- [ ] Privacy notice, consent and age policy published (DPDP Act 2023); grievance contact listed; `DELETE /me` tested end to end (outbox → AI service → storage).
- [ ] Rate limits and quotas configured (`Quotas__*`); edge limits tuned for shared IPs.

## 2. Release procedure

1. Merge to `main` with green CI; tag `vX.Y.Z`; set `SATHI_VERSION=X.Y.Z` (appears as `version` in every log line).
2. Build once, push immutable images tagged `X.Y.Z` and by digest (`SATHI_IMAGE_PREFIX=<registry>/sathi`, `SATHI_IMAGE_TAG=X.Y.Z`); Trivy scan the pushed digests.
3. **Rehearse**: `scripts/prod-rehearsal.sh --observability` with the release images; run the debugging drills D1–D3.
4. Take a logical backup (`backup-restore.md`).
5. Run migrators as one-shot jobs **before** rolling the apps: `migrator-app` (EF Core) and `migrator-ai` (Alembic). Migrations must be **backward compatible** with the previous app version (expand → migrate → contract over two releases); no destructive change in the same release that stops using a column.
6. Roll `ai-service` / `ai-ingest`, then `api` / `jobs`, then `web` (health: `/health/ready`). Watch the *API & errors* dashboard and alerts for 15 minutes.
7. Announce; record the release in the changelog with the image digests.

## 3. Rollback

- **App only (no schema change):** redeploy the previous image tags/digests; config is unchanged.
- **With an expand-only migration:** roll the apps back; leave the schema (old code ignores new columns/tables).
- **With a breaking migration (should not happen, see step 5):** stop writes (scale `api`/`jobs` to 0, maintenance page), restore the pre-release backup or PITR to the pre-migration timestamp, redeploy previous images. Document the incident.
- **AI provider incident:** `AI_KILL_SWITCH=true` (chat returns `LLM_DISABLED`, the rest of the product keeps working) or switch `LLM_MODEL` to the fallback model.
- Hangfire jobs are idempotent; after a rollback re-enqueue failed jobs from the dashboard.

## 4. Azure Container Apps mapping (current assumption)

| Compose | Azure | Notes |
| --- | --- | --- |
| `web` | Container App, external ingress (HTTPS) | Or Azure Front Door / App Gateway in front; SSE needs response buffering off |
| `api` | Container App, internal ingress | min replicas ≥ 2; health probes `/health/live`, `/health/ready` |
| `jobs` | Container App, internal ingress, 1 replica | Hangfire server; scale with care (queues are DB-backed so >1 is safe) |
| `ai-service` | Container App, internal ingress | CPU/memory sized for fastembed; egress via NAT gateway with allow-listed destinations if possible |
| `ai-ingest` | Container App, internal ingress | Separate scale rule; `AI_INSTANCE_ROLE=ingest` |
| `migrator-app`, `migrator-ai` | Container Apps **Jobs** (manual trigger) | Run in the release pipeline before rolling apps |
| `postgres` | Azure Database for PostgreSQL Flexible Server | pgvector allow-listed; private endpoint |
| `minio` | Azure Blob Storage (S3-compatible layer or Blob SDK behind the storage interface) | Private container; managed identity preferred over keys |
| `mailpit` | Azure Communication Services Email / SendGrid / SES SMTP relay | `SMTP_*` from Key Vault |
| `.env` | Key Vault references in Container App secrets | Managed identity for Key Vault access |
| `networks` | Container Apps environment in a VNet; internal ingress = `internal`; NSG/NAT for egress | Only `web` has external ingress |
| observability profile | OTel Collector Container App → Azure Monitor (Application Insights + Log Analytics) or Grafana Cloud | Same OTLP from apps; dashboards/alerts re-created there |
| `scripts/` | Bicep/Terraform in `infrastructure/iac/` (final phase) | |
