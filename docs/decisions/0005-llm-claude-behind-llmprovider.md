# 0005 — Hosted LLM: Claude behind an `LlmProvider` interface

- Status: Accepted
- Date: 2026-10-17
- Deciders: project owner
- Related: [contracts.md](../architecture/contracts.md) §2, §3.2 (`model_runs`, `debug_captures`), §4.2; ADR-0010

## Context and Problem Statement

The tutor, query rewriting, quiz generation and grading assistance need a capable hosted LLM with streaming. The system must stay testable without network access or a key, keep spend bounded, survive provider outages and refusals, and allow a provider change later without touching callers. Which model, and how is it wrapped?

## Decision Drivers

- Answer quality for teaching (explanations, Socratic hints, rubric grading) and reliable structured output.
- Streaming with low time to first token.
- Hard cost control: a global daily cap and an instant kill switch.
- Deterministic CI with no key and no spend.
- Provider portability and auditability (which prompt, which model, what cost).
- Learner-data handling consistent with DPDP and the provider's retention terms.

## Considered Options

1. Anthropic Claude (`claude-opus-5-5` primary, `claude-sonnet-5-5` fallback) behind `LlmProvider`.
2. A cheaper model only (e.g. `claude-sonnet-5-5` as primary).
3. Another hosted provider behind the same interface.
4. Self-hosted open-weights model.
5. A framework abstraction (LangChain/LiteLLM) instead of our own interface.

## Decision Outcome

Chosen option: **1 — Claude behind our own `LlmProvider` interface**.

- **Models:** `LLM_MODEL=claude-opus-5-5`, `LLM_FALLBACK_MODEL=claude-sonnet-5-5`. Chat runs with `effort: low` (set explicitly; the model default is `medium`, and on Opus 5.5 effort — not disabling thinking — is the depth/cost control). Grading and quiz generation start at a higher effort chosen by evaluation, per route.
- **Fallback:** on provider 429/5xx after bounded retries or timeout, retry once on the fallback model (`model_runs.fallback_used = true`); if that fails → `LLM_RATE_LIMITED`, `LLM_TIMEOUT` or `LLM_UNAVAILABLE`.
- **Refusals:** a refusal arrives as HTTP 200 with `stop_reason: "refusal"`; always check it before reading content. Enable the provider's server-side refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) so declined requests are re-routed by the provider; if the final result is still a refusal → `LLM_REFUSED` (422) and the message is saved as `failed`. Mid-stream refusal behaviour is verified against provider docs and a recorded fixture.
- **Structured output** (quiz generation, grading) uses the API's JSON-schema output format and is validated again with Pydantic; invalid output → `QUIZ_GENERATION_FAILED` / `GRADING_FAILED`.
- **Interface:** `LlmProvider` exposes `stream()` and `complete()`; implementations `AnthropicProvider`, `FakeProvider` (deterministic, scripted tokens/errors/refusals for tests) and a record/replay wrapper. Record mode (developer, real key, synthetic content only) writes request/response fixtures keyed by prompt hash and input hash; replay mode serves them in CI.
- **Fake mode:** empty `ANTHROPIC_API_KEY` ⇒ `LLM_PROVIDER` defaults to `fake`. Startup fails if `SATHI_ENV` is `staging`/`production` and the provider is `fake`.
- **Spend cap:** before each call, today's spend = `sum(ai.model_runs.estimated_cost_usd)` (UTC day); if ≥ `LLM_DAILY_SPEND_CAP_USD` → `SPEND_CAP_REACHED` (503). Overshoot is bounded by concurrent calls × `max_tokens`. `AI_KILL_SWITCH=true` → every call fails with `LLM_DISABLED` (503) without contacting the provider.
- **Prompts:** versioned files in `prompts/` (`PROMPTS_DIR`); each run records `prompt_name`, `prompt_version` and `prompt_hash` (`sha256:` of the template) in `model_runs` and `ai_runs`. Stable content first (tutor rules), volatile content last (passages, history, question) so prompt caching can reuse the prefix.
- **Cost estimate:** a versioned price table in configuration. At the time of writing Opus 5.5 lists $4 / $20 per million input/output tokens and Sonnet 5.5 $2 / $10 (thinking tokens bill as output). Example chat turn: 6,000 input + 600 output tokens on Opus 5.5 = 0.024 + 0.012 = **$0.036**; a $5 cap ≈ 138 such turns per day.

### Consequences

- Good: strong quality with bounded cost; CI is free and deterministic; every call is attributable (model, prompt hash, tokens, cost, TTFT).
- Good: callers depend on `LlmProvider`, so a provider change is an adapter plus re-evaluation.
- Bad: model-specific request rules (effort, refusal handling, structured output) live in the adapter and must be re-checked on each model upgrade.
- Bad: learner questions and passages are sent to a third party outside India (see Data handling).
- Bad: a global cap can block all users on a busy day; per-user quotas (`Quotas__ChatMessagesPerDay`) are the first line.

### Data handling (must be done before real learner data)

Review and record the provider's current commercial terms: input/output retention period, training use (opt-out/default), zero-data-retention eligibility, region/inference-geography options, and sub-processors. Never send names or emails in prompts; uploads are sent only as retrieved passages. Note cross-border transfer in the privacy notice (threat model, DPDP section).

### Confirmation

- Tests with `FakeProvider`: kill switch → `LLM_DISABLED`; cap reached → `SPEND_CAP_REACHED`; scripted 529/timeout → fallback used; scripted refusal → `LLM_REFUSED`.
- Startup test: production config with empty key fails fast.
- Golden tutor and grading sets run on prompt or model change; nightly evaluation tracks drift.

## Pros and Cons of the Options

- **1. Opus 5.5 + Sonnet 5.5 fallback** — Good: quality, streaming, structured output, refusal fallbacks. Bad: higher price than Sonnet; model-specific rules.
- **2. Sonnet only** — Good: half the price. Bad: may lower tutoring/grading quality; decide by evaluation, not assumption (can be a per-route setting later).
- **3. Other provider** — Good: diversity. Bad: second integration to test now with no current need; the interface keeps this open.
- **4. Self-hosted** — Good: data stays local. Bad: GPU cost and ops, lower quality at affordable sizes.
- **5. Framework abstraction** — Good: many providers. Bad: hides request details we must control (effort, refusals, cost); extra dependency.

## Links

- Anthropic API documentation: https://docs.anthropic.com/
- Master spec §4 (Models), §7.3, §21.3, §21.5
