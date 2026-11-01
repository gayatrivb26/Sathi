# 0009 — HS256 short-lived service token for .NET → AI service calls

- Status: Superseded by [0015](0015-rs256-service-tokens.md) (2026-10-22) — the trigger "a verifier that should not be able to mint tokens" applies; `SERVICE_TOKEN_SECRET` no longer exists
- Date: 2026-10-17
- Deciders: project owner
- Related: [contracts.md](../architecture/contracts.md) §2 (`SERVICE_TOKEN_SECRET`), §6; ADR-0001, ADR-0003, ADR-0008

## Context and Problem Statement

`api` and `jobs` call `ai-service` and `ai-ingest` on the private `internal` network. The AI service must know who the call is for, what it may do, and which data it may retrieve, without trusting request bodies and without seeing user cookies. Network isolation is a second layer, not the authentication. What credential is used?

## Decision Drivers

- Least privilege per call: scopes and retrieval scope bound to the user and request.
- Short replay window; no long-lived bearer credentials on the wire.
- Simple to implement and verify in .NET and Python with standard JWT libraries.
- A clear rotation procedure without downtime.
- A path to asymmetric keys or platform identity later.

## Considered Options

1. JWT signed with HS256 using a shared secret, 300 s lifetime.
2. JWT signed with RS256/ES256 (asymmetric), verifier holds only the public key.
3. Static API key header.
4. Mutual TLS between services.
5. Platform workload identity (e.g. managed identity / OAuth client credentials via an IdP).

## Decision Outcome

Chosen option: **1 — HS256 JWT, 300 s lifetime**, signed with `SERVICE_TOKEN_SECRET` (≥ 32 random bytes, base64-decoded).

**Claims (contract §6):**

| Claim | Value |
| --- | --- |
| `iss` | `sathi-api` or `sathi-jobs` |
| `aud` | `ai-service` |
| `sub` | user ID, or `system` for recurring jobs |
| `uh` | `user_id_hash` (for logs) |
| `scp` | space-separated subset of `tutor ingest quiz grade mastery runs eval admin` |
| `rscope` | `{"course_ids": [...], "user_id": "uuid" \| null}` — the only source of retrieval scope |
| `rid` | request ID |
| `iat`, `exp` | `exp = iat + 300` |

- A new token is minted per outbound request (or per job execution) with only the scopes that endpoint needs; `api` never issues `admin` or `eval` for user requests.
- FastAPI verifies signature, algorithm (`HS256` only; reject `none` and others), `aud == "ai-service"`, `iss` in the allowlist, `exp`/`iat` with ≤ 30 s clock-skew leeway. Missing/invalid/expired → 401 `SERVICE_TOKEN_INVALID`; missing scope → 403.
- Retrieval uses `rscope` inside SQL before ranking (ADR-0003); request-body IDs are never used for scope.
- Tokens are never logged (redaction matches `authorization`/`token`, bearer patterns).

**Rotation plan (dual-secret verification):**

1. Generate a new secret; add it to verifiers as the primary verification key while keeping the old one as secondary (planned key: `SERVICE_TOKEN_SECRET_PREVIOUS`; add it to contracts.md when implemented). Tokens carry a `kid` header so the verifier selects the key; without `kid`, try primary then secondary.
2. Switch signers (`api`, `jobs`) to the new secret.
3. Wait longer than the token lifetime (> 300 s) plus clock skew.
4. Remove the old secret from verifiers. On suspected leak, do steps 1–4 immediately and treat it as an incident.

**Move to RS256/ES256 (or platform identity) when any of these holds:** a verifier that should not be able to mint tokens (today `ai-service` holds the signing secret and could forge tokens to itself or others); a second independent verifier service or a third party; moving to a managed platform where workload identity is available; a compliance or audit requirement for non-repudiation of the issuer. Signers then hold the private key; verifiers fetch the public key (JWKS) and rotation needs no shared-secret distribution.

### Consequences

- Good: tiny implementation, standard libraries, cheap verification; per-request scope and retrieval scope.
- Good: 300 s lifetime limits replay; network isolation adds a second layer.
- Bad: symmetric key — anyone with the secret (including the AI service) can mint any token; compromise of one service compromises the trust boundary.
- Bad: no `jti` replay cache; a stolen token is reusable within its 5-minute window on the internal network.
- Bad: long jobs must mint a fresh token per call, not reuse one from enqueue time.

### Confirmation

- Python tests: expired token, wrong `aud`, wrong `iss`, `alg: none`, tampered signature, missing scope → correct 401/403.
- Isolation test: a token with `rscope.user_id = A` never retrieves B's chunks even if the body names B's document.
- Rotation test: during the dual-secret window, tokens signed with old and new secrets both verify; after removal, old ones fail.
- Log test: no captured log line contains a bearer token.

## Pros and Cons of the Options

- **1. HS256 JWT** — Good: simple, scoped, short-lived. Bad: shared secret, verifier can mint.
- **2. RS256/ES256** — Good: verifiers cannot mint, easier multi-verifier rotation. Bad: key pair management and JWKS endpoint now; more than needed for two internal services today.
- **3. Static API key** — Good: trivial. Bad: no user context, no expiry, no scope.
- **4. mTLS** — Good: strong channel authentication. Bad: certificate management locally; still needs user/scope claims on top.
- **5. Workload identity** — Good: no secrets to rotate. Bad: platform-specific; not available on local Compose. Target for production.

## Links

- RFC 7519 (JWT), RFC 8725 (JWT Best Current Practices)
- Master spec §4 (Internal trust)
