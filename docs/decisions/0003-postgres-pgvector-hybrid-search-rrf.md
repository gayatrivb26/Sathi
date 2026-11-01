# 0003 — PostgreSQL + pgvector hybrid search fused with Reciprocal Rank Fusion

- Status: Accepted
- Date: 2026-10-17
- Deciders: project owner
- Related: [contracts.md](../architecture/contracts.md) §3.2, §6; ADR-0004, ADR-0009

## Context and Problem Statement

The tutor answers from course lessons, course uploads and the learner's own uploads (RAG). Retrieval must find passages that match by meaning (paraphrases) and by exact terms (formula names, acronyms such as "RRF", code identifiers), must never return passages outside the caller's allowed scope, and must be explainable in the run ledger. Where should vectors and the keyword index live, and how are the two result lists combined?

## Decision Drivers

- Security: scope filtering must be enforced by the database query, using only the service token's `rscope`.
- One database to operate and back up (ADR-0001).
- Quality on both semantic and lexical queries; measurable with Recall@k, MRR, nDCG.
- Simple, tuning-free fusion that works on scores with different scales.
- Scale: thousands to low millions of chunks — well within a single Postgres instance.

## Considered Options

1. Postgres: pgvector (HNSW, cosine) + `tsvector` (GIN) hybrid, fused with RRF.
2. Dedicated vector database (Qdrant, Weaviate, Pinecone) plus Postgres for keyword search.
3. Vector-only search in pgvector.
4. Hybrid with weighted score fusion (normalise scores, `α·vector + (1−α)·keyword`).
5. OpenSearch/Elasticsearch for BM25 + kNN.

## Decision Outcome

Chosen option: **1 — Postgres hybrid search with RRF (k = 60)**.

**Storage and indexes** (schema `ai`): `document_chunks.content_tsv` is a generated `tsvector` (`to_tsvector('english', content)`) with a GIN index; `chunk_embeddings.embedding vector(384)` with an HNSW index using `vector_cosine_ops` (start with pgvector defaults `m = 16`, `ef_construction = 64`; tune `hnsw.ef_search` per query from evaluation). B-tree indexes on (`scope`, `course_id`) and (`owner_user_id`) support the scope predicate.

**Scope filter in SQL, before ranking.** Both the vector and the keyword query include, in the same statement:

```sql
WHERE (c.scope = 'course' AND c.course_id = ANY(:course_ids))
   OR (c.scope = 'user'   AND c.owner_user_id = :user_id)
```

`:course_ids` and `:user_id` come only from the verified token's `rscope`, never from the request body. Out-of-scope chunks are therefore never candidates and cannot influence rank. With HNSW, filtered index scans can return fewer than k rows; enable pgvector iterative index scans (`SET LOCAL hnsw.iterative_scan`, pgvector ≥ 0.8) or let the planner choose an exact scan via the B-tree for small scopes. Both are correct; only recall differs.

**Fusion.** Take the top N = 20 from each list (vector by cosine distance; keyword by `ts_rank_cd` over `websearch_to_tsquery('english', :q)`), then score each chunk:

`RRF(d) = Σ over lists 1 / (k + rank_list(d))`, with k = 60 and rank starting at 1. A chunk missing from a list contributes 0 for that list. Ties break by lower best rank, then presence in the vector list, then `chunk_id` (deterministic). Return top_k (default 6). `retrieved_sources` stores `score`, `vector_rank` and `keyword_rank`; `retrieval_runs` stores method, timings and `empty`.

**Worked example (k = 60).** 1/61 = 0.016393, 1/62 = 0.016129, 1/63 = 0.015873, 1/64 = 0.015625, 1/65 = 0.015385.

| Chunk | Vector rank | Keyword rank | RRF score | Final |
| --- | --- | --- | --- | --- |
| C1 | 1 | 2 | 0.016393 + 0.016129 = **0.032522** | 1 |
| C4 | 4 | 1 | 0.015625 + 0.016393 = **0.032018** | 2 |
| C2 | 2 | — | **0.016129** | 3 |
| C3 | 3 | — | **0.015873** | 4 (tie with C6, wins on vector presence) |
| C6 | — | 3 | **0.015873** | 5 |
| C5 | 5 | — | **0.015385** | 6 |

C4 was only 4th by meaning but 1st by keywords; agreement across both lists lifts it above C2. RRF uses only ranks, so cosine distances and `ts_rank_cd` values (different scales) never need normalising. A larger k flattens the advantage of top ranks; 60 is the value from Cormack et al. (2009) and is a robust default.

### Consequences

- Good: one database, transactional ingestion (delete + insert chunks in one transaction), backups cover vectors.
- Good: authorization is part of the query plan, not a post-filter in Python.
- Good: RRF needs no training or score calibration; every rank is logged for debugging.
- Bad: `ts_rank_cd` is not BM25 (no IDF saturation); lexical quality is weaker than a search engine. Revisit with a BM25 extension if keyword recall is the bottleneck.
- Bad: English-only text search configuration and an English embedding model (ADR-0004).
- Bad: HNSW with selective filters needs iterative scans or exact fallback to keep recall.

### Confirmation

- Isolation test: user A's query never returns user B's upload chunks, even when the request body names B's IDs.
- Golden retrieval set (`tests/ai-evaluation/datasets/`): report Recall@5, MRR and nDCG@10 for vector, keyword and hybrid; hybrid must be ≥ the better single method.
- Unit test reproducing the worked example above.

## Pros and Cons of the Options

### 1. Postgres hybrid + RRF

- Good: simplest operations, scope-safe SQL, good quality. Bad: not BM25; single-node scale.

### 2. Dedicated vector DB

- Good: advanced ANN features. Bad: second datastore, filters and auth duplicated, cross-store consistency on delete.

### 3. Vector only

- Good: simplest. Bad: misses exact terms, acronyms, identifiers.

### 4. Weighted score fusion

- Good: tunable. Bad: needs score normalisation and a tuned α that drifts with data and model changes.

### 5. OpenSearch

- Good: real BM25 + kNN. Bad: heavy JVM service, extra security and backup surface.

## Links

- pgvector: https://github.com/pgvector/pgvector
- Cormack, Clarke, Büttcher, "Reciprocal Rank Fusion outperforms Condorcet and individual rank learning methods", SIGIR 2009
- PostgreSQL full-text search: https://www.postgresql.org/docs/current/textsearch.html
