/* Mock-only seed content: an "AI Engineering" course mirroring the sample screens. */

export interface SeedConcept {
  id: string;
  slug: string;
  name: string;
  description: string;
}
export interface SeedLesson {
  id: string;
  title: string;
  summary: string;
  minutes: number;
  concepts: string[];
  objectives: string[];
  markdown?: string;
}
export interface SeedModule {
  id: string;
  title: string;
  summary: string;
  lessons: SeedLesson[];
}
export interface SeedQuestion {
  id: string;
  concept: string;
  lesson?: string;
  type: 'mcq' | 'short';
  stem: string;
  explanation: string;
  difficulty: number;
  diagnostic?: boolean;
  options?: [string, string, string, string];
  correct?: 0 | 1 | 2 | 3;
  rubric?: { criteria: { id: string; description: string; points: number }[]; modelAnswer: string };
}

export const COURSE_ID = 'crs-ai-engineering';

export const CONCEPTS: SeedConcept[] = [
  { id: 'cpt-gd', slug: 'gradient-descent', name: 'Gradient descent', description: 'Iteratively moving parameters against the gradient to reduce loss.' },
  { id: 'cpt-loss', slug: 'loss-functions', name: 'Loss functions', description: 'Measuring how wrong a model is: MSE, cross-entropy and friends.' },
  { id: 'cpt-emb', slug: 'embeddings', name: 'Embeddings', description: 'Dense vectors that place similar items close together.' },
  { id: 'cpt-softmax', slug: 'softmax', name: 'Softmax', description: 'Turning scores into a probability distribution.' },
  { id: 'cpt-backprop', slug: 'backpropagation', name: 'Backpropagation', description: 'Computing gradients layer by layer with the chain rule.' },
  { id: 'cpt-attn', slug: 'attention', name: 'Attention', description: 'Weighting values by query–key similarity.' },
  { id: 'cpt-transformer', slug: 'transformers', name: 'Transformer architecture', description: 'Stacked attention and feed-forward blocks with residuals.' },
  { id: 'cpt-rag', slug: 'rag', name: 'Retrieval & RAG', description: 'Grounding model answers in retrieved passages with citations.' },
];

const ATTENTION_MD = `Attention lets every token look at every other token and decide **how much each one matters** right now. In this lesson you'll build scaled dot-product attention step by step.

## Queries, keys and values

Each token produces three vectors: a query $q$, a key $k$ and a value $v$. The score between token $i$ and token $j$ is the dot product $q_i \\cdot k_j$ — large when the two point the same way.

Stacking all queries into a matrix $Q$ and all keys into $K$, we compute every score at once:

$$\\text{scores} = QK^\\top$$

## Why divide by $\\sqrt{d_k}$?

If each component of $q$ and $k$ has mean 0 and variance 1, their dot product over $d_k$ dimensions has **variance $d_k$**. Large scores push softmax towards a one-hot output, where gradients almost vanish. Dividing by $\\sqrt{d_k}$ brings the variance back to 1:

$$\\operatorname{Attention}(Q, K, V) = \\operatorname{softmax}\\!\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right) V$$

> **Worked example.** With $d_k = 64$, raw scores have a standard deviation of 8. After scaling by $\\sqrt{64} = 8$ they have a standard deviation of 1, so softmax stays smooth.

## Putting it together

1. Project the inputs: $Q = XW_Q$, $K = XW_K$, $V = XW_V$.
2. Score and scale: $S = QK^\\top / \\sqrt{d_k}$.
3. Normalise each row with softmax so the weights sum to 1.
4. Mix the values: each output is a weighted average of the rows of $V$.

| Symbol | Shape | Meaning |
| --- | --- | --- |
| $X$ | $n \\times d$ | token embeddings |
| $Q, K$ | $n \\times d_k$ | queries and keys |
| $V$ | $n \\times d_v$ | values |

\`\`\`python
import numpy as np

def attention(Q, K, V):
    d_k = Q.shape[-1]
    scores = Q @ K.T / np.sqrt(d_k)
    weights = np.exp(scores - scores.max(axis=-1, keepdims=True))
    weights /= weights.sum(axis=-1, keepdims=True)
    return weights @ V
\`\`\`

## Check yourself

- What happens to softmax when all scores are multiplied by 10?
- Why do we subtract the row maximum before exponentiating?

Next you'll split attention into several heads that each learn a different notion of "relevant".`;

