# 0008 — Same-origin cookie authentication with antiforgery (no JWT in the browser)

- Status: Accepted
- Date: 2026-10-17
- Deciders: project owner
- Related: [contracts.md](../architecture/contracts.md) §3.1 (`data_protection_keys`), §5, §5.1; ADR-0007, ADR-0009

## Context and Problem Statement

The Angular SPA and the API are served from the same origin by Nginx (`web`: static files plus `/api/` → `api`, `/hangfire` → `jobs`). Users sign in with email and password (ASP.NET Core Identity), with email verification, password reset and lockout. The Hangfire dashboard on `jobs` must accept the same Admin session. How does the browser hold its session?

## Decision Drivers

- Resist token theft through XSS (the SPA renders Markdown, LaTeX and model output).
- Built-in, well-reviewed primitives: Identity, cookie auth, antiforgery, security stamp.
- Same session valid on `api` and `jobs` (`/hangfire`).
- Server-side revocation on logout, password change, lockout and account deletion.
- Simple SSE streaming over POST (ADR-0007).
- No CORS surface.

## Considered Options

1. Identity cookie (`sathi.auth`), same origin, antiforgery token in a readable cookie + header.
2. JWT access token in `localStorage`/memory + refresh token.
3. Backend-for-frontend with an external OIDC provider now.

## Decision Outcome

Chosen option: **1 — Identity cookie with antiforgery, same origin**.

- Cookie `sathi.auth`: `HttpOnly`, `Secure` outside development, `SameSite=Lax`, 14-day sliding expiration (`rememberMe` controls persistence). Unauthenticated API calls return 401 ProblemDetails (`AUTH_UNAUTHENTICATED`), never a redirect.
- CSRF: antiforgery with cookie `XSRF-TOKEN` (readable by JS) and header `X-XSRF-TOKEN` on every non-GET request. Angular `withXsrfConfiguration({cookieName:'XSRF-TOKEN', headerName:'X-XSRF-TOKEN'})`; all calls use relative `/api/...` URLs (Angular only adds the header to relative URLs). `GET /api/v1/auth/csrf` reissues the token on startup and after login/logout. Failure → 400 `CSRF_INVALID`. `SameSite=Lax` is a second layer, not the main CSRF defence.
- Exception: `POST /client-errors` is anonymous and CSRF-exempt, rate-limited (30/min per IP) and accepts no user content.
- DataProtection keys persisted in `app.data_protection_keys` (EF Core key store) and shared by `api` and `jobs` with the same application name, so `jobs` can decrypt `sathi.auth` for `/hangfire`. In production, keys are additionally encrypted at rest with a key from the secret store (e.g. Key Vault).
- Identity settings: password ≥ 10 chars with a letter and a digit; lockout 5 failures → 15 min (`AUTH_LOCKED_OUT`); verification and reset endpoints never reveal whether an email exists; security-stamp validation invalidates other sessions on password change and deletion.
- Nginx rate-limits `/api/v1/auth/`; the API also applies 10 req/min per IP on auth and 120 req/min per user globally.
- Nginx security headers: CSP with `frame-ancestors 'none'` (clickjacking), `X-Content-Type-Options: nosniff`, `Referrer-Policy`; HSTS when served over TLS.
- Service-to-service calls (.NET → AI) use a separate short-lived token (ADR-0009); browser cookies never leave the .NET boundary.

### Why not JWT in the browser

A bearer token readable by JavaScript is stolen by any XSS and replayable from anywhere until it expires; refresh tokens add rotation, reuse detection and storage problems; revocation needs a server-side list anyway. With a single same-origin backend, cookies give the same capability with less code and a smaller blast radius. JWTs remain the right tool for service-to-service calls (ADR-0009) and for future third-party API clients.

### Consequences

- Good: the session cookie is unreachable from JavaScript; revocation is immediate through the security stamp.
- Good: no CORS configuration; SSE works with ordinary cookies and headers.
- Good: one sign-in covers the API and the Hangfire dashboard.
- Bad: requires antiforgery on every mutating endpoint and careful exemptions.
- Bad: a native mobile app or third-party client would need a different scheme (OIDC/PKCE) later.
- Bad: DataProtection keys become a shared secret between `api` and `jobs`; losing them signs everyone out; leaking them allows cookie forgery.

### Confirmation

- Tests: cookie flags (`HttpOnly`, `Secure` in non-dev, `SameSite=Lax`); POST without `X-XSRF-TOKEN` → 400 `CSRF_INVALID`; 401 (not 302) for anonymous API calls.
- Test: a cookie issued by `api` authorizes an Admin on `/hangfire` and is rejected for a Student.
- Test: password change invalidates an existing session on a second client.
- Test: `resend-verification` and `forgot-password` return 202 for unknown emails.

## Pros and Cons of the Options

- **1. Cookie + antiforgery** — Good: XSS-resistant session, built-in, revocable. Bad: CSRF handling, browser-only.
- **2. JWT in browser** — Good: stateless, multi-client. Bad: XSS theft, refresh complexity, revocation, CORS.
- **3. BFF + OIDC now** — Good: social login, MFA from provider. Bad: extra moving parts before real users; can be added later behind the same cookie (OIDC social login is planned).

## Links

- ASP.NET Core antiforgery: https://learn.microsoft.com/aspnet/core/security/anti-request-forgery
- ASP.NET Core Data Protection key storage: https://learn.microsoft.com/aspnet/core/security/data-protection/implementation/key-storage-providers
- OWASP Session Management Cheat Sheet
