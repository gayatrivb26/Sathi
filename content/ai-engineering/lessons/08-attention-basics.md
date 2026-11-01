# Attention basics

## The problem: context changes meaning

An embedding table gives the word "bank" one fixed vector. But "she sat on the river bank" and "he robbed the bank" use it very differently. To understand a token, a model has to look at the other tokens around it and decide which ones matter. Older recurrent networks did this by reading one token at a time and squeezing everything seen so far into a single hidden state, which made long-range connections hard to learn and training impossible to parallelise.

**Attention** takes a direct approach. To build a new representation for a token, it looks at every token in the sequence at once, scores how relevant each one is, and takes a **weighted average** of their information. Relevant tokens get large weights; irrelevant ones get weights close to zero. The weights are computed from the data, so they change with every sentence.

## Attention as a soft dictionary lookup

A software analogy helps. A dictionary (hash map) lookup takes a **query**, finds the one **key** that matches exactly, and returns its **value**. Attention is a soft, differentiable version of this:

1. Compare the query with **every** key to get a similarity score.
2. Turn the scores into weights that are positive and sum to one, using softmax.
3. Return the weighted sum of **all** the values.

In symbols, with query $q$, keys $k_1, \dots, k_n$ and values $v_1, \dots, v_n$:

$$s_i = q \cdot k_i, \qquad \alpha_i = \frac{e^{s_i}}{\sum_j e^{s_j}}, \qquad \text{output} = \sum_i \alpha_i v_i$$

Because every step is smooth, gradients flow through the weights, and the model can learn what to look for. The next lesson explains where queries, keys and values come from; for now, treat them as given vectors.

## Worked example: three items

Let the query be $q = [1, 0]$ and the keys and values be:

| item | key $k_i$ | value $v_i$ |
|---|---|---|
| 1 | $[1, 0]$ | $[10, 0]$ |
| 2 | $[0, 1]$ | $[0, 10]$ |
| 3 | $[1, 1]$ | $[5, 5]$ |

**Scores.** $s_1 = 1$, $s_2 = 0$, $s_3 = 1$.

**Softmax.** $e^1 \approx 2.718$, $e^0 = 1$, $e^1 \approx 2.718$. The sum is $6.437$, so the weights are

$$\alpha = [0.422,\ 0.155,\ 0.422]$$

**Weighted sum.**

$$0.422 \times [10, 0] + 0.155 \times [0, 10] + 0.422 \times [5, 5] = [4.223 + 2.111,\ 1.554 + 2.111] \approx [6.33,\ 3.67]$$

The output leans towards items 1 and 3, whose keys matched the query, but item 2 still contributes a little. That is the "soft" in soft lookup.

## Why the scores need scaling

There is a catch hiding in step 1. The dot product of two vectors adds up one term per dimension, so as the dimension $d_k$ of the queries and keys grows, the scores grow too. If the entries of $q$ and $k$ are independent with mean $0$ and variance $1$, the dot product $q \cdot k = \sum_{i=1}^{d_k} q_i k_i$ is a sum of $d_k$ terms that each have variance $1$, so its variance is $d_k$ and its typical size is $\sqrt{d_k}$. For $d_k = 64$, scores are typically around $\pm 8$ rather than $\pm 1$.

Large scores are a problem because of what softmax does with them. Softmax depends on the **differences** between scores, exponentially. Compare two items with scores $[1, 0]$ against the same pattern scaled up to $[8, 0]$:

- $\text{softmax}([1, 0]) = [0.731,\ 0.269]$
- $\text{softmax}([8, 0]) = [0.99966,\ 0.00034]$

The second is almost **one-hot**: the model attends to one item and ignores the rest. Worse, a saturated softmax has tiny gradients. For two items the derivative of the first weight with respect to its score is $\alpha_1(1 - \alpha_1)$. That is $0.731 \times 0.269 \approx 0.197$ in the first case, but only about $0.00034$ in the second, nearly 600 times smaller. With gradients that small, the attention weights barely learn.

The fix is simple: divide the scores by $\sqrt{d_k}$ before the softmax. This brings their variance back to about $1$ regardless of dimension, keeps the softmax in its responsive range, and keeps gradients healthy. This is the "scaled" in **scaled dot-product attention**, which gets its own full lesson shortly.

## Self-attention

When the queries, keys and values all come from the same sequence, it is called **self-attention**: every token builds its new representation by attending over all the tokens in its own sentence, including itself. In "he robbed the bank", the token "bank" can put high weight on "robbed", and its output vector shifts towards the financial meaning. Because every token's output can be computed independently given the inputs, the whole sequence is processed in parallel on a GPU, which is a major reason attention-based models train so efficiently.

## Common mistakes

- **Thinking attention picks one token.** The output is a weighted average of all values; hard selection only emerges when the softmax saturates.
- **Thinking the weights are fixed parameters.** The attention weights are recomputed for every input. The learned parameters are the projections that produce queries, keys and values.
- **Forgetting the scaling.** Raw dot products in high dimensions push softmax towards one-hot outputs and starve the model of gradient.
- **Confusing scores with weights.** Scores can be any real number; weights are post-softmax, positive, and sum to one.

## Check yourself

1. Two items have scores $[2, 2]$. What are their attention weights? (Answer: equal scores give equal weights, $[0.5, 0.5]$.)
2. If query and key entries have unit variance, what is the variance of their dot product when $d_k = 256$, and what should you divide by? (Answer: variance $256$; divide by $\sqrt{256} = 16$.)
3. Why does a nearly one-hot softmax make attention hard to train?