const BACKPROP_MD = `Backpropagation is how a neural network learns which weights to blame for a mistake. It is the **chain rule**, applied from the output backwards.

## The chain rule

If $y = f(g(x))$, then

$$\\frac{dy}{dx} = \\frac{dy}{dg} \\cdot \\frac{dg}{dx}$$

A network is a long chain of functions, so the gradient of the loss with respect to an early weight is a product of local derivatives.

## Backward pass, one layer at a time

For a layer $z = Wx + b$ followed by an activation $a = \\sigma(z)$:

$$\\frac{\\partial L}{\\partial W} = \\underbrace{\\frac{\\partial L}{\\partial a}}_{\\text{from above}} \\odot \\sigma'(z) \\; x^\\top$$

Each layer takes the gradient **arriving from above** and multiplies it by **its own local derivative**, then passes the result further back.

> **Worked example.** $L = (a - y)^2$, $a = \\sigma(wx)$ with $w = 0.5$, $x = 2$, $y = 1$. Then $z = 1$, $a = 0.731$, $\\partial L/\\partial a = 2(0.731 - 1) = -0.538$, $\\sigma'(1) = 0.197$, so $\\partial L/\\partial w = -0.538 \\times 0.197 \\times 2 = -0.212$.

## Common pitfalls

- Gradients are computed **after** the forward pass, never before.
- Very deep chains can make gradients vanish ($|\\sigma'| < 1$ repeatedly) or explode.`;

const GD_MD = `Gradient descent finds good parameters by repeatedly stepping **downhill** on the loss surface.

$$\\theta_{t+1} = \\theta_t - \\eta \\, \\nabla_\\theta L(\\theta_t)$$

The learning rate $\\eta$ sets the step size: too small and training crawls, too large and it overshoots.

> **Worked example.** $L(\\theta) = \\theta^2$, $\\theta_0 = 3$, $\\eta = 0.1$. The gradient is $2\\theta = 6$, so $\\theta_1 = 3 - 0.6 = 2.4$.

## Variants

- **Batch** gradient descent uses the whole dataset per step.
- **Stochastic** (SGD) uses one example — noisy but cheap.
- **Mini-batch** sits in between and is what everyone uses in practice.`;

function genericMd(title: string, summary: string): string {
  return `${summary}

## Key idea

This lesson introduces **${title.toLowerCase()}** and connects it to what you've already learned. Read the explanation, try the worked example, then check your understanding with a short quiz.

## Worked example

Suppose a model outputs scores $z = (2.0, 1.0, 0.1)$. Applying softmax,

$$p_i = \\frac{e^{z_i}}{\\sum_j e^{z_j}} \\approx (0.66, 0.24, 0.10)$$

so the first option is about 2.7 times more likely than the second.

## In practice

- Start from a small, well-understood baseline.
- Measure before and after every change.
- Keep notes on what surprised you — those are great questions for the tutor.`;
}

