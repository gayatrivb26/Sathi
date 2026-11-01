# Neurons and activation functions

## A neuron is a tiny function

Strip away the biology and an artificial neuron is a few lines of code. It takes an input vector $x$, computes a weighted sum plus a bias, and passes the result through a non-linear function $g$:

$$z = w \cdot x + b = \sum_j w_j x_j + b, \qquad a = g(z)$$

The weights $w$ and bias $b$ are learned parameters. The value $z$ is called the **pre-activation**, and $a$ is the **activation**, the neuron's output. A **layer** is many neurons side by side that share the same input, which we write compactly as a matrix multiplication: $a = g(Wx + b)$. A neural network stacks layers so that each layer's activations become the next layer's input.

## Why we need non-linearity

Suppose we left out $g$ and stacked two linear layers: $h = W_1 x$ and $y = W_2 h$. Substituting gives $y = W_2 W_1 x = W x$ with $W = W_2 W_1$. Two layers collapse into one. In fact any number of purely linear layers is equivalent to a single linear layer, which can only draw straight decision boundaries.

The activation function breaks this collapse. With a non-linearity between layers, a network can bend and fold its input space, and with enough units it can approximate essentially any continuous function. The activation is what makes depth worth having.

## The common activation functions

**Sigmoid.** $\sigma(z) = \dfrac{1}{1 + e^{-z}}$ squashes any real number into $(0, 1)$. Its derivative is $\sigma'(z) = \sigma(z)\,(1 - \sigma(z))$, which peaks at $0.25$ when $z = 0$. Sigmoid is still the right choice for the output of a binary classifier, where you want a probability.

**Tanh.** $\tanh(z)$ squashes into $(-1, 1)$ and is centred at zero, which usually trains better than sigmoid in hidden layers. Its derivative peaks at $1$ when $z = 0$.

**ReLU.** $\text{ReLU}(z) = \max(0, z)$. Its derivative is $1$ for $z > 0$ and $0$ for $z < 0$. It is cheap, it does not saturate for positive inputs, and it made training deep networks practical. It is the sensible default for many hidden layers.

**GELU and SiLU.** Smooth relatives of ReLU: $\text{GELU}(z) = z \cdot \Phi(z)$, where $\Phi$ is the standard normal CDF, and $\text{SiLU}(z) = z \cdot \sigma(z)$. They behave like ReLU for large positive $z$, like zero for large negative $z$, and curve smoothly in between. Most Transformers use GELU or a SiLU-based variant in their feed-forward layers.

**Softmax.** Used at the output layer for multi-class problems. It turns a vector of scores (logits) into probabilities that are positive and sum to one: $\text{softmax}(z)_i = e^{z_i} / \sum_j e^{z_j}$. You will meet it again inside attention.

## Worked example: one neuron, three activations

Let $x = [1, 2]$, $w = [0.5, -0.25]$ and $b = 0.1$.

$$z = 0.5 \times 1 + (-0.25) \times 2 + 0.1 = 0.5 - 0.5 + 0.1 = 0.1$$

- ReLU: $\max(0, 0.1) = 0.1$, with derivative $1$.
- Sigmoid: $\sigma(0.1) = 1 / (1 + e^{-0.1}) = 1 / 1.9048 \approx 0.525$, with derivative $0.525 \times 0.475 \approx 0.249$.
- Tanh: $\tanh(0.1) \approx 0.0997$, with derivative $1 - 0.0997^2 \approx 0.990$.

Now push the input further: if $z = 5$, then $\sigma(5) \approx 0.9933$ and its derivative is $0.9933 \times 0.0067 \approx 0.0066$. The neuron is **saturated**: changing $z$ barely changes the output, so almost no gradient flows back through it.

## Vanishing gradients

The previous number matters because training relies on gradients flowing backwards through every layer, and (as the backpropagation lesson shows) those gradients get multiplied by each layer's local derivative. With sigmoid, that local derivative is at most $0.25$. Through 10 sigmoid layers, even in the best case the gradient is scaled by

$$0.25^{10} = \frac{1}{1{,}048{,}576} \approx 9.5 \times 10^{-7}$$

The early layers receive almost no signal and stop learning. This **vanishing gradient** problem is the main reason ReLU-family activations replaced sigmoid and tanh in hidden layers. ReLU's derivative is exactly $1$ on the active side, so it passes gradients through unchanged.

ReLU has its own failure mode. If a neuron's pre-activation is negative for every input, its derivative is always $0$, its weights never update, and it is permanently off. This is a **dead ReLU**. High learning rates and poor initialisation make it more likely. Variants like Leaky ReLU, $\max(0.01z, z)$, keep a small slope on the negative side to avoid it.

## Choosing an activation

A practical rule of thumb:

- Hidden layers in MLPs and CNNs: ReLU (or Leaky ReLU if you see dead units).
- Transformer feed-forward layers: GELU or SiLU-based gated variants.
- Binary output: sigmoid, paired with binary cross-entropy.
- Multi-class output: softmax, paired with cross-entropy.
- Regression output: no activation (identity), so predictions can be any real number.

## Common mistakes

- **Applying softmax twice.** Many loss functions, such as PyTorch's `CrossEntropyLoss`, expect raw logits and apply log-softmax internally. Adding your own softmax first silently weakens training.
- **Using ReLU on a regression output.** The model can never predict a negative value.
- **Forgetting the activation entirely.** A "deep" network with no non-linearities is a linear model in disguise.
- **Ignoring saturation.** Huge inputs push sigmoid and tanh into flat regions. Normalise inputs and use sensible initialisation.

## Check yourself

1. Why do two stacked linear layers without an activation have no more expressive power than one?
2. Compute $z$ and $\text{ReLU}(z)$ for $x = [2, -1]$, $w = [1, 3]$, $b = 0.5$. (Answer: $z = 2 - 3 + 0.5 = -0.5$, so ReLU gives $0$.)
3. Why does the maximum sigmoid derivative of $0.25$ cause trouble in deep networks?
