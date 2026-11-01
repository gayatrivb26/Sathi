# Gradient descent

## From "how wrong" to "which way"

The previous lesson gave us a loss: one number that measures how wrong the model is. Now we need a way to change the parameters so that number goes down. A model can have millions or billions of parameters, so trying random changes is hopeless. Instead we ask a sharper question: if I nudge each parameter slightly, how does the loss respond?

The answer is the **gradient**, written $\nabla_\theta L$. It is a vector with one entry per parameter, and entry $j$ is the partial derivative $\partial L / \partial \theta_j$: the rate at which the loss changes when you increase $\theta_j$ a tiny bit. The gradient points in the direction of steepest **increase**. To decrease the loss we step the opposite way.

## The update rule

Gradient descent repeats one simple update:

$$\theta \leftarrow \theta - \eta \, \nabla_\theta L(\theta)$$

Here $\eta$ (eta) is the **learning rate**, a small positive number that controls the step size. That is the entire algorithm: compute the gradient, take a step downhill, repeat until the loss stops improving.

A useful mental picture is standing on a foggy hillside. You cannot see the valley, but you can feel the slope under your feet. Each step, you move a little in the steepest downhill direction. The learning rate is your stride length.

## Worked example: one parameter, three steps

Take the loss $L(w) = (w - 3)^2$. Its minimum is obviously at $w = 3$, which lets us check the algorithm. The derivative is

$$\frac{dL}{dw} = 2(w - 3)$$

Start at $w_0 = 0$ with learning rate $\eta = 0.1$.

**Step 1.** Gradient $= 2(0 - 3) = -6$. Update: $w_1 = 0 - 0.1 \times (-6) = 0.6$. Loss falls from $(0 - 3)^2 = 9$ to $(0.6 - 3)^2 = 5.76$.

**Step 2.** Gradient $= 2(0.6 - 3) = -4.8$. Update: $w_2 = 0.6 + 0.48 = 1.08$. Loss $= (1.08 - 3)^2 = 1.92^2 = 3.6864$.

**Step 3.** Gradient $= 2(1.08 - 3) = -3.84$. Update: $w_3 = 1.08 + 0.384 = 1.464$. Loss $= 1.536^2 \approx 2.359$.

Each step multiplies the distance to the minimum by $1 - 2\eta = 0.8$: the distance goes $3 \to 2.4 \to 1.92 \to 1.536$. Steps shrink automatically as the slope flattens near the bottom, even though $\eta$ is fixed.

Now try $\eta = 1.1$. The factor becomes $1 - 2.2 = -1.2$, so each step overshoots and lands **further** away on the other side: distance $3 \to 3.6 \to 4.32 \to \dots$. The loss explodes. With $\eta = 1.0$ the factor is exactly $-1$ and $w$ bounces between $0$ and $6$ forever. The learning rate is the single most important knob in training.

## A second example: fitting a line through one point

Consider a model $\hat{y} = w x$ with squared error $L = (wx - y)^2$. The gradient with respect to $w$ is $2(wx - y)\,x$.

Take one example $x = 2$, $y = 4$, and start at $w = 1$. The prediction is $2$, the loss is $(2 - 4)^2 = 4$, and the gradient is $2 \times (-2) \times 2 = -8$. With $\eta = 0.05$:

$$w \leftarrow 1 - 0.05 \times (-8) = 1.4$$

The new prediction is $2.8$ and the loss drops to $(2.8 - 4)^2 = 1.44$. Notice the gradient includes the input $x$: inputs with large magnitude produce large gradients. This is one reason we normalise features before training.

## Batch, stochastic and mini-batch

The true gradient is an average over the whole training set. Computing it exactly for every step is expensive when you have millions of examples. In practice we use variants:

- **Batch gradient descent** uses all $N$ examples per step. Accurate but slow.
- **Stochastic gradient descent (SGD)** uses one random example per step. Cheap and noisy.
- **Mini-batch gradient descent** uses a small random batch, typically 32 to 1024 examples. This is what everyone actually does, and it is usually still called "SGD".

The noise from mini-batches is not purely a nuisance. It helps the optimiser escape flat regions and shallow local minima, and it often leads to solutions that generalise better. One full pass over the training data is called an **epoch**.

## Better optimisers: momentum and Adam

Plain gradient descent struggles in long, narrow valleys: it zig-zags across the steep walls while making slow progress along the gentle floor. Two ideas fix most of this.

**Momentum** keeps a running average of past gradients, like a heavy ball rolling downhill. Consistent directions accumulate speed; oscillating directions cancel out.

**Adam** combines momentum with a per-parameter step size. It tracks a running average of gradients $m$ and of squared gradients $v$, then updates each parameter by roughly $\eta \cdot m / \sqrt{v}$. Parameters with consistently large gradients get smaller steps, and rarely updated parameters get relatively larger ones. Adam (and its variant AdamW) is the default choice for training neural networks, including Transformers.

None of these change the core idea. They are all "move against the gradient", with smarter bookkeeping about how far to move.

## Common mistakes

- **Flipping the sign.** The update subtracts the gradient. Adding it climbs the hill and the loss rises every step.
- **Picking the learning rate once and never revisiting it.** If the loss explodes or becomes `NaN`, reduce $\eta$ by 3–10×. If it barely moves, increase it.
- **Assuming gradient descent finds the global minimum.** For neural networks the loss surface is not convex. We find a good low point, not a guaranteed best one — and that is usually enough.
- **Forgetting to reset accumulated gradients.** In frameworks like PyTorch, gradients add up across `backward()` calls until you zero them.

## Check yourself

1. For $L(w) = (w - 3)^2$ starting at $w = 5$ with $\eta = 0.25$, what is $w$ after one step? (Answer: gradient $= 4$, so $w = 5 - 1 = 4$.)
2. Why does the step size shrink near a minimum even when the learning rate is constant?
3. What happens to training if the learning rate is far too large, and what symptom would you see in the loss curve?
