# 0006 — Web search: Tavily behind a `SearchProvider` interface

- Status: Accepted
- Date: 2026-10-17
- Deciders: project owner
- Related: [contracts.md](../architecture/contracts.md) §2, §3.2 (`search_runs`, `search_cache`), §5.3; master spec §18; threat model (SSRF)

## Context and Problem Statement

Every user can turn on **Search the web** in the tutor. The AI service then writes a topic-only query, searches, reads the top pages, and answers from web and course passages with validated citations. Which search API do we use, and what guards are needed for cost, privacy and safety?

## Decision Drivers

- Results suitable for LLM grounding (clean text, not just links) to keep our own page fetching minimal.
- Low and predictable cost with a free/low tier for development.
- Privacy: no personal data in queries (DPDP).
- Safety: web pages are untrusted (prompt injection, SSRF when fetching).
- Testability without network; ability to switch provider or disable search.

## Considered Options

1. Tavily (`SEARCH_PROVIDER=tavily`) behind `SearchProvider`.
2. Brave Search API (`SEARCH_PROVIDER=brave`) behind `SearchProvider`.
3. The LLM provider's server-side web search tool.
4. Bing/Google programmable search.
5. No web search.

## Decision Outcome

Chosen option: **1 — Tavily**, with **Brave** as the implemented alternative, **`fake`** for tests and **`none`** to disable the feature (the toggle then returns `WEB_SEARCH_FAILED` as a warning and the answer continues without web).

- **Interface:** `SearchProvider.search(query, max_results) → [ {url, title, snippet, content?} ]`. Search runs only in `ai-service` (on the `egress` network); Angular and .NET never call the provider.
- **Content:** prefer the provider's extracted page content. Fetch a page ourselves only when content is missing, through the SSRF-guarded fetcher (http/https only; resolve then connect; block private, loopback, link-local incl. `169.254.169.254`, CGNAT and IPv6 ULA/link-local; ports 80/443; re-validate every redirect; size and time caps).
- **Quota:** 20 searches per user per day (`Quotas__WebSearchesPerDay=20`), checked by .NET before calling the AI service → `WEB_SEARCH_QUOTA_EXCEEDED` (429).
- **Global spend cap:** `WEB_SEARCH_DAILY_SPEND_CAP_USD` (default 1), computed from today's `search_runs` (cache hits cost 0) using a per-call cost constant in the adapter, reviewed against provider pricing. Cap reached → search skipped, `WEB_SEARCH_FAILED` warning.
- **Cache:** `ai.search_cache` keyed by `query_hash` = sha256(provider + normalised query), 24 h expiry. Sharing across users is acceptable only because queries are topic-only.
- **No PII in queries:** a query-rewrite step (`purpose=query_rewrite`) produces a short topic query from the question and recent turns; a deterministic scrubber then removes emails, phone numbers, long digit runs (e.g. Aadhaar-like numbers), URLs with query strings and the user's display name; uploaded-file text and full conversation text are never sent. If scrubbing changes the meaning, search is skipped.
- **Failure:** timeouts and one bounded retry; on failure answer without web and tell the user (`WEB_SEARCH_FAILED`).
- **Grounding:** web passages are labelled `source_type=web`, passed as quoted data, never as instructions; course material takes priority; disagreement is stated.
- **Logging:** query hash, provider, URLs, result count, latency, cache hit, outcome, error code — never page contents or the raw query.

### Consequences

- Good: LLM-oriented results reduce our own fetching and the SSRF surface.
- Good: provider-neutral interface; `none` gives an instant off switch independent of the LLM kill switch.
- Good: per-user quota plus global cap bound abuse and cost.
- Bad: another third party receiving (topic-only) queries; provider terms must be checked.
- Bad: provider-extracted content quality varies; still untrusted.
- Bad: a cross-user cache can serve stale results for up to 24 h.

### Confirmation

- Golden set includes a hostile web page (prompt injection) served by `FakeSearchProvider`; the answer must not follow its instructions and its citations must be valid.
- SSRF tests: fetching `http://169.254.169.254/`, `http://postgres:5432/`, a hostname resolving to `10.0.0.1`, a redirect to `127.0.0.1` and `file://` are all refused.
- PII test: a question containing an email and phone number produces a query without them.
- Quota test: the 21st search in a day returns `WEB_SEARCH_QUOTA_EXCEEDED`.

## Pros and Cons of the Options

- **1. Tavily** — Good: built for LLM/RAG, returns cleaned content, simple API, free development tier. Bad: smaller independent index than the largest engines; third-party terms.
- **2. Brave** — Good: independent index, privacy-oriented. Bad: returns snippets/links, so more of our own fetching. Kept as alternative.
- **3. LLM server-side search tool** — Good: no extra integration. Bad: model decides the query (weaker PII control), couples search to the LLM provider and its pricing, less control over caching and quota; reconsider in the agents phase.
- **4. Bing/Google** — Good: coverage. Bad: cost and terms less suited to small projects; snippets only.
- **5. None** — Good: zero risk/cost. Bad: drops a specified feature (master spec §18).

## Links

- Tavily: https://docs.tavily.com/
- Brave Search API: https://api-dashboard.search.brave.com/
- OWASP SSRF Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
