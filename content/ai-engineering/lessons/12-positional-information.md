# Positional information

## Attention cannot see order

Here is a surprising property of everything built so far. Take a sentence, shuffle its tokens, and run self-attention again. Each token computes exactly the same scores against exactly the same set of keys, so it gets exactly the same output vector; the outputs just come out in the shuffled order. Mathematically, self-attention is **permutation-equivariant**: permuting the input permutes the output and changes nothing else.

That means a Transformer with no extra help sees "dog bites man" and "man bites dog" as the same bag of tokens. For language, where order carries meaning, that is unacceptable. We need to inject **positional information** so the model knows where each token sits.

Recurrent networks never had this problem, because they read tokens in sequence. Attention gave up that sequential reading in exchange for parallelism, so position has to be added back explicitly.

## Option 1: absolute position embeddings

The simplest idea is to give each position its own vector and **add** it to the token embedding before the first layer:

$$x_i = \text{TokenEmbedding}(t_i) + \text{PositionEmbedding}(i)$$

The original Transformer used fixed **sinusoidal** position vectors. For position $p$ and dimension pairs indexed by $i$:

$$PE(p, 2i) = \sin\!\left(\frac{p}{10000^{2i/d}}\right), \qquad PE(p, 2i+1) = \cos\!\left(\frac{p}{10000^{2i/d}}\right)$$

Each pair of dimensions is a sine and cosine wave at a different frequency. Low dimensions oscillate quickly and distinguish neighbouring positions; high dimensions oscillate slowly and encode coarse location. It is a little like the hands of a clock: the second hand tells you about small differences, the hour hand about large ones.

An alternative is **learned** position embeddings: a trainable table with one row per position, exactly like a token embedding table. GPT-2 did this with $1{,}024$ positions. The drawback is a hard limit: the model has no vector for position $1{,}025$.

## Worked example: sinusoidal encodings with $d = 4$

With $d = 4$ there are two frequency pairs. For $i = 0$ the divisor is $10000^{0} = 1$; for $i = 1$ it is $10000^{2/4} = 100$. So the encoding of position $p$ is

$$[\sin p,\ \cos p,\ \sin(p/100),\ \cos(p/100)]$$

- Position $0$: $[0,\ 1,\ 0,\ 1]$
- Position $1$: $[0.841,\ 0.540,\ 0.010,\ 1.000]$
- Position $2$: $[0.909,\ -0.416,\ 0.020,\ 1.000]$

The first pair changes a lot from one position to the next; the second pair barely moves (its cosine is $0.99995$ at position 1 and $0.9998$ at position 2). A real model with $d = 512$ has 256 such pairs spanning a huge range of frequencies, so every position up to many thousands gets a distinct pattern.

A useful property: for any fixed offset $k$, the encoding of position $p + k$ is a fixed rotation of the encoding of position $p$, within each sine–cosine pair. That makes relative offsets easy for the model to detect.

## Option 2: rotary position embeddings (RoPE)

Most modern language models use **RoPE**. Instead of adding a vector to the input, RoPE **rotates** the query and key vectors inside every attention layer by an angle proportional to their position. Each pair of dimensions is treated as a 2-D point and rotated by $p\,\theta$, with a different $\theta$ per pair.

The payoff appears in the dot product. If a query at position $m$ is rotated by $m\theta$ and a key at position $n$ by $n\theta$, the angle between them changes by $(m - n)\theta$. Their score therefore depends on the **relative** distance $m - n$, not on the absolute positions.

**Worked example.** Use one 2-D pair with $\theta = 0.5$ radians, and take $q = [1, 0]$ and $k = [1, 0]$.

- Query at position $3$ is rotated to angle $1.5$; key at position $1$ to angle $0.5$. Both are unit vectors, so their dot product is $\cos(1.5 - 0.5) = \cos(1) \approx 0.540$.
- Now move both ten positions later: query at $13$ (angle $6.5$), key at $11$ (angle $5.5$). The dot product is $\cos(6.5 - 5.5) = \cos(1) \approx 0.540$.

Same offset, same score. That is exactly the behaviour we want: "the word two places back" should mean the same thing at the start of a document and in the middle of it.

## Option 3: attention biases (ALiBi)

**ALiBi** skips position vectors entirely and adds a penalty to each attention score proportional to the distance between the tokens: score $- m \cdot |i - j|$, with a fixed slope $m$ per head. Distant tokens are discouraged but not forbidden. Like RoPE, it encodes relative position and tends to cope better than learned absolute embeddings with sequences longer than those seen in training.

## Context length and extrapolation

Positional schemes strongly affect how a model behaves beyond its training length. Learned absolute embeddings simply have no entry for longer positions. Sinusoidal and rotary schemes produce values for any position, but the model has never learned what very large angles mean, so quality usually drops past the training length. Techniques that rescale RoPE frequencies (often called position interpolation) plus some fine-tuning on long documents are how many models extend their context windows.

## Common mistakes

- **Assuming attention knows order by default.** It does not; without positional information, it treats input as a set.
- **Concatenating instead of adding.** Classic absolute embeddings are added to token embeddings, keeping the width $d_{\text{model}}$.
- **Applying RoPE to values.** RoPE rotates queries and keys only, because only their dot product needs position.
- **Expecting free long-context behaviour.** A model trained on 4K tokens will not automatically work well at 32K.

## Check yourself

1. Why does shuffling the input tokens of a Transformer without positional information only shuffle its outputs?
2. Compute the $d = 4$ sinusoidal encoding of position $0$. (Answer: $[0, 1, 0, 1]$.)
3. With RoPE, why do a query at position 7 and a key at position 5 give the same score as the same vectors at positions 107 and 105?
