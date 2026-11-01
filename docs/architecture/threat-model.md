# Sathi — Threat Model

- Version: 2 (Release 2: classes, roles, guardian consent, RS256 service tokens, per-service storage users)
- Date: 2026-10-22 (v1: 2026-10-17)
- Method: STRIDE per trust boundary and feature area
- Sources: [contracts.md](contracts.md) (source of truth), master spec §4, §7, §8, §18, §22, ADRs in [../decisions/](../decisions/README.md)
- Review: at each phase end, before any real learner data, and whenever a boundary, provider or data flow changes.

## Status legend

Nothing in this document is claimed as implemented. Each mitigation carries one status:

| Status | Meaning |
| --- | --- |
| **Designed** | Specified in contracts.md or an ADR; must be implemented and code-reviewed. |
| **Verify in tests** | Designed **and** must be proven by a named automated test (unit, integration, Playwright, golden set or CI gate) before the feature is accepted. |
| **Gap** | Known weakness with no mitigation yet; tracked in [Open risks / backlog](#9-open-risks--backlog). |

## 1. Scope

In scope: the Compose deployment (and its production equivalent) — `web` (Nginx + Angular), `api`, `jobs`, `ai-service`, `ai-ingest`, `postgres`, `minio`, `mailpit`/SMTP, migrators, the observability stack, CI/CD, and third parties (Anthropic, Tavily/Brave, web pages fetched for search).

Out of scope for v1: the Lab track, the Stretch agents phase (re-model before enabling tools), cloud IaC (modelled when a target is chosen), physical and endpoint security of developer machines (beyond secret handling).

## 2. Assets

| Asset | Where | Sensitivity |
| --- | --- | --- |
| Credentials: password hashes, sessions (`sathi.auth`), antiforgery tokens, email/reset tokens | `app.users`, cookies, emails | High |
| Learner personal data: email, display name, preferences, timezone, date of birth, `is_minor`, guardian email | `app.users`, `user_preferences` | High (personal data under DPDP; children's data for minors) |
| Guardian consent records (guardian email, policy version, decision, timestamps, IP/UA hashes) | `app.guardian_consents` | High (proof of lawful processing; long retention) |
| Bearer links: class invite, staff invite and guardian consent tokens (only SHA-256 stored) | emails, URLs, `class_invites`, `staff_invites`, `guardian_consents` | High (grant access, a role, or consent) |
| Class join codes | `app.classes.join_code` | Medium (shared secret for private courses) |
| Learner content: chat messages, uploads, parsed text, chunks, free-text answers, grading feedback | `app.messages`, MinIO `sathi-documents`, `ai.document_chunks`, `app.submitted_answers`, `grading_results` | High |
| Learning profile: mastery, history, recommendations, revision cards | `app.concept_mastery*`, `recommendations`, `revision_cards` | High (profiling; sensitive for minors) |
| Debug captures (full prompts/responses) | `ai.debug_captures` | High, 72 h |
| Secrets: service-token **private** key `SERVICE_TOKEN_PRIVATE_KEY_PEM_B64` (api/jobs only), DB role passwords, MinIO root and per-service storage keys (`STORAGE_APP_*`, `STORAGE_AI_*`), `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`/`BRAVE_API_KEY`, SMTP password, `LOG_HASH_SALT`, DataProtection keys | env / secret store, `app.data_protection_keys` | Critical |
| Course content and question bank (incl. correct answers, rubrics) | `app.courses`…`rubrics` | Medium (integrity matters) |
| Run ledger, audit events | `app.ai_runs`, `ai_run_steps`, `audit_events` | Medium (integrity, repudiation) |
| Telemetry (logs, traces, metrics) | Loki, Tempo, Prometheus | Medium (must contain no personal content) |
| Budget (LLM and search spend) | provider accounts | Medium (denial of wallet) |

## 3. Actors

Anonymous internet user; registered Student (possibly a minor); a minor's guardian; Instructor (owner or co-instructor of a course); Admin/AI engineer; compromised account of any role; malicious document author (upload or course content); malicious web page owner; compromised dependency or image; compromised or misbehaving third-party provider; insider with access to logs, backups or Grafana.

## 4. Architecture and trust boundaries

```text
 Browser ──TB1──> web (Nginx :8080, only published port)      [public, app]
                    │  /api/ → api:8080   /hangfire → jobs:8080
                    └──TB2──> api, jobs                         [app, internal, observability]
                                 │  RS256 service token (AI side holds public keys only), /internal/v1
                                 └──TB3──> ai-service, ai-ingest [internal, egress, observability]
                                              └──TB4──> Anthropic API, Tavily/Brave, fetched web pages (Internet, HTTPS)
 api, jobs, ai-service, ai-ingest ──TB5──> postgres (roles sathi_app / sathi_ai / sathi_hangfire), minio, SMTP   [internal]
 api, jobs, ai ──TB6──> otel-collector ──> Tempo, Loki, Prometheus ──> Grafana (operators)   [observability]
```

| ID | Boundary | Crossing controls |
| --- | --- | --- |
| TB1 | Browser ↔ `web` | TLS in staging/production (HSTS); Nginx sets `X-Request-Id`, forwards `traceparent`; CSP with `frame-ancestors 'none'`; `client_max_body_size 26m`; rate limits on `/api/v1/auth/` and `/api/v1/client-errors`; SSE location unbuffered. |
| TB2 | `web` ↔ `api`/`jobs` (`app` network) | Cookie auth + antiforgery (ADR-0008); per-user and per-IP rate limits; ASP.NET forwarded headers trusted **only** from `web` (so client IPs used for rate limits cannot be spoofed). Health endpoints not routed through `web`. |
| TB3 | `api`/`jobs` ↔ `ai-service`/`ai-ingest` (`internal`, `internal: true`) | Short-lived RS256 service token with `kid`, `aud`, `scp`, `rscope` (ADR-0015, supersedes ADR-0009); the AI side holds only public keys and cannot mint tokens; network isolation as second layer; AI service never reachable from `public`/`app`. |
| TB4 | `ai-service`/`ai-ingest` ↔ Internet (`egress`) | Only these two services have egress; outbound HTTPS to LLM/search providers; SSRF-guarded fetcher for web pages; no personal data in search queries. |
| TB5 | Services ↔ `postgres`/`minio`/SMTP | Per-schema DB roles with `USAGE` only on own schema; no cross-schema FKs; MinIO bucket private; per-service storage users with prefix-scoped policies, root credentials only in `minio`/`minio-init` (ADR-0016); storage keys generated server-side. |
| TB6 | Services ↔ observability stack | Redaction in app and in the collector attributes processor; Grafana behind authentication and not published through `web`. |

## 5. STRIDE analysis

### 5.1 Authentication and sessions

| Threat | STRIDE | Mitigation | Status |
| --- | --- | --- | --- |
| Credential stuffing / brute force on login | S | Lockout 5 failures → 15 min (`AUTH_LOCKED_OUT`); 10 req/min per IP on auth endpoints in API and Nginx; password policy ≥ 10 chars, letter + digit; `auth.login_failed` logged with `user_id_hash` only. | Verify in tests |
| Breached/common passwords accepted | S | Breached-password check (k-anonymity range API or local list). | Gap |
| Session cookie theft via XSS | S, I | `sathi.auth` HttpOnly, Secure (non-dev), SameSite=Lax; strict CSP (no inline script, no `unsafe-eval`); Angular sanitisation of Markdown/LaTeX/model output; no `bypassSecurityTrust*` on model output. | Verify in tests |
| CSRF on mutating endpoints, including the SSE POST | T | Antiforgery `XSRF-TOKEN` cookie + `X-XSRF-TOKEN` header on every non-GET; relative URLs only; `/client-errors` is the only exemption and accepts no user content. | Verify in tests |
| Clickjacking of sign-in or settings | T | CSP `frame-ancestors 'none'`. | Verify in tests |
| Account enumeration | I | `register`, `resend-verification`, `forgot-password` always return 202; identical timing path where practical; `AUTH_EMAIL_TAKEN` only on register (accepted trade-off; rate-limited). | Designed |
| Verification/reset token leakage via URLs (`?email=..&token=..`) in Nginx access logs, browser history, `Referer`, trace `url.full` attributes | I | Nginx log format omits query strings (`$uri`, not `$request_uri`) at least for `/auth/`; `Referrer-Policy: no-referrer` on auth pages; collector/SDK scrub URL query attributes; Identity tokens single-use (security stamp) with short expiry. | Verify in tests |
| Stolen cookie remains valid after logout/password change, role removal or lock | S, E | Security-stamp validation every **1 minute** (`ValidationInterval`); password reset, role change, lock and deletion update the stamp, so the session loses access within a minute (ADR-0013); logout clears cookie. | Verify in tests |
| IDOR: reading another user's conversation, document, attempt | I, E | Resource ownership checked in every handler; other users' resources return 404 `NOT_FOUND`; access-isolation test suite (user A never reads user B). | Verify in tests |
| Role escalation (Student → Instructor/Admin) | E | Self-registration always creates a Student (ADR-0013); roles granted only by an Admin (`PUT /admin/users/{id}/roles`) or by a staff invite bound to an email; role policies on `/instructor/*` and `/admin/*`; no role fields accepted in user-editable bodies; `user.roles_changed` audit with before/after. | Verify in tests |
| Admin lock-out of the system (removing the last Admin, self-demotion by mistake or by a hijacked session) | D, E | `ROLE_LAST_ADMIN`, `ROLE_SELF_DEMOTION` guards; audit events. | Verify in tests |
| Instructor reaches another instructor's course | E, I | Management endpoints require a `course_instructors` row (or Admin); others get 404/403; insights and grading queue limited to own courses. | Verify in tests |
| Spoofed client IP defeats IP rate limits | S | Forwarded headers accepted only from the `web` container network. | Designed |
| Repudiation of security-relevant actions | R | `audit_events` (`auth.login`, `user.delete_requested`, `document.delete`, `grading.review`, `debug_capture.enable`) with `trace_id`, long retention. | Designed |
| Admin account takeover | S, E | Lockout and rate limits; seed admin password from secret store, rotated after first login. MFA (TOTP) for Admin/Instructor. | Gap (MFA) |
| DataProtection key theft → forge cookies | S | Keys in `app.data_protection_keys` readable only by `sathi_app`; production keys encrypted at rest with a secret-store key; DB backups encrypted. | Designed |

### 5.2 Uploads and ingestion

| Threat | STRIDE | Mitigation | Status |
| --- | --- | --- | --- |
| Disguised file type (executable renamed `.pdf`) | T | Allow-list by extension **and** magic bytes: `.pdf` `%PDF-`; `.docx` `PK\x03\x04` with a `word/` entry; `.md`/`.txt` valid UTF-8, no NUL bytes; else 415 `UPLOAD_INVALID_TYPE`. Client `Content-Type` is not trusted. | Verify in tests |
| Oversized uploads / storage exhaustion | D | Nginx `client_max_body_size 26m`; API 25 MB (`Quotas__MaxUploadBytes=26214400`), 200 MB per user, 20 uploads/day → 413/429; streaming to storage (no full buffering in memory). | Verify in tests |
| Zip bomb inside `.docx` | D | Before parsing: cap entry count, total uncompressed size and per-entry compression ratio; reject nested archives and encrypted entries; parse in `ai-ingest` only with `INGEST_CONCURRENCY=2` and container memory limits; per-job timeout. | Verify in tests |
| XXE / external references in `.docx` XML | I, T | XML parsed with DTDs and external entities disabled (e.g. defusedxml); external relationships (`TargetMode="External"`) ignored, never fetched. | Verify in tests |
| Malicious PDF exploiting the parser (crafted objects, JavaScript, infinite loops) | E, D | Text extraction only (no rendering, no JS, no embedded file extraction); page and time limits; `ai-ingest` runs non-root with read-only root filesystem and no access to secrets it does not need; parser pinned and updated by Dependabot. Subprocess sandbox with rlimits. | Designed (sandbox: Gap) |
| Path traversal / key injection via filename | T | Storage key built server-side: `uploads/{ownerUserId}/{documentId}/v{version}/{sanitizedFileName}`; owner from session, IDs server-generated; filename sanitised to a safe character set; original name kept only as metadata. | Verify in tests |
| Direct access to stored files | I | Bucket private; no public URLs; files never served back to browsers in v1 (only chunk snippets ≤ 240 chars in citations, scoped). | Designed |
| Malware stored and later distributed | T | Original files are not downloadable by other users; course-scope uploads come from Instructors only. **No antivirus scanning** (e.g. ClamAV sidecar) yet. | Gap |
| Duplicate submissions / replay | T | `Idempotency-Key` on `POST /documents`; `ingestion_jobs` unique on (`document_id`, `document_version`); index step deletes then inserts in one transaction. | Verify in tests |
| Scanned PDFs silently empty | D | `INGEST_NO_TEXT` surfaced with reference ID. | Verify in tests |

### 5.3 RAG and prompt injection

| Threat | STRIDE | Mitigation | Status |
| --- | --- | --- | --- |
| Instructions embedded in uploads, course docs or web pages hijack the tutor ("ignore previous instructions…") | T, E | Retrieved text and web pages are passed as **quoted data** inside labelled source blocks with `source_type`; system prompt states that source content is never instructions; tutor rules first, data last; learner answers in grading passed as quoted data. | Verify in tests (golden `injection` dataset) |
| Cross-user data leak through retrieval | I | Scope from the verified token's `rscope` only, filtered **inside SQL before ranking** (`course_ids` / `user_id`), never from request bodies. | Verify in tests (isolation) |
| Fabricated or mismatched citations | T | Citation check: every `[n]` must map to a source actually supplied; invalid markers removed (`citationsDropped`), only valid `citation` events sent. | Verify in tests |
| Data exfiltration through model output (e.g. Markdown image or link to attacker URL carrying data) | I | Angular renders model Markdown without raw HTML and without auto-loading remote images; links shown with visible URL, `rel="noopener noreferrer"`; CSP `img-src` restricted. | Verify in tests |
| LLM performs harmful actions | E | Core has **no tools**: the LLM has no DB, shell, file-system or network access; all reads are done by code with scoped queries. The Stretch agents phase requires a separate threat model, allow-listed read-only tools scoped by the token, step and spend limits. | Designed |
| Poisoned course content (malicious Instructor or compromised account) affects all students | T | Instructor actions audited; lesson versioning; course docs treated as data like uploads; review before publishing. | Designed |
| Prompt/system-prompt extraction | I | Prompts contain no secrets or other users' data; accepted residual risk. | Designed |
| Harmful or age-inappropriate answers | T | Provider safety behaviour, refusal handling (`LLM_REFUSED`), tutor rules scoped to the course; feedback thumbs reviewed. | Designed |

### 5.4 Web fetch and SSRF

| Threat | STRIDE | Mitigation | Status |
| --- | --- | --- | --- |
| Fetching internal services (`postgres:5432`, `minio:9000`, `api:8080`, collector) — `ai-service` sits on `internal` | I, E | Resolve the hostname, validate **every** resolved IP, then connect to that validated IP (no second lookup); block loopback, RFC 1918, CGNAT `100.64/10`, link-local `169.254/16`, `0.0.0.0/8`, multicast/broadcast, IPv6 `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6; reject single-label/Docker service names. | Verify in tests |
| Cloud metadata endpoint (`169.254.169.254`, `fd00:ec2::254`) | I, E | Covered by link-local/ULA blocks; explicit test cases. | Verify in tests |
| DNS rebinding (first lookup public, second private) | S, E | Pin the validated IP for the connection (custom resolver/transport); SNI/Host still the original hostname for HTTPS. | Verify in tests |
| Non-HTTP schemes (`file://`, `gopher://`, `ftp://`) | E | Allow only `http`/`https`; only ports 80/443. | Verify in tests |
| Redirect to a blocked address | E | Follow at most a few redirects manually, re-validating scheme, host, resolved IP and port at each hop. | Verify in tests |
| Huge or slow pages (resource exhaustion) | D | Response-size cap, connect/read/total timeouts, content-type allow-list (`text/html`, `text/plain`), decompression size limit. | Verify in tests |
| Page content leaks into logs | I | Log URL, status, size, latency only; never page text. | Verify in tests |
| Personal data sent to the search provider | I | Topic-only query rewrite plus deterministic scrubber (emails, phones, long digit runs, display name); upload text and full conversations never sent (ADR-0006). | Verify in tests |
| Defence in depth | — | Dedicated egress proxy (e.g. allow-listed forward proxy) so the fetcher has no route to `internal`. | Gap |

### 5.5 Internal service token

| Threat | STRIDE | Mitigation | Status |
| --- | --- | --- | --- |
| Token leak via logs, traces or job arguments | I | Redaction of `authorization`/`token` keys and bearer patterns in app and collector; tokens minted at call time, never stored in Hangfire arguments. | Verify in tests |
| Replay of a captured token | S | `exp = iat + 300 s`; internal network only; `rid` bound to the request. A `jti` replay cache is not implemented. | Designed (`jti`: Gap) |
| Scope escalation (user request carries `admin`/`eval`) | E | Minimal per-endpoint scopes; `api` never mints `admin`/`eval` for user requests; FastAPI enforces scope per route (403). | Verify in tests |
| Retrieval scope widened through request body | E, I | `rscope` claim is the only scope source; body IDs ignored for authorization. | Verify in tests |
| Wrong audience / issuer / algorithm accepted | S | Verify `aud = ai-service`, `iss ∈ {sathi-api, sathi-jobs}`; algorithm allow-list is **RS256 only** — reject `none`, `HS256` signed with the public key (alg confusion) and unknown `kid`; small clock skew. | Verify in tests |
| Forged tokens from a compromised AI container | S, E | **Closed by ADR-0015:** `ai-service`/`ai-ingest`/`migrator-ai` receive only `SERVICE_TOKEN_PUBLIC_KEYS`; the private key exists only in `api`/`jobs` (checked with `docker compose config`). | Verify in tests |
| Signing-key compromise (`api`/`jobs` or the secret store) | S, E | Key in the secret store; `kid`-based rotation without downtime (add new public key, switch signers, drop old key after > 300 s); incident procedure = immediate rotation. Workload identity remains the production target. | Designed |

### 5.6 Data deletion and retention

| Threat | STRIDE | Mitigation | Status |
| --- | --- | --- | --- |
| Account deletion leaves data in the AI service or storage | I | `DELETE /me` (password re-check) soft-deletes, signs out and writes `user.deleted` to `outbox_messages`; `ProcessOutboxJob` (every minute, `critical`) calls `DELETE /internal/v1/users/{userId}` (chunks, debug captures) and removes `uploads/{userId}/…` and `parsed/…` objects; retries with `attempts`/`last_error`; alert on stuck messages. | Verify in tests |
| Document deletion leaves chunks or files | I | `document.deleted` outbox → `DELETE /internal/v1/documents/{id}` (all versions) + storage versions; deletes idempotent. | Verify in tests |
| Soft-deleted data retained indefinitely | I | `RetentionCleanupJob` purges soft-deleted rows after 30 days, expires debug captures (72 h), trims `ai_run_steps` metrics after 90 days. Purge must also null `ai_runs.user_id` and remove email/display name. | Designed |
| Data survives in backups after erasure | I | Backups encrypted, fixed rotation window documented; keep a deletion ledger (IDs only) and re-apply deletions after any restore. Erasure is complete only when the backup window has passed — state this in the privacy notice. | Gap (ledger + documented window) |
| Pseudonymous residue (`user_id_hash` in logs, `ai_runs`, `audit_events`) | I | Logs expire with retention; `user_id_hash` is an HMAC with a secret salt; audit events kept for security/legal reasons with minimal metadata. Legal review of audit retention after erasure. | Designed |
| Hangfire job history contains identifiers | I | Arguments are IDs only; history expires. | Designed |
| Malicious deletion request (stolen session) | T | Password re-confirmation; audit event; confirmation email. | Designed (email: Gap) |

### 5.7 Logging and observability leakage

| Threat | STRIDE | Mitigation | Status |
| --- | --- | --- | --- |
| Secrets or personal data in logs/spans | I | Never log passwords, tokens, cookies, keys, raw emails/user IDs, documents, prompts, answers; redaction by key pattern and value pattern (email, bearer, `sk-`); second redaction in the collector attributes processor; CI test with a seeded secret fails the build if it appears. | Verify in tests |
| Query strings with tokens/emails in access logs and `url.full` | I | See 5.1; Nginx log format and collector scrubbing of URL query attributes. | Verify in tests |
| Debug capture misuse (full prompts/answers) | I, R | Admin only, per conversation, `hours ≤ 24` to enable, audit event `debug_capture.enable`; stored separately in `ai.debug_captures` with `expires_at` 72 h and purged by retention; read only through admin endpoints; capture of a minor's conversation needs a documented justification (see §6). Periodic audit review of enablements. | Verify in tests (expiry + audit) |
| Unauthenticated access to Grafana/Loki/Tempo | I | Not published through `web`; Grafana authentication on; production behind SSO; Loki/Tempo/Prometheus have no host ports outside dev. | Designed |
| Client error reports carry user content | I | `/client-errors` message ≤ 300 chars, "no user content" rule enforced in the Angular reporter; server truncates and redacts. | Verify in tests |
| Log injection / forged log lines | T | Structured JSON logging (no string concatenation into the format). | Designed |
| Insufficient logs to investigate an incident | R | Reference ID → trace → logs → run ledger; audit events in DB. Log retention vs. DPDP Rules security-log retention to be reconciled (see §6). | Designed |

### 5.8 Admin surfaces and Hangfire dashboard

| Threat | STRIDE | Mitigation | Status |
| --- | --- | --- | --- |
| Non-admin access to `/hangfire` | E, I | Dashboard authorization filter requires an authenticated Admin (cookie decrypted with shared DataProtection keys); anonymous/Student → 401/403. | Verify in tests |
| CSRF on dashboard actions (requeue, delete) | T | Dashboard POST actions protected by antiforgery; `SameSite=Lax`; verify in tests. Consider read-only dashboard (`IsReadOnlyFunc`) for all but one operator role. | Verify in tests |
| Dashboard reachable from the internet in production | I | Restrict `/hangfire` and `/api/v1/admin/*` by network (VPN/IP allow-list) in production, or disable the dashboard there. | Gap |
| Admin run lookup exposes learner content | I | `AiRunDetail` carries metadata, hashes and metrics, not prompts or answers (except via audited debug capture). | Designed |
| Runtime log-level change used to harvest data | I | `PUT /internal/v1/admin/log-level` requires `admin` scope; redaction still applies at Debug level. | Verify in tests |
| Instructor sees students' answers in grading queue | I | Restricted to the instructor's courses; `studentDisplayName` only, no email; review actions audited. | Verify in tests |

### 5.9 Cost abuse (denial of wallet)

| Threat | STRIDE | Mitigation | Status |
| --- | --- | --- | --- |
| One user drains the LLM budget | D | Per-user daily quotas (`Quotas__ChatMessagesPerDay=200`, web 20, uploads 20) → `QUOTA_EXCEEDED`/`WEB_SEARCH_QUOTA_EXCEEDED`; 120 req/min per user; bounded `max_tokens`; history trimmed to 8 turns; message length validated. | Verify in tests |
| Many accounts (sybil) multiply quotas | D | Email verification required to sign in; registration rate-limited per IP. CAPTCHA / disposable-domain blocking. | Designed (CAPTCHA: Gap) |
| Global overspend | D | `LLM_DAILY_SPEND_CAP_USD` → `SPEND_CAP_REACHED`; `WEB_SEARCH_DAILY_SPEND_CAP_USD`; `AI_KILL_SWITCH` → `LLM_DISABLED`; `SEARCH_PROVIDER=none`; spend alert before the cap; provider-side monthly limit on the account. | Verify in tests |
| Long or unwanted answers keep generating tokens | D | Cancel endpoint aborts the upstream stream and records usage only for generated tokens; AI service stops the LLM stream on disconnect (ADR-0017). | Verify in tests |
| Retries multiply cost | D | Bounded retries (jobs 3 at 10/60/300 s; LLM bounded + one fallback); `Idempotency-Key` on chat send prevents double charging on resend. | Verify in tests |
| Instructor question generation loops | D | `count` 1–10; `ai-heavy` queue with 1 worker; cap applies. | Designed |
| Ingestion CPU exhaustion | D | Local embeddings (no spend); `ai-ingest` separate with `INGEST_CONCURRENCY=2` and resource limits; upload quotas. | Designed |

### 5.10 Supply chain and secrets

| Threat | STRIDE | Mitigation | Status |
| --- | --- | --- | --- |
| Vulnerable dependency or base image | T, E | Trivy in CI fails on CRITICAL (HIGH reported); Dependabot for NuGet, Python, npm, Docker and Actions; lock files (`packages.lock.json`, `uv.lock`, `package-lock.json`) with locked restores. | Verify in tests (CI gate) |
| Mutable image tags change under us | T | Base and service images pinned (version + digest); `pgvector/pgvector:pg17` pinned by digest. | Designed |
| Committed secrets | I | gitleaks in pre-commit and CI; `.env` never committed; `.env.example` only; `.dockerignore` excludes `.env`; no keys baked into images. | Verify in tests (CI gate) |
| Compromised GitHub Action | T, E | Actions pinned to commit SHAs; least-privilege `permissions`; no secrets to fork PRs; CI uses fake providers (no real keys). | Designed |
| Tampered model or prompt files | T | Embedding model pinned by revision/hash at image build; prompts versioned in git with hash recorded per run. | Designed |
| Malicious npm/pip install scripts | E | Locked installs, Dependabot review; consider `--ignore-scripts` where possible. | Designed |
| Container breakout impact | E | Non-root images, read-only root FS where possible, no Docker socket mounts, resource limits. | Designed |
| Shared MinIO root credentials (api, jobs, ai) | E, I | **Closed by ADR-0016:** `minio-init` creates `STORAGE_APP_*` (api/jobs: Get/Put/Delete `uploads/*`, `lessons/*`; Delete `parsed/*`; List) and `STORAGE_AI_*` (ai: Get `uploads/*`, `lessons/*`; Get/Put/Delete `parsed/*`; List); root only in `minio`/`minio-init`. Proven by an `mc` policy test (AI user cannot write `uploads/`; app user cannot write `parsed/` but can delete it; neither can administer storage or create buckets). | Verify in tests |
| Deleted objects survive as non-current versions (bucket versioning on) | I | Lifecycle rule expiring non-current versions (e.g. 30 days) or deleting specific versions on erasure. | Gap |
| No SBOM / image signing | R | Generate SBOM (e.g. Syft/Trivy) and sign images (cosign) before production. | Gap |

### 5.11 Course access, classes and invites (ADR-0012, ADR-0013)

| Threat | STRIDE | Mitigation | Status |
| --- | --- | --- | --- |
| Student reads a private course without membership (direct URLs, lesson IDs, tutor scope) | I, E | One access rule in the API for every course/lesson/practice/tutor endpoint (`public` OR active member of a non-archived class); otherwise 404 `NOT_FOUND`; the tutor's `rscope.course_ids` is built from the same rule. | Verify in tests |
| Leaked join code (posted publicly, forwarded) admits strangers to a private course | I | Instructors can regenerate the code, disable joining, archive the class and remove members; members list shows `joinedVia` and join time; guidance in the UI that codes are shared secrets. | Designed |
| Join-code guessing | I | 8 chars from a 32-symbol alphabet (~10^12 codes); `POST /classes/join` rate-limited per IP at the edge (auth zone) and per user in the API; failures logged. | Verify in tests |
| Class or staff invite link forwarded or intercepted | S, E | Token is single-use, 14 days (class) / 7 days (staff), only its SHA-256 stored; acceptance requires being signed in **with the invited email** (`CLASS_INVITE_EMAIL_MISMATCH`, staff: same email at registration); revocation and resend endpoints; audit events. | Verify in tests |
| Invite / consent tokens leak through logs or `Referer` | I | Tokens travel in URL **paths** (`/join/{token}`, `/consent/{token}`, `/api/v1/classes/invites/{token}`, `/api/v1/guardian-consent/{token}`, `/api/v1/auth/staff-invites/{token}`): Nginx access log replaces them with `REDACTED`; `Referrer-Policy` strict-origin; application logs and span attributes must not record the raw path for these routes (route templates only). | Designed (app/collector scrubbing: Verify in tests) |
| Invite emails used to spam third parties | D, R | Only instructors/admins can send; ≤ 100 emails per request; per-instructor rate limit; one email per address; audit. | Designed |
| Removed member keeps access through an open session or cached data | E | Access evaluated per request from `class_members.removed_at`; no access lists in cookies. | Verify in tests |

### 5.12 Guardian consent (ADR-0014)

| Threat | STRIDE | Mitigation | Status |
| --- | --- | --- | --- |
| A child enters their own second address as the "guardian" (weak verification) | S | Consent requires control of the guardian mailbox only; record kept with policy version and IP/UA hashes; DPDP Rules may require identity/age verification of the guardian (DigiLocker-style token) — legal review. | Gap (verification strength) |
| A minor claims to be 18+ | S | Self-declared DOB; notice states the rule; accepted residual risk unless the Rules require age assurance. | Gap (legal review) |
| Consent link forwarded or guessed | S | 32-byte token, SHA-256 stored, 7-day expiry, single decision per token; page shows the masked learner email and the data list before deciding. | Verify in tests |
| Malicious withdrawal or decline (someone with the link deletes the learner) | D, T | Link sent only to the guardian address; withdrawal soft-deletes (30-day purge window allows support restore after verification); confirmation emails to guardian and learner; audit event. | Designed |
| Consent emails used to spam arbitrary addresses via registration | D | Registration and `POST /auth/resend-guardian-consent` rate-limited (auth zone), resend always 202; one pending consent per learner. | Verify in tests |
| Processing before consent | I | Sign-in blocked until `granted` (`AUTH_GUARDIAN_CONSENT_PENDING`); background jobs skip accounts that are not active. | Verify in tests |
| Excess child data | I | Only DOB, `is_minor`, guardian email and the consent record; no ID documents; IP/UA stored as hashes. | Designed |

## 6. Minors and India's DPDP Act 2023

Sathi is an Indian-context learning product that may attract school students. The DPDP Act 2023 treats anyone under 18 as a **child**. The DPDP Rules, 2025 were notified in November 2025 with phased commencement; confirm current commencement dates with counsel before launch. This section is engineering guidance, not legal advice; items marked Gap need a legal review before real users.

**Release 2 decision (ADR-0014):** registration asks for the date of birth; under `Privacy:MinimumAge` (8) is refused; under 18 requires a guardian email and the account stays inactive until the guardian grants consent through an emailed link. The verification strength (mailbox control) must be confirmed against the DPDP Rules by counsel before real minors use the system.

| Obligation (DPDP Act) | Sathi design | Status |
| --- | --- | --- |
| **§9(1) Verifiable parental consent** before processing a child's data | Guardian email consent (ADR-0014, contracts §11.4): child account inactive until `granted`; `guardian_consents` record (guardian email, policy version, timestamps, decision, IP/UA hashes); withdrawal link in every confirmation; withdrawal deletes the learner. Upgrade to verified adult identity per the Rules (details already held or a virtual token, e.g. DigiLocker) if counsel requires. | Designed (verification strength: Gap) |
| **§9(2) No processing likely to cause detrimental effect** on a child's well-being | Tutor rules scoped to education; provider safety + refusal handling; no public profiles, no social features, no leaderboards that shame. | Designed |
| **§9(3) No tracking, behavioural monitoring or targeted advertising** directed at children | No ads, no ad SDKs, no third-party analytics trackers, no engagement-optimisation. Open question: mastery tracking and recommendations are behavioural profiling for the child's own learning — legal review whether this falls under §9(3) and whether any exemption in the Rules applies (some exemptions exist for educational institutions; do not assume Sathi qualifies). Success metrics (activation, week-1 return) reported only in aggregate. | Gap (legal review) |
| **Purpose limitation** (§4–§6: processing only for the consented purpose) | Data used only to provide tutoring, progress and reminders; not for model training (provider terms must also exclude training); no sale or sharing. | Designed |
| **Data minimisation** (§6(1): data limited to what is necessary) | Account needs only email, display name, password and date of birth (to apply §9); minors add one guardian email; no phone, school or gender; logs use `user_id_hash`; local embeddings (no third-party embedding); topic-only search queries; debug capture off by default. | Designed |
| **Notice** (§5: itemised data, purposes, how to exercise rights and complain to the Board; English or Eighth Schedule languages) | Privacy notice shown before consent at registration, versioned; lists processors (LLM, search, email) and cross-border transfer. | Gap |
| **Consent and withdrawal** (§6: free, specific, informed; withdrawal as easy as giving) | Guardian consent records with `policy_version` (`Privacy:ConsentPolicyVersion`) and one-click withdrawal (ADR-0014); reminders opt-out (`reminders_enabled`); adult consent checkbox with notice version still to be recorded. | Designed (adult consent records: Gap) |
| **Right to erasure** (§8(7), §12) | `DELETE /me` → soft delete → outbox to AI service and storage → purge after 30 days; document deletion per file; processors (LLM/search providers) bound by their retention terms; backup window disclosed. | Verify in tests |
| **Right to access/correction** (§11, §12) | `GET /auth/me`, preferences edit, conversation and document lists; a full data export endpoint. | Designed (export: Gap) |
| **Grievance redressal** (§8(10), §13) and contact person (§8(9)) | Published contact (email/form) for the designated person, response SLA, ticket log; Data Principals informed of right to approach the Data Protection Board. | Gap |
| **Breach notification** to the Data Protection Board and each affected Data Principal (§8(6); Rules set content and timelines, with a detailed report to the Board reported as within 72 hours) | Incident runbook: detect (alerts, audit), contain (kill switch, secret rotation, session invalidation via security stamp), assess, notify Board and users, post-mortem. | Gap (runbook) |
| **Reasonable security safeguards** (§8(5)) | This threat model; encryption in transit (TLS) and at rest (DB/backup/storage encryption in production); access control; logging; the Rules include log-retention expectations (reported as at least one year for some logs) — reconcile with 30-day diagnostic logs (audit events in DB are the candidate store). | Designed (retention reconciliation: Gap) |
| **Data Fiduciary responsibility for processors** (§8(1)–(2)) | Contracts/terms with Anthropic, Tavily/Brave, email provider, hosting provider reviewed; processor list kept in the notice. | Gap |
| **Cross-border transfer** (§16: permitted except to countries the Government restricts) | LLM and search providers process data outside India. Send only what is needed (question, trimmed history, retrieved passages — no names/emails); verify provider retention, training opt-out and zero-data-retention eligibility (ADR-0005); check the restricted-country list before launch; disclose in notice. | Designed (provider review: Gap) |
| **Penalties** (Schedule: up to ₹250 crore for security safeguard failures; up to ₹200 crore for breach-notification and children's-obligation failures) | Drives prioritising the Gaps above before any minor or real learner uses the system. | — |

## 7. Residual risks accepted for local development

- Local stack runs over plain HTTP on `localhost:8080`; cookies are not `Secure` in `development`.
- Mailpit and MinIO consoles are dev-only and must not exist in `compose.prod.yaml`.
- Seeded demo users (`SEED_DEMO_USERS=true`) only in development.
- Development uses separate low-limit provider keys or fake mode.

## 8. Verification summary (tests that must exist)

Access isolation (user A vs B across conversations, documents, attempts, retrieval); cookie flags and CSRF; lockout; upload type/size/zip-bomb/XXE cases; storage key sanitisation; golden `injection` dataset (uploads and hostile web page); citation check; SSRF suite (private ranges, metadata IP, rebinding, schemes, redirects, size/time caps); service-token validation (exp, aud, iss, RS256-only / alg confusion, unknown `kid`, scope, two-key rotation window); MinIO policy test (per-service users); private-course isolation (non-member 404 on every endpoint), join code/invite email binding/expiry, removal; role changes and lock reach a live session within 1 minute, last-admin/self-demotion guards; guardian consent gating, decline/withdrawal deletion, token expiry; tutor cancel (owner-only, idempotent, partial content + usage) and `STREAM_INTERRUPTED` recovery; outbox deletion end to end; retention purge; seeded-secret log test; debug-capture expiry and audit; `/hangfire` authorization; quota, spend cap and kill-switch tests; Trivy and gitleaks CI gates.

## 9. Open risks / backlog

| # | Item | Priority |
| --- | --- | --- |
| 1 | Legal review of DPDP §9 and the DPDP Rules for the guardian-consent flow (ADR-0014): verification strength (email vs. verified adult identity / DigiLocker token), behavioural-monitoring question, exemptions, retention of consent records — before any real minors | High |
| 2 | Privacy notice, consent records (versioned), grievance contact and process | High |
| 3 | Breach-notification and incident runbook (Board + Data Principals; secret rotation; session invalidation) | High |
| 4 | Provider terms review (Anthropic, Tavily/Brave, SMTP, hosting): retention, training use, ZDR, regions, sub-processors | High |
| 5 | ~~Per-service MinIO credentials~~ — done in Release 2 (ADR-0016). Remaining: lifecycle rule for non-current object versions so deletions are complete | Medium |
| 6 | Restrict `/hangfire` and admin APIs by network in production; MFA for Admin and Instructor | High |
| 7 | Antivirus scanning of uploads (e.g. ClamAV sidecar) and parser sandbox (subprocess with rlimits/seccomp) | Medium |
| 8 | Egress forward proxy with allow-list for the web fetcher (no route to `internal`) | Medium |
| 9 | ~~Asymmetric service tokens~~ — done (RS256, ADR-0015). Remaining: workload identity in production; `jti` if replay risk grows | Low |
| 10 | Deletion ledger re-applied after restore; documented backup retention window; backup-restore drill | Medium |
| 11 | Data export endpoint (access right) | Medium |
| 12 | Breached-password check; CAPTCHA/disposable-email controls on registration | Medium |
| 13 | Reconcile log retention with DPDP Rules security-log expectations | Medium |
| 14 | Production SMTP path: `api`/`jobs` have no egress network — use an internal relay or add scoped egress | Medium |
| 15 | SBOM generation and image signing in CI | Low |
| 16 | Re-model before the Stretch agents phase (tools, MCP, approvals) | Low (until Stretch) |
| 17 | Multilingual content: injection and redaction tests for non-English text when a multilingual embedding model is adopted | Low |
| 18 | Scrub invite/consent tokens from application logs and span attributes (`url.path`, `http.target`) in the API and the collector, as Nginx already does | High |
| 19 | Cross-instance tutor cancel (Redis pub/sub or Postgres `LISTEN/NOTIFY`) before running more than one `api` replica (ADR-0017) | Low (until scale-out) |
| 20 | MFA for Admin and Instructor accounts now that staff can be invited by email | High |
