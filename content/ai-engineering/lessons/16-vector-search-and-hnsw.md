# Vector search and HNSW

## The search problem

After chunking and embedding, every passage is a vector. Answering a question means embedding the query and finding the $k$ stored vectors most similar to it, the **k nearest neighbours** (kNN). Similarity is usually cosine similarity, or the dot product on normalised vectors.

The obvious algorithm is a **brute-force scan**: compare the query with every stored vector and keep the top $k$. It is exact and simple, and for a few thousand chunks it is perfectly fine. The question is what happens at scale.

## Worked example: the cost of exact search

Suppose you have $1{,}000{,}000$ chunks embedded at $d = 768$ dimensions, stored as 32-bit floats.

**Memory.** $1{,}000{,}000 \times 768 \times 4 \text{ bytes} = 3{,}072{,}000{,}000$ bytes, about $3.07$ GB just for the vectors.

**Compute per query.** One dot product costs $768$ multiply-adds, so a full scan is $768 \times 10^6 \approx 7.7 \times 10^8$ multiply-adds. A single CPU core doing a few billion simple operations per second needs a noticeable fraction of a second, and every query must also stream 3 GB through memory. At hundreds of queries per second that does not scale.

Real systems therefore use **approximate nearest neighbour (ANN)** indexes. They give up a guarantee of finding the exact top $k$ in exchange for searching a tiny fraction of the vectors. The quality measure for an ANN index is its **recall**: the fraction of the true top-$k$ neighbours it actually returns. Well-tuned indexes reach $95\%$ to $99\%$ recall while examining only a few thousand vectors.

## HNSW: navigating a graph

**Hierarchical Navigable Small World (HNSW)** is the most widely used ANN index, and it is what pgvector, many vector databases and libraries like FAISS offer. It builds a graph where each vector is a node connected to some of its near neighbours.

**Greedy search on one layer.** Start at some entry node. Look at its neighbours, move to whichever is closest to the query, and repeat until no neighbour is closer. Because the graph links each node to nearby nodes plus a few longer-range ones (the "small world" property), this walk reaches the right region in few hops.

**The hierarchy.** HNSW stacks several graph layers, like an express-train network over local lines. Every vector is in the bottom layer, layer $0$. Each vector is also randomly promoted to higher layers with geometrically decreasing probability. Search starts at the top layer, where there are few nodes and long hops, greedily descends to the closest node, drops to the layer below and continues, getting more local each time, until it does a careful search in layer $0$.

**Worked example: how many layers?** With the common setting $M = 16$ (the target number of links per node), the probability that a node reaches layer $\ell$ or above is roughly $(1/16)^\ell$. For one million vectors:

| layer | approx. nodes |
|---|---|
| 0 | $1{,}000{,}000$ |
| 1 | $1{,}000{,}000 / 16 = 62{,}500$ |
| 2 | $62{,}500 / 16 \approx 3{,}906$ |
| 3 | $\approx 244$ |
| 4 | $\approx 15$ |
| 5 | $\approx 1$ |

So the hierarchy is about $\log_{16} 10^6 \approx 5$ layers deep, and a search needs only a handful of greedy hops per layer. That logarithmic structure is why HNSW queries stay fast as the collection grows.

## The knobs

- **`M`**: links per node. Higher means better recall and more memory.
- **`ef_construction`**: how many candidates to consider while building. Higher builds a better graph, more slowly.
- **`ef_search`** (in pgvector, `hnsw.ef_search`): the size of the candidate list kept during a query. This is the main runtime trade-off: raising it improves recall and costs latency. It must be at least $k$.

Tune these by measuring recall against exact search on a sample of real queries.

## IVF: the other common index

**IVF (inverted file)** indexes cluster the vectors with k-means into, say, $1{,}000$ lists. A query is compared with the cluster centres, and only the closest `nprobe` lists are scanned. With $1{,}000{,}000$ vectors in $1{,}000$ lists and `nprobe = 10`, the query scans about $10{,}000$ vectors, $1\%$ of the data. IVF builds faster and uses less memory than HNSW but usually needs more tuning to reach the same recall, and it must be built after data exists because the clusters are learned from it.

## Vector search in Postgres with pgvector

pgvector adds a `vector` column type and distance operators: `<->` for Euclidean distance, `<=>` for cosine distance, and `<#>` for negative inner product. A typical setup:

```sql
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);

SELECT id, 1 - (embedding <=> $1) AS cosine_similarity
FROM chunks
WHERE course_id = $2
ORDER BY embedding <=> $1
LIMIT 8;
```

The operator class in the index must match the operator in the query, or the index will not be used. Note that cosine **distance** is $1 - \text{cosine similarity}$, so smaller is better.

## Filtering

Real queries rarely search everything. A student should retrieve only from their course and their own uploads. Combining filters with ANN search is subtle: if the index returns the top $40$ candidates and the filter then removes most of them, you may get fewer than $k$ results, or miss good matches entirely. Remedies include raising `ef_search`, using iterative index scans where supported, partitioning by tenant, or applying very selective filters first and scanning the small remainder exactly.

## Common mistakes

- **Mixing distance metrics.** Building the index with one metric and querying with another silently disables it or ranks results incorrectly.
- **Ignoring recall.** An ANN index can be fast and wrong; measure recall against brute force.
- **Using ANN for tiny collections.** For a few thousand vectors, exact search is simple and fast.
- **Forgetting the filter problem.** Post-filtering ANN results can starve the result set.

## Check yourself

1. How much memory do $200{,}000$ vectors of dimension $1{,}024$ in 32-bit floats need? (Answer: $200{,}000 \times 1{,}024 \times 4 = 819{,}200{,}000$ bytes, about $0.82$ GB.)
2. What does raising `ef_search` do to recall and latency?
3. Why does HNSW search start at the top layer rather than the bottom?
