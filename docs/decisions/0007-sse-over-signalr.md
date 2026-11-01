# 0007 — Server-Sent Events (fetch + ReadableStream) for tutor streaming, not SignalR

- Status: Accepted
- Date: 2026-10-17
- Deciders: project owner
- Related: [contracts.md](../architecture/contracts.md) §1 (Nginx), §5.3.1, §6.1; ADR-0002, ADR-0008

## Context and Problem Statement

Tutor answers must stream token by token from the AI service, through .NET, to the browser, with status updates ("Searching the web…"), citations, usage and a terminal `done`/`error`. The stream is one-directional, starts from a user action that carries a body, and must pass auth and CSRF checks. Which transport do we use?

## Decision Drivers

- Lowest time to first token; no queue in the path (chat is never a job, ADR-0002).
- Same-origin cookie auth and antiforgery on the request that starts the stream (ADR-0008).
- Works through Nginx and future platform ingresses without sticky sessions or a backplane.
- The answer is saved even if the browser disconnects.
- Simple to observe: one HTTP request, one trace.

## Considered Options

1. SSE over a `POST` read with `fetch` + `ReadableStream`.
2. SSE with the browser `EventSource` API.
3. SignalR (WebSockets with fallbacks).
4. Raw WebSockets.
5. Polling for partial answers.

## Decision Outcome

Chosen option: **1 — SSE over POST, consumed with `fetch` + `ReadableStream`**.

- Endpoint: `POST /api/v1/conversations/{id}/messages/stream` with JSON body, `X-XSRF-TOKEN` header and `Idempotency-Key`. Response `text/event-stream`, events `start`, `status`, `token`, `citation`, `usage`, `error`, `done`, each `data` carrying `requestId`. `EventSource` is not used because it only issues `GET`, cannot send a body or custom headers (no CSRF header), and auto-reconnects in ways that would duplicate a send.
- Keep-alive: comment line `: ping` every 15 s so proxies and the browser do not idle-close the connection.
- Nginx: for `/api/v1/conversations/` set `proxy_buffering off`, `proxy_read_timeout 300s`, no gzip for `text/event-stream`; .NET also sends `X-Accel-Buffering: no` and `Cache-Control: no-cache`.
- The .NET → AI service leg is the same wire format (contract §6.1) over `HttpClient` with `ResponseHeadersRead`.
- **Browser disconnect:** .NET keeps consuming the upstream stream on its own cancellation token (180 s timeout), not `HttpContext.RequestAborted`, then saves the message (`complete`, `partial` or `failed` with `error_code`), the citations, `ai_run_steps`, the `ai_runs` row and `usage_records`. A reload shows the saved answer.
- **Retries:** no automatic resume. On a drop the client reports `sse_drop` to `/client-errors` and reloads the conversation; resending uses the same `Idempotency-Key`, so the server does not create a duplicate message.
- Failure to reach the AI service → `error` event with `AI_SERVICE_UNAVAILABLE` and a reference ID.

### Consequences

- Good: plain HTTP; works with cookies, antiforgery, Nginx and any HTTP ingress; no backplane or sticky sessions when scaling out.
- Good: one request = one trace; easy to test with `curl -N`.
- Good: answers survive tab closes and network blips.
- Bad: we parse the SSE wire format ourselves in Angular (small, unit-tested parser).
- Bad: one open HTTP connection per active answer; connection limits and timeouts must be sized on Nginx and Kestrel.
- Bad: no server push outside an active request (e.g. ingestion progress uses polling every 2 s). If true server push becomes necessary, revisit (Redis + SSE channel or SignalR) in a new ADR.

### Confirmation

- Playwright: streamed answer renders progressively; `status` line appears before the first token.
- Test: disconnect the browser mid-answer → after reload the full message and a completed `ai_runs` row exist.
- Test: missing `X-XSRF-TOKEN` → 400 `CSRF_INVALID` before any upstream call.
- Test through Nginx: first token arrives without buffering delay (TTFT measured at the browser ≈ TTFT measured in .NET).
- Kill the AI service mid-stream → `error` event with reference ID; one trace shows the failure point.

## Pros and Cons of the Options

- **1. SSE via fetch** — Good: POST + headers + CSRF, simple infra. Bad: custom client parser.
- **2. EventSource** — Good: built-in parser and reconnect. Bad: GET only, no custom headers, unwanted auto-reconnect.
- **3. SignalR** — Good: bidirectional, mature client. Bad: extra protocol and dependency, backplane (Redis/Azure SignalR) and sticky sessions when scaled; listed as "not used unless justified" in the master spec; we need only one direction.
- **4. Raw WebSockets** — Good: bidirectional. Bad: separate auth/CSRF story, proxy configuration, more code for no gain.
- **5. Polling** — Good: trivial. Bad: poor TTFT and higher load.

## Links

- WHATWG HTML, Server-sent events: https://html.spec.whatwg.org/multipage/server-sent-events.html
- MDN, Using readable streams: https://developer.mozilla.org/docs/Web/API/Streams_API/Using_readable_streams
