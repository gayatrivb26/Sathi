# The Transformer block

## Putting the pieces together

You have now met every ingredient: embeddings, multi-head scaled dot-product attention and positional information. A **Transformer** is a stack of identical **blocks**, each of which refines every token's vector a little. A block has two sub-layers:

1. **Multi-head self-attention**, where tokens exchange information with each other.
2. A position-wise **feed-forward network (FFN)**, where each token processes what it gathered, independently of the others.

Each sub-layer is wrapped with a **residual connection** and **layer normalisation**. That wrapper is what lets us stack dozens of blocks and still train them.

A helpful slogan: attention is "communication", the FFN is "computation".

## The block, step by step

Modern language models use the **pre-norm** arrangement:

$$h = x + \text{MultiHeadAttention}(\text{LayerNorm}(x))$$
$$y = h + \text{FFN}(\text{LayerNorm}(h))$$

The input $x$ and output $y$ have the same shape, $n \times d_{\text{model}}$, so blocks can be stacked freely. The original 2017 paper used **post-norm**, applying LayerNorm after each addition; pre-norm turned out to train more stably for deep stacks.

## Residual connections

The "$x + \dots$" is the residual (or skip) connection. Each sub-layer computes a **change** to add to the running representation, rather than replacing it. Think of the vector flowing through the network as a shared "residual stream" that every block reads from and writes to.

Residuals matter most for training. During backpropagation, the derivative of $x + f(x)$ with respect to $x$ is $1 + f'(x)$. The "$1$" gives gradients a direct path from the loss to the earliest layers, no matter how many blocks sit in between, which tames the vanishing-gradient problem you met with deep sigmoid networks.

## Layer normalisation

LayerNorm rescales each token's vector to zero mean and unit variance across its features, then applies a learned scale $\gamma$ and shift $\beta$:

$$\text{LayerNorm}(x) = \gamma \odot \frac{x - \mu}{\sqrt{\sigma^2 + \epsilon}} + \beta$$

**Worked example.** For $x = [2, 4, 6]$: the mean is $\mu = 4$, the variance is $\big((-2)^2 + 0^2 + 2^2\big)/3 = 8/3 \approx 2.667$, and the standard deviation is $\approx 1.633$. So the normalised vector is

$$\left[\frac{-2}{1.633},\ 0,\ \frac{2}{1.633}\right] \approx [-1.225,\ 0,\ 1.225]$$

before $\gamma$ and $\beta$ are applied. Unlike batch normalisation, LayerNorm works per token, so it behaves identically at any batch size and during generation. Many recent models use **RMSNorm**, a simplified version that skips the mean subtraction.

## The feed-forward network

The FFN is a two-layer MLP applied to each token separately, with the same weights at every position:

$$\text{FFN}(x) = W_2\, \text{GELU}(W_1 x + b_1) + b_2$$

The hidden layer is wider than the model, typically $d_{ff} = 4\, d_{\text{model}}$. Attention moves information between positions; the FFN is where much of the model's stored knowledge appears to live. Many modern models replace GELU with a gated variant such as SwiGLU.

## Worked example: counting parameters in GPT-2 small

GPT-2 small has $d_{\text{model}} = 768$, $12$ blocks, a vocabulary of $50{,}257$ tokens and $1{,}024$ learned positions. Ignoring biases and LayerNorm parameters, which are tiny:

- **Attention per block**: four $768 \times 768$ matrices, $4 \times 589{,}824 = 2{,}359{,}296$.
- **FFN per block**: with $d_{ff} = 3{,}072$, two matrices of $768 \times 3{,}072$, $2 \times 2{,}359{,}296 = 4{,}718{,}592$.
- **Per block total**: $7{,}077{,}888$, so $12$ blocks hold $84{,}934{,}656$.
- **Token embeddings**: $50{,}257 \times 768 = 38{,}597{,}376$.
- **Position embeddings**: $1{,}024 \times 768 = 786{,}432$.

The sum is $124{,}318{,}464$, matching the published "124M parameters" once the small bias and normalisation terms are added. Two lessons fall out: the FFN holds **twice** as many parameters as attention in each block, and in small models the embedding table is a big share of the total. (GPT-2 reuses the token embedding matrix for its output layer, so that is not counted twice.)

## From the last block to a prediction

After the final block, a decoder-only language model applies one more LayerNorm and multiplies each token's vector by the output matrix to get a **logit** for every vocabulary item. Softmax turns the logits into a probability distribution over the next token, and training minimises cross-entropy against the actual next token, the same loss from the very first lesson. A causal mask in every attention layer guarantees each position only sees the past.

There are three family shapes:

- **Encoder-only** (BERT-style): no causal mask; every token sees the whole input. Good for classification and embeddings.
- **Decoder-only** (GPT-style): causal mask; generates text left to right. Most chat LLMs.
- **Encoder–decoder** (original Transformer, T5): an encoder reads the input; a decoder generates output and uses cross-attention to look at the encoder.

## Common mistakes

- **Thinking the FFN mixes tokens.** It is applied to each position independently; only attention moves information between tokens.
- **Dropping the residual connections.** Without them, deep stacks become very hard to train.
- **Confusing LayerNorm with BatchNorm.** LayerNorm normalises across features of one token, not across the batch.
- **Assuming most parameters are in attention.** In standard blocks, the FFN holds about two-thirds.

## Check yourself

1. Why must every block's output have the same shape as its input?
2. For $d_{\text{model}} = 1{,}024$ and $d_{ff} = 4{,}096$, how many weights are in one block's FFN, ignoring biases? (Answer: $2 \times 1{,}024 \times 4{,}096 = 8{,}388{,}608$.)
3. How does the residual connection help gradients reach early layers?
