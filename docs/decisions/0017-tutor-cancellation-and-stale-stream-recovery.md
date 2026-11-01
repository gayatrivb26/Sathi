# 0017 — Tutor cancellation and stale-stream recovery

- Status: Accepted
- Date: 2026-10-22
- Deciders: project owner
- Related: [contracts.md](../architecture/contracts.md) §5.3, §10, §11.5; ADR-0007

## Context and Problem Statement

A tutor answer streams from the AI service through `api` to the browser (ADR-0007). By design `api` keeps consuming the upstream stream when the browser disconnects, so the answer is saved. Two gaps remain: a learner cannot **stop** a long or wrong answer (tokens keep being generated and billed), and if the `api` process dies mid-stream the assistant message stays `streaming` forever, showing an endless spinner. How do we cancel a run and recover runs whose owner died?

## Decision Drivers

- Stop spending tokens as soon as the learner asks.
- Keep what was already generated and bill only what was generated.
- No message stuck in `streaming`.
- No new infrastructure for a single `api` instance; a clear path for several instances.

## Considered Options

1. No cancel; rely on the 180 s upstream timeout.
2. Cancel endpoint + **in-process registry** (`messageId → CancellationTokenSource`) in `api`; stale-stream sweep on read and in a recurring job.
3. Cancel via a shared channel (Redis pub/sub / Postgres `LISTEN/NOTIFY`) from day one.

## Decision Outcome

Chosen option: **2**, with 3 documented as the scale-out step.

- `POST /conversations/{id}/messages/{messageId}/cancel` → 202, idempotent, owner only (else 404). If the run is active on this instance, its token is cancelled: the upstream HTTP request to the AI service is aborted, the text produced so far is saved with status **`cancelled`**, `ai_runs` completes as `cancelled`, and usage is recorded for tokens already generated. If the run is not active here and the message is still `streaming`, it is marked `cancelled` directly.
- The AI service stops the LLM stream promptly when .NET closes the connection and records `model_runs.finish_reason = 'cancelled'`.
- **Stale streams**: a message still `streaming` more than `Tutor:StaleStreamMinutes` (default 3, env `TUTOR_STALE_STREAM_MINUTES`) after creation is interrupted — `GET /conversations/{id}` persists it as `failed` with error code **`STREAM_INTERRUPTED`**, and `RecoverStaleStreamsJob` (every 5 minutes) does the same for all users and fails the matching `ai_runs`.
- The threshold is larger than the normal maximum stream duration (upstream budget 180 s), so a healthy stream is never marked stale.

**Scale-out note:** with more than one `api` instance, a cancel request can land on an instance that does not own the run; it would then mark the message `cancelled` while the owning instance keeps streaming (and later overwrites the status). Before running several API replicas, publish cancel requests on a shared channel (Redis pub/sub, or Postgres `LISTEN/NOTIFY` to avoid a new dependency) that every instance subscribes to, and add a new ADR.

### Consequences

- Good: learners can stop answers; spend stops within one upstream read; partial text is kept and correctly billed.
- Good: no permanent `streaming` messages after crashes or deploys.
- Bad: the registry is per process — correct only with one `api` replica (current deployment).
- Bad: a run that legitimately takes longer than the threshold would be cut; keep the threshold above the stream budget when changing either.

### Confirmation

- API tests: cancel by non-owner → 404; cancel twice → 202 both times, one `cancelled` message; cancel saves partial content and usage; a message older than the threshold is returned as `failed`/`STREAM_INTERRUPTED`; the job fails matching `ai_runs`.
- Python test: client disconnect stops the fake LLM stream and records `finish_reason='cancelled'`.
- Runbook drill: see [debugging.md](../runbooks/debugging.md) "Cancelled and interrupted answers".

## Pros and Cons of the Options

- **1. No cancel** — Good: nothing to build. Bad: wasted spend, poor UX, stuck messages remain.
- **2. In-process registry + sweep** — Good: simple, no new dependency. Bad: single-instance assumption.
- **3. Shared channel now** — Good: multi-instance correct. Bad: new infrastructure before it is needed.

## Links

- ADR-0007 (SSE), contracts §11.5
