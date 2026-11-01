# Queries, keys and values

## Three roles for one token

In the previous lesson, attention took a query, a set of keys and a set of values as given. In self-attention all three come from the same tokens, so where do they come from? If we simply used each token's embedding as its query, key and value, the score between tokens $i$ and $j$ would be $x_i \cdot x_j$, which is symmetric and mostly measures "how similar are these two words". That is too limited. A verb may need to find its subject, a pronoun its antecedent, an adjective its noun. Those relationships are not about similarity, and they are not symmetric.

The Transformer's answer is to give each token three different **learned projections** of its embedding, one for each role:

- The **query** $q_i = x_i W_Q$ says *what this token is looking for*.
- The **key** $k_j = x_j W_K$ says *what this token offers to be found by*.
- The **value** $v_j = x_j W_V$ says *what information this token hands over if selected*.

$W_Q$, $W_K$ and $W_V$ are ordinary weight matrices trained by backpropagation. A useful analogy is a search engine: your query is the search text, each page's key is its title and tags, and its value is the page content you actually read.

## Shapes in matrix form

Stack the $n$ token embeddings as rows of a matrix $X$ with shape $n \times d_{\text{model}}$. Then

$$Q = X W_Q, \qquad K = X W_K, \qquad V = X W_V$$

where $W_Q$ and $W_K$ have shape $d_{\text{model}} \times d_k$ and $W_V$ has shape $d_{\text{model}} \times d_v$. The score matrix is $QK^\top$, with shape $n \times n$: entry $(i, j)$ is how much token $i$'s query matches token $j$'s key. Each row is turned into weights by a softmax, and multiplying by $V$ gives an $n \times d_v$ output, one new vector per token. All tokens are computed at once with a few matrix multiplications.

## Worked example: two tokens

Take two tokens with embeddings $x_1 = [1, 0]$ and $x_2 = [0, 1]$, and these learned matrices (row-vector convention, $q = xW$):

$$W_Q = \begin{bmatrix} 1 & 1 \\ 0 & 1 \end{bmatrix}, \quad W_K = \begin{bmatrix} 2 & 0 \\ 0 & 1 \end{bmatrix}, \quad W_V = \begin{bmatrix} 2 & 0 \\ 0 & 3 \end{bmatrix}$$

Because the embeddings are one-hot, each projection just picks a row:

- Queries: $q_1 = [1, 1]$, $q_2 = [0, 1]$
- Keys: $k_1 = [2, 0]$, $k_2 = [0, 1]$
- Values: $v_1 = [2, 0]$, $v_2 = [0, 3]$

**Scores** $q_i \cdot k_j$:

- Token 1: $q_1 \cdot k_1 = 2$, $q_1 \cdot k_2 = 1$
- Token 2: $q_2 \cdot k_1 = 0$, $q_2 \cdot k_2 = 1$

Notice $q_1 \cdot k_2 = 1$ but $q_2 \cdot k_1 = 0$. How much token 1 wants from token 2 is not the same as how much token 2 wants from token 1. Separate query and key projections make that asymmetry possible.

**Scale and softmax.** Here $d_k = 2$, so we divide by $\sqrt{2} \approx 1.414$ (the next lesson explains why):

- Token 1: scaled scores $[1.414,\ 0.707]$. The difference is $0.707$, so the weights are $[0.670,\ 0.330]$.
- Token 2: scaled scores $[0,\ 0.707]$, giving weights $[0.330,\ 0.670]$.

(For two scores, the larger weight is $1/(1 + e^{-\Delta})$ with $\Delta$ the difference; $1/(1 + e^{-0.707}) \approx 0.670$.)

**Outputs.**

- $o_1 = 0.670 \times [2, 0] + 0.330 \times [0, 3] \approx [1.34,\ 0.99]$
- $o_2 = 0.330 \times [2, 0] + 0.670 \times [0, 3] \approx [0.66,\ 2.01]$

Each token now carries a blend of both tokens' values, mixed according to what it was looking for.

## Masks: controlling who can see whom

In a language model that predicts the next token, token $i$ must not see tokens after it, or training would be trivial cheating. A **causal mask** sets the scores for future positions to $-\infty$ before the softmax, so their weights become exactly $0$. In the example, with a causal mask, token 1 can only attend to itself: its scores become $[1.414,\ -\infty]$, its weights $[1, 0]$, and its output is simply $v_1 = [2, 0]$. Token 2 is unaffected because it can already see token 1.

**Padding masks** work the same way: when sequences in a batch are padded to equal length, the padded positions are masked out so no real token attends to them.

## Self-attention and cross-attention

In **self-attention**, $Q$, $K$ and $V$ all come from the same sequence. In **cross-attention**, the queries come from one sequence and the keys and values from another. The original Transformer for translation used cross-attention so each output word could look at the encoded source sentence. The mechanism is identical; only the inputs differ.

## The KV cache

When a language model generates text token by token, the keys and values of earlier tokens do not change. Inference engines therefore store them in a **KV cache** and, for each new token, compute only that token's query, key and value. The new query attends over all cached keys. This makes generation much faster, but the cache grows with every token, which is why long contexts consume so much GPU memory.

## Common mistakes

- **Thinking $Q$, $K$ and $V$ are different inputs in self-attention.** They are three projections of the same embeddings.
- **Assuming attention scores are symmetric.** With separate $W_Q$ and $W_K$, the score from $i$ to $j$ generally differs from $j$ to $i$.
- **Masking after the softmax.** Setting weights to zero after softmax leaves rows that no longer sum to one. Mask the scores with $-\infty$ before the softmax.
- **Mixing up which matrix the output weights multiply.** Weights multiply the **values**, not the keys.

## Check yourself

1. If $X$ has shape $10 \times 512$ and $W_Q$ has shape $512 \times 64$, what are the shapes of $Q$ and of $QK^\top$? (Answer: $10 \times 64$ and $10 \times 10$.)
2. Why would using the raw embedding as query, key and value limit what attention can learn?
3. In a causal language model, what weight does the first token give to the second token, and why?
