# Scaled dot-product attention

## The formula

Everything from the last two lessons fits in one line. Given query, key and value matrices $Q$ ($n \times d_k$), $K$ ($m \times d_k$) and $V$ ($m \times d_v$):

$$\text{Attention}(Q, K, V) = \text{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}} + M\right) V$$

Read it from the inside out:

1. $QK^\top$ computes every query–key dot product, an $n \times m$ score matrix.
2. Dividing by $\sqrt{d_k}$ **scales** the scores so their size does not depend on the dimension.
3. $M$ is an optional **mask**: $0$ where attention is allowed, $-\infty$ where it is not (future tokens, padding).
4. The softmax is applied to each **row**, turning one query's scores into weights that sum to one.
5. Multiplying by $V$ takes the weighted average of value vectors for each query.

This is the core operation inside the attention layers of standard Transformers. This lesson focuses on the part that looks most arbitrary: why $\sqrt{d_k}$?

## Why dot products grow with dimension

Assume the entries of a query $q$ and a key $k$ are independent random numbers with mean $0$ and variance $1$. That is roughly the situation at the start of training, thanks to normalisation and initialisation. Their dot product is

$$q \cdot k = \sum_{i=1}^{d_k} q_i k_i$$

Look at one term. Its mean is $E[q_i k_i] = E[q_i]\,E[k_i] = 0$. Its variance is $E[q_i^2 k_i^2] - 0 = E[q_i^2]\,E[k_i^2] = 1 \times 1 = 1$.

The dot product is a sum of $d_k$ independent terms, each with variance $1$, and variances of independent terms add. So

$$\text{Var}(q \cdot k) = d_k, \qquad \text{std}(q \cdot k) = \sqrt{d_k}$$

For $d_k = 64$, a typical score is around $\pm 8$; for $d_k = 512$, around $\pm 22.6$. The larger the head dimension, the larger the scores, even though nothing about the tokens has changed.

Dividing by $\sqrt{d_k}$ fixes it exactly: $\text{Var}\big(q \cdot k / \sqrt{d_k}\big) = d_k / d_k = 1$. The scaled scores have unit variance at any dimension.

## Why large scores are harmful: saturation

Softmax is exponential in the score differences. When the scores are spread over a wide range, the largest one dominates and the output becomes nearly **one-hot**. With $d_k = 64$ and no scaling, two keys whose scores differ by $16$ (unremarkable when each score has a standard deviation of $8$) get weights in the ratio $e^{16} \approx 8.9$ million to one. Attention has collapsed onto a single token before the model has learned anything.

A saturated softmax also kills learning. The derivative of softmax output $i$ with respect to score $j$ is

$$\frac{\partial \alpha_i}{\partial s_j} = \alpha_i(\delta_{ij} - \alpha_j)$$

When one weight is near $1$ and the rest near $0$, **every** entry of this Jacobian is near $0$: either $\alpha_i \approx 0$, or $\alpha_i \approx 1$ and $(1 - \alpha_i) \approx 0$. Gradients flowing back through the softmax into $W_Q$ and $W_K$ become tiny, so the model cannot learn better attention patterns. That is the chain: **dot products grow with dimension → softmax saturates towards one-hot → gradients vanish**. Scaling by $\sqrt{d_k}$ breaks the chain at the first link.

## Worked example: two tokens, scaled and unscaled

Let $d_k = 4$, so $\sqrt{d_k} = 2$. One query attends over two keys:

- $q = [1, 0, 1, 0]$
- $k_1 = [2, 1, 2, 0]$, $k_2 = [0, 1, 0, 2]$
- $v_1 = [1, 0]$, $v_2 = [0, 1]$

**Raw scores.** $q \cdot k_1 = 2 + 0 + 2 + 0 = 4$ and $q \cdot k_2 = 0 + 0 + 0 + 0 = 0$.

**Scaled scores.** $[4, 0] / 2 = [2, 0]$.

**Softmax.** $e^2 \approx 7.389$ and $e^0 = 1$, so

$$\alpha = \left[\frac{7.389}{8.389},\ \frac{1}{8.389}\right] \approx [0.881,\ 0.119]$$

**Output.** $0.881 \times [1, 0] + 0.119 \times [0, 1] = [0.881,\ 0.119]$.

**Compare without scaling.** $\text{softmax}([4, 0])$ gives $e^4 \approx 54.598$, so $\alpha \approx [0.982,\ 0.018]$. The gradient factor $\alpha_1(1 - \alpha_1)$ is $0.881 \times 0.119 \approx 0.105$ with scaling but $0.982 \times 0.018 \approx 0.018$ without, about six times smaller even at this tiny dimension. At $d_k = 64$ the gap is dramatically larger.

## Masking and numerical stability

Masks are **added** to the scaled scores before the softmax. A score of $-\infty$ becomes $e^{-\infty} = 0$ after exponentiation, so masked positions receive exactly zero weight and the remaining weights still sum to one. In practice libraries use a large negative number instead of true infinity.

Implementations also compute softmax stably by subtracting the row maximum before exponentiating: $\text{softmax}(s) = \text{softmax}(s - \max s)$. The result is mathematically identical but avoids overflow when scores are large.

## Cost: the $n^2$ in attention

The score matrix has one entry per query–key pair, so for a sequence of $n$ tokens attention costs $O(n^2 d_k)$ compute and $O(n^2)$ memory per head. For $n = 4{,}096$ that is $16{,}777{,}216$ scores; stored in 16-bit floats at 2 bytes each, that is 32 MiB **per head, per layer**. This quadratic growth is why long context windows are expensive. Kernels such as FlashAttention compute exactly the same result in tiles without ever materialising the full matrix, which saves memory and time but does not change the maths.

## Common mistakes

- **Dividing by $d_k$ instead of $\sqrt{d_k}$.** That over-shrinks scores (variance $1/d_k$), making attention nearly uniform.
- **Applying softmax over the wrong axis.** Each query's row must sum to one. Normalising columns mixes up queries.
- **Masking after the softmax.** Mask the scores, not the weights.
- **Believing scaling is optional at small dimensions.** It matters less when $d_k$ is tiny, but real heads use $d_k = 64$ or $128$, where saturation is severe.

## Check yourself

1. Query and key entries have unit variance and $d_k = 128$. What is the standard deviation of the raw dot product, and what does scaling make it? (Answer: $\sqrt{128} \approx 11.3$; after scaling, $1$.)
2. Explain in your own words the three-step chain from large $d_k$ to slow learning.
3. Scores for one query are $[3, 3, -\infty]$. What are the attention weights? (Answer: $[0.5, 0.5, 0]$.)
