# 0015 — RS256 service tokens for .NET → AI service calls (supersedes 0009)

- Status: Accepted
- Date: 2026-10-22
- Deciders: project owner
- Related: [contracts.md](../architecture/contracts.md) §6, §11.7; supersedes [ADR-0009](0009-hs256-short-lived-service-token.md); ADR-0016

## Context and Problem Statement

ADR-0009 chose HS256 with a shared secret and listed the trigger for moving to asymmetric keys: "a verifier that should not be able to mint tokens". That trigger has fired: `ai-service` and `ai-ingest` parse untrusted uploads and web pages and call external providers, so they are the most exposed containers — and with HS256 a compromise of either one yields the secret that mints **any** token (any `sub`, any `scp` including `admin`, any `rscope`). How do we remove the AI side's ability to forge tokens?

## Decision Drivers

- The verifier must not be able to mint tokens.
- Key rotation without downtime and without distributing a shared secret.
- Same claims and lifetime as today; standard JWT libraries in .NET and Python.
- Works on local Compose (no cloud identity service required).

## Considered Options

1. Keep HS256 (ADR-0009).
2. RS256: signers (`api`, `jobs`) hold an RSA private key; verifiers hold public keys selected by `kid`.
3. ES256 (ECDSA P-256).
4. Platform workload identity / mTLS.

## Decision Outcome

Chosen option: **2 — RS256 with `kid`**, 2048-bit RSA.

- `api` and `jobs` sign with `ServiceToken__PrivateKeyPem` (base64 of a PKCS#8 PEM) and put `ServiceToken__KeyId` in the JWT header (`alg=RS256`, `kid`). Claims, scopes, `rscope` and the 300 s lifetime are unchanged (contracts §6).
- `ai-service` / `ai-ingest` verify with `SERVICE_TOKEN_PUBLIC_KEYS` = comma-separated `kid:base64(SPKI PEM)` entries, accept **only** RS256 (reject `none`, `HS*`, unknown `kid`) and never hold a signing key.
- `.env`: `SERVICE_TOKEN_PRIVATE_KEY_PEM_B64`, `SERVICE_TOKEN_PUBLIC_KEY_PEM_B64`, `SERVICE_TOKEN_KEY_ID` (default `k1`). `SERVICE_TOKEN_SECRET` is removed. `scripts/generate-secrets.sh` (openssl) and `.ps1` (pure .NET) generate the pair; `--add-missing` / `-AddMissing` adds it to an existing `.env`.
- Compose passes the private key only to `api` and `jobs`; the AI containers and `migrator-ai` get only `SERVICE_TOKEN_PUBLIC_KEYS`.

**Rotation (no downtime):**

1. Generate a new pair with a new `kid` (e.g. `k2`).
2. Add `k2:<public>` to `SERVICE_TOKEN_PUBLIC_KEYS` next to `k1:<public>` and restart the verifiers.
3. Switch the signers to the `k2` private key and key ID; restart `api` and `jobs`.
4. After more than 300 s plus clock skew, remove `k1` from the verifiers. On suspected key leak do all steps immediately and treat it as an incident.

In this Compose setup `SERVICE_TOKEN_PUBLIC_KEYS` is built from one key (`${SERVICE_TOKEN_KEY_ID}:${SERVICE_TOKEN_PUBLIC_KEY_PEM_B64}`); a rotation in production sets the variable directly in the secret store.

### Consequences

- Good: a compromised AI container can no longer forge tokens; it can only abuse requests it legitimately receives.
- Good: rotation is a public-key distribution problem; verifiers can hold several keys.
- Bad: signers still hold a long-lived private key (in the secret store in production); a compromise of `api`/`jobs` is still total — as before.
- Bad: slightly larger tokens and slower signing than HMAC (negligible at our request rates).
- Neutral: no JWKS endpoint yet; keys are configuration. Add JWKS if a third verifier appears.

### Confirmation

- Python tests: HS256 token signed with the PEM bytes as secret (alg confusion) → 401; `alg: none` → 401; unknown `kid` → 401; token signed by a key not in the list → 401; two keys listed → tokens from both verify.
- .NET test: issued tokens carry `alg=RS256` and the configured `kid`, verify with the public key.
- Compose check: `docker compose config` shows no `ServiceToken__PrivateKeyPem` and no `SERVICE_TOKEN_PRIVATE*` in any AI container.

## Pros and Cons of the Options

- **1. HS256** — Good: simple. Bad: verifier can mint; the reason for this ADR.
- **2. RS256** — Good: universally supported, easy PEM handling in both stacks. Bad: larger keys/signatures than ECDSA.
- **3. ES256** — Good: small, fast. Bad: equally fine technically; RS256 chosen for the simplest tooling (openssl, .NET Framework-compatible key generation in the PowerShell script).
- **4. Workload identity / mTLS** — Good: no app-held keys. Bad: platform-specific; still the production target where available.

## Links

- RFC 7518 §3.3 (RS256), RFC 8725 (JWT BCP: algorithm allow-lists)
- ADR-0009 (superseded)