export const MODULES: SeedModule[] = [
  {
    id: 'mod-foundations',
    title: 'Foundations',
    summary: 'The maths you need: vectors, losses and optimisation.',
    lessons: [
      { id: 'les-linalg', title: 'Linear algebra refresher', summary: 'Vectors, dot products and matrices in ten minutes.', minutes: 10, concepts: ['cpt-emb'], objectives: ['Compute a dot product by hand', 'Explain what a matrix multiplication does to a vector'] },
      { id: 'les-loss', title: 'Loss functions', summary: 'How we measure being wrong: MSE and cross-entropy.', minutes: 12, concepts: ['cpt-loss', 'cpt-softmax'], objectives: ['Choose a loss for regression vs classification', 'Compute cross-entropy for a small example'] },
      { id: 'les-gd', title: 'Gradient descent', summary: 'Stepping downhill on the loss surface.', minutes: 12, concepts: ['cpt-gd'], objectives: ['Apply one gradient descent update by hand', 'Describe the effect of the learning rate'], markdown: GD_MD },
    ],
  },
  {
    id: 'mod-nn',
    title: 'Neural networks',
    summary: 'From a single neuron to training deep networks.',
    lessons: [
      { id: 'les-perceptron', title: 'Perceptrons and activations', summary: 'Neurons, weights and non-linearities.', minutes: 10, concepts: ['cpt-loss'], objectives: ['Explain why we need non-linear activations'] },
      { id: 'les-backprop', title: 'Backpropagation', summary: 'The chain rule, applied from the output backwards.', minutes: 15, concepts: ['cpt-backprop', 'cpt-gd'], objectives: ['Apply the chain rule through two layers', 'Explain why gradients flow backwards', 'Recognise vanishing gradients'], markdown: BACKPROP_MD },
      { id: 'les-optim', title: 'Optimizers in practice', summary: 'Momentum, Adam and learning-rate schedules.', minutes: 12, concepts: ['cpt-gd'], objectives: ['Compare SGD with momentum and Adam'] },
    ],
  },
  {
    id: 'mod-attention',
    title: 'Attention and Transformers',
    summary: 'How modern language models decide what to focus on.',
    lessons: [
      { id: 'les-embeddings', title: 'Embeddings', summary: 'Turning tokens into vectors that capture meaning.', minutes: 10, concepts: ['cpt-emb'], objectives: ['Explain what an embedding captures', 'Measure similarity with cosine'] },
      { id: 'les-attn-basics', title: 'Attention basics', summary: 'Weighted averages driven by relevance.', minutes: 10, concepts: ['cpt-attn', 'cpt-softmax'], objectives: ['Describe attention as a weighted average'] },
      { id: 'les-qkv', title: 'Queries, keys and values', summary: 'Three projections, three roles.', minutes: 10, concepts: ['cpt-attn'], objectives: ['Explain the role of Q, K and V'] },
      { id: 'les-attention', title: 'Attention mechanisms', summary: 'Ten minutes on scaled dot-product attention, then a short check.', minutes: 10, concepts: ['cpt-attn', 'cpt-softmax'], objectives: ['Compute scaled dot-product attention for a tiny example', 'Explain why scores are divided by √dₖ', 'Describe what each row of the attention matrix means'], markdown: ATTENTION_MD },
      { id: 'les-multihead', title: 'Multi-head attention', summary: 'Several attention patterns in parallel.', minutes: 12, concepts: ['cpt-attn', 'cpt-transformer'], objectives: ['Explain why multiple heads help'] },
      { id: 'les-positional', title: 'Positional encoding', summary: 'Giving order to a bag of tokens.', minutes: 10, concepts: ['cpt-transformer'], objectives: ['Explain why attention needs position information'] },
      { id: 'les-transformer', title: 'The Transformer block', summary: 'Attention, feed-forward, residuals and layer norm.', minutes: 15, concepts: ['cpt-transformer'], objectives: ['Draw a Transformer block from memory'] },
    ],
  },
  {
    id: 'mod-rag',
    title: 'Retrieval-augmented generation',
    summary: 'Grounding answers in your own documents.',
    lessons: [
      { id: 'les-chunking', title: 'Chunking and embeddings for search', summary: 'Splitting documents into searchable passages.', minutes: 12, concepts: ['cpt-rag', 'cpt-emb'], objectives: ['Choose a chunk size with overlap'] },
      { id: 'les-hybrid', title: 'Hybrid search and RRF', summary: 'Combining keyword and vector search.', minutes: 12, concepts: ['cpt-rag'], objectives: ['Compute a Reciprocal Rank Fusion score'] },
      { id: 'les-grounded', title: 'Grounded answers with citations', summary: 'Making the model show its sources.', minutes: 10, concepts: ['cpt-rag'], objectives: ['Explain how citation checks work'] },
    ],
  },
];

for (const m of MODULES) for (const l of m.lessons) l.markdown ??= genericMd(l.title, l.summary);

