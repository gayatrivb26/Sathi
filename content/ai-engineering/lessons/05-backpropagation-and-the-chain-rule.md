# Backpropagation and the chain rule

## The problem backpropagation solves

Gradient descent needs $\partial L / \partial \theta$ for every parameter in the network. A modern model has millions of parameters, and the loss depends on early-layer weights only indirectly, through every later layer. Nudging each weight separately and re-running the network to measure the effect would cost one forward pass per parameter, which is far too slow.

**Backpropagation** computes all of those derivatives in roughly the cost of one extra pass through the network. It is not a new kind of calculus. It is the chain rule, applied systematically and in the right order, with careful reuse of intermediate results.

## The chain rule in one line

If $y$ depends on $u$, and $u$ depends on $x$, then

$$\frac{dy}{dx} = \frac{dy}{du} \cdot \frac{du}{dx}$$

For a longer chain $x \to u \to v \to L$, you just keep multiplying: $\frac{dL}{dx} = \frac{dL}{dv}\cdot\frac{dv}{du}\cdot\frac{du}{dx}$. Each factor is a **local derivative**: how one step's output responds to its own input, ignoring everything else in the network.

## Forward pass, then backward pass

Think of the network as a **computation graph**: each node is a simple operation (multiply, add, ReLU, square), and the edges carry values.

1. **Forward pass.** Feed the input through the graph from left to right, computing each node's output and **caching** the values you will need later.
2. **Backward pass.** Start at the loss, where $\partial L / \partial L = 1$, and move from the output **backward** towards the input. At each node, take the gradient arriving from above — the gradient of the loss with respect to this node's output — and **multiply it by the node's local derivative** to get the gradient with respect to the node's inputs. Pass that result further back.

That second step is the heart of the algorithm. Every layer does the same small job: receive the gradient from the layer above, multiply it by its own local derivative, and pass the result back to the layer before it (towards the input). No layer needs to know anything about the rest of the network.

When a value feeds into several later nodes (fan-out), the gradients coming back along each path are **added**. This follows from the multivariable chain rule and is why frameworks "accumulate" gradients.

## Worked example: a two-layer network by hand

Take a tiny network with one input, one hidden unit and squared-error loss:

$$z = w_1 x, \quad h = \text{ReLU}(z), \quad \hat{y} = w_2 h, \quad L = (\hat{y} - y)^2$$

Let $x = 2$, $y = 1$, $w_1 = 0.5$, $w_2 = 3$.

**Forward pass.**

- $z = 0.5 \times 2 = 1$
- $h = \text{ReLU}(1) = 1$
- $\hat{y} = 3 \times 1 = 3$
- $L = (3 - 1)^2 = 4$

**Backward pass**, from the output back to the input:

- At the loss: $\dfrac{\partial L}{\partial \hat{y}} = 2(\hat{y} - y) = 2 \times 2 = 4$.
- Through $\hat{y} = w_2 h$. Local derivatives are $\partial \hat{y}/\partial w_2 = h = 1$ and $\partial \hat{y}/\partial h = w_2 = 3$. Multiply the incoming gradient $4$ by each:
  - $\dfrac{\partial L}{\partial w_2} = 4 \times 1 = 4$
  - $\dfrac{\partial L}{\partial h} = 4 \times 3 = 12$
- Through the ReLU. Its local derivative is $1$ because $z = 1 > 0$. So $\dfrac{\partial L}{\partial z} = 12 \times 1 = 12$.
- Through $z = w_1 x$. The local derivative with respect to $w_1$ is $x = 2$. So $\dfrac{\partial L}{\partial w_1} = 12 \times 2 = 24$.

**Update** with learning rate $\eta = 0.01$:

- $w_2 \leftarrow 3 - 0.01 \times 4 = 2.96$
- $w_1 \leftarrow 0.5 - 0.01 \times 24 = 0.26$

**Check.** Re-run the forward pass: $z = 0.26 \times 2 = 0.52$, $h = 0.52$, $\hat{y} = 2.96 \times 0.52 = 1.5392$, and $L = 0.5392^2 \approx 0.291$. One step took the loss from $4$ to about $0.29$, and the prediction moved from $3$ to about $1.54$, towards the target of $1$. With a much larger learning rate the prediction could overshoot below the target and the loss could rise instead.

Notice what was reused: $\partial L/\partial h = 12$ was computed once and then used to get $\partial L/\partial w_1$. In a deep network, every layer's gradient is built from the one above it, so the total work is proportional to the size of the network rather than to the number of parameters times the size of the network.

## Why this explains vanishing and exploding gradients

Because the gradient reaching an early layer is a **product** of many local derivatives, its size depends on whether those factors are typically below or above one. Sigmoid derivatives are at most $0.25$, so products shrink towards zero (vanishing gradients). Large weight matrices can make products grow without bound (exploding gradients). ReLU activations, careful initialisation, normalisation layers and residual connections all exist largely to keep this product well behaved.

## What frameworks do for you

PyTorch, JAX and TensorFlow implement **automatic differentiation**. During the forward pass they record the computation graph; calling `loss.backward()` walks it in reverse, applying each operation's local derivative rule. You rarely write backward passes yourself, but understanding them helps you debug: a `None` gradient means the parameter was not on the path to the loss, a `NaN` gradient often traces back to a `log(0)` or a division by zero in the forward pass, and memory usage during training is high because activations must be cached for the backward pass.

## Common mistakes

- **Thinking gradients flow forward.** Values flow forward; gradients flow backward, from the loss to the inputs.
- **Updating weights mid-backward pass.** Compute every gradient first using the current weights, then update. Updating early corrupts the gradients for layers further back.
- **Forgetting to zero gradients.** Frameworks add gradients into `.grad` across calls. Call `optimizer.zero_grad()` each step.
- **Confusing backpropagation with gradient descent.** Backpropagation computes gradients; the optimiser (SGD, Adam) uses them to update weights.

## Check yourself

1. In the worked example, what would $\partial L / \partial w_1$ be if $z$ had been negative? Why? (Answer: $0$, because the ReLU's local derivative would be $0$ and multiplying by it blocks the gradient.)
2. Describe in one sentence what each layer does during the backward pass.
3. Why is backpropagation far cheaper than estimating each parameter's gradient by nudging it and re-running the network?
