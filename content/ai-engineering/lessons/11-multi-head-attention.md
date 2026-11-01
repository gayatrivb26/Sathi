# Multi-head attention

## One softmax is one point of view

A single attention operation produces, for each token, one set of weights over the sequence. But a token usually has several relationships at once. In "The engineer who fixed the bug was promoted", the word "was" needs its subject ("engineer", several words away), while "fixed" relates most to "bug". One softmax row has to compromise: if it spreads its weight across all of these, each signal is diluted; if it focuses on one, the others are lost.

**Multi-head attention** runs several attention operations in parallel, each with its own learned projections. Each **head** can specialise in a different kind of relationship, and their results are combined at the end.

## How it works

With model width $d_{\text{model}}$ and $h$ heads, each head $i$ has its own matrices $W_Q^{(i)}$, $W_K^{(i)}$ and $W_V^{(i)}$, each projecting down to a smaller size $d_k = d_{\text{model}} / h$:

$$\text{head}_i = \text{Attention}\big(XW_Q^{(i)},\ XW_K^{(i)},\ XW_V^{(i)}\big)$$

Each head is ordinary scaled dot-product attention, and each divides its scores by $\sqrt{d_k}$ using its **own** head dimension. The head outputs (each $n \times d_k$) are concatenated side by side back to $n \times d_{\text{model}}$, then mixed by an output projection $W_O$:

$$\text{MultiHead}(X) = \text{Concat}(\text{head}_1, \dots, \text{head}_h)\, W_O$$

The output projection matters: without it, each head's information would stay in its own slice of the vector. $W_O$ lets the model combine what the heads found into one representation.

In code, nobody loops over heads. The projections are done as one big matrix multiply to $d_{\text{model}}$ columns, and the result is **reshaped** to $(h, n, d_k)$ so all heads run as a single batched operation.

## Worked example: sizes and parameter counts

Take the configuration from the original Transformer paper: $d_{\text{model}} = 512$ and $h = 8$.

**Head size.** $d_k = 512 / 8 = 64$, so each head scales its scores by $\sqrt{64} = 8$.

**Parameters.** Stacking all heads, the query projection is $512 \times 512$, and so are the key, value and output projections. Ignoring biases:

$$4 \times 512 \times 512 = 4 \times 262{,}144 = 1{,}048{,}576 \text{ parameters}$$

That is exactly the same as a single head of width $512$ plus an output projection. Multi-head attention does not cost more parameters; it **splits** the same budget into eight independent subspaces.

**Compute.** For a sequence of length $n$, the score computation for one wide head costs about $n^2 \times 512$ multiply-adds; for eight heads of width $64$ it costs $8 \times n^2 \times 64 = n^2 \times 512$. Same work, more expressive.

**Concatenation.** Suppose, for a two-head toy model with $d_k = 2$, one token's head outputs are $[0.88, 0.12]$ and $[0.20, 0.80]$. Concatenation gives $[0.88, 0.12, 0.20, 0.80]$, a vector of width $4 = d_{\text{model}}$, which $W_O$ (a $4 \times 4$ matrix) then mixes.

## What do heads learn?

Researchers inspecting trained models find heads with recognisable jobs: heads that attend to the previous token, heads that track syntactic relations such as verb-to-subject, heads that copy repeated patterns (sometimes called induction heads), and heads that attend mostly to punctuation or the first token as a kind of "no-op". Not every head is interpretable, and many can be pruned with little loss, but the diversity is real. Different heads learning different patterns is the whole point.

## Memory at inference: the KV cache and grouped heads

During generation, each layer caches the keys and values for every past token and every head. The cache size is

$$2 \times \text{layers} \times \text{heads} \times d_k \times \text{tokens} \times \text{bytes per number}$$

with the $2$ counting keys and values. For a model with $32$ layers, $32$ heads, $d_k = 128$, a context of $4{,}096$ tokens and 16-bit numbers (2 bytes):

$$2 \times 32 \times 32 \times 128 \times 4{,}096 \times 2 = 2{,}147{,}483{,}648 \text{ bytes} = 2 \text{ GiB}$$

That is for **one** sequence. Serving many users at once multiplies it.

Two variants reduce this. **Multi-query attention (MQA)** keeps many query heads but shares a single key head and value head across them. **Grouped-query attention (GQA)** sits between the two: query heads are split into groups, and each group shares one key/value head. With $8$ key/value heads instead of $32$ in the example above, the cache shrinks by a factor of $4$ to $0.5$ GiB, usually with very little quality loss. Many recent open models use GQA.

## Common mistakes

- **Scaling by the full model width.** Each head divides by $\sqrt{d_k}$ for its own head dimension ($\sqrt{64}$, not $\sqrt{512}$).
- **Thinking more heads means more parameters.** With $d_k = d_{\text{model}}/h$, the parameter count is unchanged.
- **Forgetting the output projection.** Concatenation alone leaves head outputs unmixed.
- **Using too many heads.** If $d_k$ becomes very small (say $8$), each head's subspace is too narrow to represent useful queries and keys.

## Check yourself

1. A model has $d_{\text{model}} = 768$ and $12$ heads. What is $d_k$ and what does each head divide its scores by? (Answer: $d_k = 64$; divide by $8$.)
2. Why does splitting one wide head into several narrow heads not change the parameter count?
3. A model switches from 32 key/value heads to 4, keeping everything else equal. By what factor does its KV cache shrink? (Answer: by $8$.)
