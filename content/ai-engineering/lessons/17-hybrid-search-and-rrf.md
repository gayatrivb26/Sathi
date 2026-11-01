# Hybrid search and reciprocal rank fusion

## Two kinds of search, two kinds of failure

Vector search matches **meaning**. Ask "why do we shrink attention scores?" and it can find a passage about "dividing by the square root of the key dimension", even with almost no words in common. But it is weak at exact tokens: error codes such as `ERR_CONN_RESET`, function names, product SKUs, rare surnames. Embedding models squash those into a general region of meaning and often rank a near-synonym above the exact match.

**Keyword search** has the opposite profile. It matches the literal terms in the query, so it nails identifiers and rare words, but it misses paraphrases: a query about "shrinking scores" will not match "scaling the logits".

**Hybrid search** runs both and merges the results. The two methods fail on different queries, so together they cover far more.

## Keyword search with BM25

The standard keyword ranking function is **BM25**. For a query with terms $q_1, \dots, q_n$ and a document $D$:

$$\text{BM25}(D) = \sum_{i} \text{IDF}(q_i) \cdot \frac{f(q_i, D)\,(k_1 + 1)}{f(q_i, D) + k_1\left(1 - b + b \frac{|D|}{\text{avgdl}}\right)}$$

You do not need to memorise it, but you should understand its three ideas:

- **IDF (inverse document frequency)**: rare terms count more. Matching "softmax" says much more than matching "the".
- **Term-frequency saturation**: $f(q_i, D)$ is how often the term appears. Each extra occurrence helps less than the previous one. With $k_1 = 1.2$ and an average-length document, the term-frequency factor is $1.0$ for one occurrence, $1.375$ for two, and $1.96$ for ten, approaching a ceiling of $2.2$. Repeating a keyword fifty times does not win.
- **Length normalisation**: $b$ (typically $0.75$) penalises long documents, which match more terms just by being long.

Postgres full-text search (`tsvector`, `ts_rank`) provides a similar keyword signal, though its ranking is not exactly BM25.

## Why not just add the scores?

The natural idea is to combine scores: final $=$ vector score $+$ BM25 score. The problem is that the scales are unrelated. Cosine similarity lives in a narrow band, often $0.7$ to $0.9$ for relevant text; BM25 scores are unbounded and vary with query length and corpus statistics. Adding them lets whichever scale is bigger dominate, and any fixed weighting that works for one query breaks for the next.

**Ranks**, however, are always comparable. First place is first place in either list.

## Reciprocal rank fusion

**Reciprocal rank fusion (RRF)** scores each document by summing, over every result list it appears in, one over a constant plus its rank:

$$\text{RRF}(d) = \sum_{\text{lists } r} \frac{1}{k + \text{rank}_r(d)}$$

Ranks start at $1$. A document missing from a list gets nothing from that list. The constant $k$ is conventionally $60$, the value used in the paper that introduced RRF.

## Worked example: fusing two lists with $k = 60$

Vector search returns, in order: **A, B, E, D, C**. BM25 returns: **C, D, A, F**.

- **A**: rank 1 (vector) and rank 3 (BM25): $\frac{1}{61} + \frac{1}{63} = 0.016393 + 0.015873 = 0.032266$
- **C**: rank 5 and rank 1: $\frac{1}{65} + \frac{1}{61} = 0.015385 + 0.016393 = 0.031778$
- **D**: rank 4 and rank 2: $\frac{1}{64} + \frac{1}{62} = 0.015625 + 0.016129 = 0.031754$
- **B**: rank 2, vector only: $\frac{1}{62} = 0.016129$
- **E**: rank 3, vector only: $\frac{1}{63} = 0.015873$
- **F**: rank 4, BM25 only: $\frac{1}{64} = 0.015625$

The fused order is **A, C, D, B, E, F**. Look at what happened: B was second in vector search, but C and D, which both lists found, jumped above it. RRF rewards **agreement** between methods. A document ranked moderately well by both beats one ranked highly by only one.

## Why $k = 60$?

The constant controls how much the very top ranks dominate. With $k = 0$, rank 1 scores $1$ and rank 2 scores $0.5$, a huge gap, so one list's top pick wins almost regardless of the other list. With $k = 60$, rank 1 scores $1/61 \approx 0.0164$ and rank 2 scores $1/62 \approx 0.0161$, a gentle slope, so appearing in several lists matters more than being first in one. The value $60$ is a robust default that works well across many collections; you can tune it, or weight lists differently, against your evaluation set.

## Hybrid search in practice

A typical hybrid pipeline:

1. Run vector search and keyword search in parallel, each returning, say, the top $20$ to $50$, both restricted to the same allowed scope (course, user uploads).
2. Fuse with RRF and take the top $k$.
3. Optionally **rerank** the fused candidates with a cross-encoder, a model that reads the query and each passage together and scores relevance more accurately than either first-stage method. It is too slow to run over the whole corpus but fine for $20$ to $50$ candidates.

Log the ranks from each method alongside the fused result. When an answer is wrong, you can see whether the right chunk was missing from both lists, found by one and lost in fusion, or retrieved but ignored by the model.

## Common mistakes

- **Adding raw scores from different systems.** Use ranks, or normalise very carefully.
- **Using zero-based ranks.** With $k = 60$ it makes little difference, but the convention is rank $1$ for the top result; be consistent so scores are reproducible.
- **Filtering only one side.** Both searches must apply the same access filters, or fusion can leak documents a user should not see.
- **Retrieving too few candidates per list.** If each list returns only $3$ results, there is little for fusion to agree on.

## Check yourself

1. A document is ranked 2 in vector search and 2 in BM25. What is its RRF score with $k = 60$? (Answer: $2/62 \approx 0.032258$.)
2. Why does RRF combine ranks instead of raw scores?
3. Give an example query where keyword search would beat vector search, and one where the opposite is true.