export const QUESTIONS: SeedQuestion[] = [
  // Backpropagation
  { id: 'q-bp-1', concept: 'cpt-backprop', lesson: 'les-backprop', type: 'mcq', difficulty: 0.5, diagnostic: true, stem: 'Which statement about the chain rule in backpropagation is correct?', options: ['Gradients are computed from the input forward', 'Each layer multiplies the incoming gradient by its local derivative', 'Weights are updated before gradients exist', 'Only the final layer receives a gradient'], correct: 1, explanation: 'Backpropagation moves from the output backward. Each layer takes the gradient arriving from above and multiplies it by its own local derivative.' },
  { id: 'q-bp-2', concept: 'cpt-backprop', lesson: 'les-backprop', type: 'mcq', difficulty: 0.5, stem: 'If dL/da = −0.5 and σ′(z) = 0.2, what is dL/dz?', options: ['−0.1', '−2.5', '0.3', '−0.7'], correct: 0, explanation: 'Multiply the gradient from above by the local derivative: −0.5 × 0.2 = −0.1.' },
  { id: 'q-bp-3', concept: 'cpt-backprop', type: 'mcq', difficulty: 0.6, stem: 'Why can gradients vanish in very deep networks with sigmoid activations?', options: ['Sigmoid outputs are always negative', 'The product of many derivatives smaller than 1 shrinks towards 0', 'The loss becomes undefined', 'Biases cancel the weights'], correct: 1, explanation: 'σ′(z) ≤ 0.25, so multiplying many of them makes the gradient tiny for early layers.' },
  { id: 'q-bp-4', concept: 'cpt-backprop', type: 'mcq', difficulty: 0.4, stem: 'When is the backward pass computed?', options: ['Before the forward pass', 'At the same time as the forward pass', 'After the forward pass has produced a loss', 'Only at the end of training'], correct: 2, explanation: 'You need the loss (and the cached activations) from the forward pass before you can propagate gradients back.' },
  { id: 'q-bp-5', concept: 'cpt-backprop', type: 'short', difficulty: 0.6, stem: 'In your own words, explain why backpropagation goes from the output layer towards the input.', explanation: 'Each layer’s gradient depends on the gradient of the layers after it, so we start where the loss is defined and move backwards, reusing results.', rubric: { criteria: [ { id: 'c1', description: 'Mentions the chain rule / dependence on later layers', points: 2 }, { id: 'c2', description: 'Explains reuse of computed gradients (efficiency)', points: 1 }, { id: 'c3', description: 'Notes the loss is defined at the output', points: 1 } ], modelAnswer: 'The loss is computed at the output, and by the chain rule each layer’s gradient is the gradient from the layer above times its local derivative, so we start at the output and reuse each result as we move back.' } },
  // Attention
  { id: 'q-at-1', concept: 'cpt-attn', lesson: 'les-attention', type: 'mcq', difficulty: 0.5, diagnostic: true, stem: 'Why are attention scores divided by √dₖ?', options: ['To make the model faster', 'To keep the scores’ variance near 1 so softmax doesn’t saturate', 'To normalise the values V', 'To make the weights sum to 1'], correct: 1, explanation: 'A dot product of dₖ unit-variance terms has variance dₖ. Dividing by √dₖ restores variance 1, keeping softmax smooth and gradients healthy.' },
  { id: 'q-at-2', concept: 'cpt-attn', lesson: 'les-attention', type: 'mcq', difficulty: 0.4, stem: 'Each row of the attention weight matrix…', options: ['sums to 1', 'sums to dₖ', 'contains only 0s and 1s', 'is identical for every token'], correct: 0, explanation: 'Softmax is applied row by row, so each token’s weights over all tokens form a probability distribution summing to 1.' },
  { id: 'q-at-3', concept: 'cpt-attn', type: 'mcq', difficulty: 0.6, stem: 'In self-attention, which vectors are compared to compute the scores?', options: ['Values with values', 'Queries with keys', 'Keys with values', 'Queries with values'], correct: 1, explanation: 'Scores come from query–key dot products; the resulting weights then mix the values.' },
  { id: 'q-at-4', concept: 'cpt-attn', type: 'short', difficulty: 0.5, stem: 'Describe what the output of attention is for one token.', explanation: 'It is a weighted average of all value vectors, where the weights come from the softmax of that token’s query–key scores.', rubric: { criteria: [ { id: 'c1', description: 'Weighted average / mix of value vectors', points: 2 }, { id: 'c2', description: 'Weights from softmax of query–key scores', points: 2 } ], modelAnswer: 'A weighted average of the value vectors, weighted by the softmax of the token’s query dotted with every key.' } },
  // Gradient descent
  { id: 'q-gd-1', concept: 'cpt-gd', type: 'mcq', difficulty: 0.3, diagnostic: true, stem: 'With L(θ) = θ², θ = 3 and learning rate 0.1, what is θ after one gradient descent step?', options: ['2.4', '2.7', '3.6', '0.6'], correct: 0, explanation: 'The gradient is 2θ = 6, so θ ← 3 − 0.1 × 6 = 2.4.' },
  { id: 'q-gd-2', concept: 'cpt-gd', type: 'mcq', difficulty: 0.5, stem: 'What usually happens if the learning rate is far too large?', options: ['Training becomes very slow', 'The loss may oscillate or diverge', 'The model overfits immediately', 'Nothing changes'], correct: 1, explanation: 'Big steps overshoot the minimum, so the loss bounces around or grows.' },
  { id: 'q-gd-3', concept: 'cpt-gd', type: 'mcq', difficulty: 0.4, stem: 'Mini-batch gradient descent computes each update from…', options: ['one example', 'a small random subset of examples', 'the whole dataset', 'the validation set'], correct: 1, explanation: 'Mini-batches balance the noise of SGD with the cost of full-batch updates.' },
  // Embeddings
  { id: 'q-emb-1', concept: 'cpt-emb', type: 'mcq', difficulty: 0.4, diagnostic: true, stem: 'Two word embeddings have cosine similarity 0.95. What does that suggest?', options: ['The words are used in very similar contexts', 'The words are spelled similarly', 'One word is twice as frequent', 'Nothing — cosine ignores direction'], correct: 0, explanation: 'Cosine measures the angle between vectors; a value near 1 means they point the same way, i.e. similar usage.' },
  { id: 'q-emb-2', concept: 'cpt-emb', type: 'mcq', difficulty: 0.5, stem: 'Why are embeddings dense rather than one-hot?', options: ['They use less memory and capture similarity', 'They are easier to read', 'They avoid needing training', 'They guarantee unique words'], correct: 0, explanation: 'Dense vectors are compact and let similar items share structure; one-hot vectors are all equally far apart.' },
  // Softmax
  { id: 'q-sm-1', concept: 'cpt-softmax', type: 'mcq', difficulty: 0.4, diagnostic: true, stem: 'What happens to softmax outputs if every input score is multiplied by 10?', options: ['They stay the same', 'They become closer to one-hot', 'They become uniform', 'They no longer sum to 1'], correct: 1, explanation: 'Scaling scores up exaggerates differences, pushing probability mass onto the largest score.' },
  { id: 'q-sm-2', concept: 'cpt-softmax', type: 'mcq', difficulty: 0.5, stem: 'Why subtract the maximum score before exponentiating in softmax?', options: ['To change the result', 'For numerical stability — it avoids overflow without changing the output', 'To make all outputs negative', 'To speed up training'], correct: 1, explanation: 'Softmax is shift-invariant, so subtracting the max keeps exponentials small without changing probabilities.' },
  // Loss
  { id: 'q-loss-1', concept: 'cpt-loss', type: 'mcq', difficulty: 0.3, diagnostic: true, stem: 'Which loss is usually used for multi-class classification?', options: ['Mean squared error', 'Cross-entropy', 'Hinge loss only', 'Absolute error'], correct: 1, explanation: 'Cross-entropy compares the predicted distribution with the true class and gives well-behaved gradients with softmax.' },
  { id: 'q-loss-2', concept: 'cpt-loss', type: 'mcq', difficulty: 0.5, stem: 'A model predicts p = 0.9 for the true class. What is the cross-entropy loss?', options: ['≈ 0.105', '≈ 0.9', '≈ 2.30', '0'], correct: 0, explanation: '−ln(0.9) ≈ 0.105.' },
  // Transformers
  { id: 'q-tr-1', concept: 'cpt-transformer', type: 'mcq', difficulty: 0.5, diagnostic: true, stem: 'Why does a Transformer need positional encoding?', options: ['Attention by itself ignores token order', 'To reduce the number of parameters', 'To replace the feed-forward layer', 'To normalise activations'], correct: 0, explanation: 'Self-attention treats its input as a set; positional information tells it where each token is.' },
  { id: 'q-tr-2', concept: 'cpt-transformer', type: 'mcq', difficulty: 0.6, stem: 'What do residual connections in a Transformer block help with?', options: ['Making gradients flow through deep stacks', 'Removing the need for attention', 'Encoding position', 'Tokenising text'], correct: 0, explanation: 'Adding the input back to each sub-layer’s output gives gradients a direct path, which makes deep stacks trainable.' },
  // RAG
  { id: 'q-rag-1', concept: 'cpt-rag', type: 'mcq', difficulty: 0.5, diagnostic: true, stem: 'In Reciprocal Rank Fusion with k = 60, a passage ranked 1st by vector search and 3rd by keyword search scores…', options: ['1/61 + 1/63', '1/60 + 1/180', '1 + 3', '61 × 63'], correct: 0, explanation: 'RRF sums 1/(k + rank) across rankers: 1/61 + 1/63 ≈ 0.0323.' },
  { id: 'q-rag-2', concept: 'cpt-rag', type: 'mcq', difficulty: 0.4, stem: 'Why does a RAG system check citations after generation?', options: ['To make answers longer', 'To drop markers that don’t match a supplied source', 'To translate the answer', 'To pick the model'], correct: 1, explanation: 'Models can invent markers; the citation check keeps only those that point at sources that were actually provided.' },
];

export const DEMO_DOCS_TEXT = {
  lecture3: 'Lecture 3 notes.pdf',
  cheatsheet: 'Backprop cheatsheet.md',
  scanned: 'Scanned handout.pdf',
};
