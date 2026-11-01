# 0004 — Local embeddings: `BAAI/bge-small-en-v1.5` (384-d) via fastembed (ONNX, CPU)

- Status: Accepted
- Date: 2026-10-17
- Deciders: project owner
- Related: [contracts.md](../architecture/contracts.md) §2, §3.2; ADR-0003

## Context and Problem Statement

Every lesson and uploaded document is chunked and embedded at ingestion; every tutor question is embedded at query time. Uploaded notes are learner personal content. Should embeddings come from a hosted API or a local model, and which one?

## Decision Drivers

- Privacy: learner uploads should not leave our infrastructure only to be embedded (DPDP data minimisation).
- Cost: zero marginal cost for development, CI and re-indexing.
- CPU-only operation on a developer laptop and a modest container; no GPU.
- Small image and memory footprint (the full stack must fit in 8–16 GB RAM).
- Good English retrieval quality for course-sized corpora.
- Deterministic tests (a `fake` provider must exist).

## Considered Options

1. `BAAI/bge-small-en-v1.5` via fastembed (ONNX Runtime, CPU).
2. Same model via sentence-transformers (PyTorch).
3. Larger local model (`bge-base-en-v1.5`, 768-d) or `intfloat/e5-small-v2`.
4. Multilingual local model (`intfloat/multilingual-e5-small`).
5. Hosted embedding API (OpenAI `text-embedding-3-small`, Voyage, Cohere).

## Decision Outcome

Chosen option: **1 — `BAAI/bge-small-en-v1.5` through fastembed**, configured by `EMBEDDING_PROVIDER=fastembed` and `EMBEDDING_MODEL=BAAI/bge-small-en-v1.5`; `EMBEDDING_PROVIDER=fake` gives deterministic vectors in tests.

- 384 dimensions, cosine similarity on normalised vectors, ~33 M parameters, max input 512 tokens. The chunker targets well under 512 tokens per chunk so nothing is silently truncated.
- Queries use the model's query path (BGE query instruction prefix) and passages the passage path; a unit test asserts which path fastembed applies.
- Model files are downloaded at image build time and pinned (model revision and file hash recorded), so runtime needs no download and builds are reproducible.
- **Store model and dimension with every vector**: `ai.chunk_embeddings.model` and `.dim`; `index` responses return `embeddingModel`. Query time asserts the configured model equals the model of the table being searched; a mismatch fails fast.
- **Never mix models in one index.** One table + HNSW index per model.

### Re-embedding plan (model change)

1. Add a new table (e.g. `ai.chunk_embeddings_<model_slug>`) with `vector(<new dim>)` and its own HNSW index (Alembic migration).
2. Backfill job on queue `ai-heavy`: batches of chunks, idempotent by `chunk_id`, resumable, rate-limited; new ingestions dual-write to both tables during the backfill.
3. Evaluate: run the retrieval golden set against the new table; accept only if Recall@5/MRR/nDCG are not worse (or the change is justified, e.g. multilingual support).
4. Switch: change `EMBEDDING_MODEL` (and the active row in `model_configurations`) so queries read the new table; keep the old table for a rollback window.
5. Drop the old table and index in a later migration.

### Consequences

- Good: no learner content sent to a third party for embedding; no per-token cost; works offline.
- Good: small ONNX runtime avoids PyTorch in the runtime image; fast enough on CPU for course-sized corpora.
- Good: model and dimension per vector make migrations explicit and safe.
- Bad: English only; Hindi and other Indian-language notes will retrieve poorly. Multilingual support is a re-embedding project, not a config flip.
- Bad: lower ceiling than larger or hosted models; ingestion CPU load lands on `ai-ingest`.
- Bad: we own model pinning and upgrades.

### Confirmation

- Benchmark on the golden retrieval set (Recall@5, MRR, nDCG@10) and CPU latency per 100 chunks, recorded in the evaluation report; revisit if hybrid Recall@5 is below the agreed target or if non-English content becomes material.
- Test: ingest the same document twice → identical vector count, `model` and `dim` on every row.
- Test: starting the service with an `EMBEDDING_MODEL` that differs from the active table fails startup.

## Pros and Cons of the Options

### 1. bge-small via fastembed

- Good: small, fast, private, free, strong for its size. Bad: English only, 512-token limit.

### 2. bge-small via sentence-transformers

- Good: canonical implementation. Bad: PyTorch makes images much larger and slower to start.

### 3. Larger local English model

- Good: somewhat higher quality. Bad: 2× storage for 768-d, slower CPU ingestion; benefit unproven on our data.

### 4. Multilingual local model

- Good: Indian-language support. Bad: lower English quality per size; not needed for the first course. Candidate for the first re-embedding.

### 5. Hosted embedding API

- Good: high quality, no local CPU. Bad: learner uploads leave our infrastructure; recurring cost; network dependency and rate limits in CI; provider terms to review.

## Links

- Model card: https://huggingface.co/BAAI/bge-small-en-v1.5
- fastembed: https://github.com/qdrant/fastembed
- ADR-0003 (hybrid retrieval)
