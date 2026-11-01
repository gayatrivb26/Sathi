# Backprop cheatsheet (my notes)

Notes I made while revising for the neural nets quiz. Mostly from the lesson plus the example I worked through twice because I kept messing up the order.

## The one-sentence version

Forward pass computes values and **saves them**. Backward pass starts at the loss and goes **from the output backward**, and every layer takes the gradient coming from above and **multiplies it by its own local derivative**, then hands the result to the layer before it.

That's it. Everything else is bookkeeping.

## Chain rule reminder

If $x \to u \to v \to L$ then

$$\frac{dL}{dx} = \frac{dL}{dv} \cdot \frac{dv}{du} \cdot \frac{du}{dx}$$

Each factor = "local derivative" = how one step's output changes with its own input. A layer only needs to know its own local derivative, nothing about the rest of the network.

## Local derivatives I keep needing

| operation | output | local derivative(s) |
|---|---|---|
| multiply | $y = w \cdot h$ | $\partial y/\partial w = h$, $\partial y/\partial h = w$ |
| add | $y = a + b$ | $1$ and $1$ (add just passes the gradient through) |
| ReLU | $h = \max(0, z)$ | $1$ if $z > 0$, else $0$ |
| sigmoid | $s = \sigma(z)$ | $s(1 - s)$, max $0.25$ |
| squared error | $L = (\hat y - y)^2$ | $2(\hat y - y)$ |

Trick: for multiply, the derivative w.r.t. one input is **the other input**. That's why we need to cache the forward values.

## My worked example (do this one in the exam if stuck)

Network: $z = w_1 x$, $h = \text{ReLU}(z)$, $\hat y = w_2 h$, $L = (\hat y - y)^2$

Numbers: $x = 2$, $y = 1$, $w_1 = 0.5$, $w_2 = 3$

**Forward:** $z = 1$, $h = 1$, $\hat y = 3$, $L = (3-1)^2 = 4$

**Backward** (start at the loss!):

1. $\partial L/\partial \hat y = 2(3 - 1) = 4$
2. $\partial L/\partial w_2 = 4 \times h = 4 \times 1 = 4$
3. $\partial L/\partial h = 4 \times w_2 = 4 \times 3 = 12$
4. ReLU: $z = 1 > 0$ so local derivative is 1, so $\partial L/\partial z = 12$
5. $\partial L/\partial w_1 = 12 \times x = 12 \times 2 = 24$

**Update** with $\eta = 0.01$: $w_2 = 3 - 0.04 = 2.96$, $w_1 = 0.5 - 0.24 = 0.26$

New loss is about $0.29$ (was 4). It works!!

Mistake I made the first time: I stopped at step 4 and said $\partial L/\partial w_1 = 12$. Forgot to multiply by $x$. **Every step multiplies by one more local derivative.**

## Things that confused me

- **Backprop vs gradient descent.** Backprop *computes* the gradients. Gradient descent / Adam *uses* them to update the weights. Different jobs.
- **Fan-out.** If one value is used in two places, the gradients from both paths get **added**. This is why PyTorch "accumulates" into `.grad` and why you need `optimizer.zero_grad()` every step.
- **Don't update in the middle.** Compute every gradient with the current weights first, then update. Otherwise the earlier layers get gradients from the wrong weights.
- **Memory.** Training uses way more memory than inference because the activations are cached for the backward pass.

## Vanishing / exploding gradients

The gradient reaching layer 1 is a **product** of lots of local derivatives.

- Sigmoid derivative is at most 0.25, so after 10 layers: $0.25^{10} \approx 9.5 \times 10^{-7}$. Basically nothing. = vanishing gradients
- Big weights can make the product blow up = exploding gradients (fix: gradient clipping)
- Fixes: ReLU (derivative 1 on the active side), good init (He init), normalisation layers, residual connections ($x + f(x)$ has derivative $1 + f'(x)$, so there's always a path for the gradient)

## Debugging checklist

- `.grad` is `None` → that parameter isn't on the path to the loss (or `requires_grad=False`)
- gradient is exactly 0 → maybe a dead ReLU
- `NaN` → look for `log(0)` or divide by zero in the forward pass, or learning rate too high

## Quiz question to remember

> Which statement about the chain rule in backpropagation is correct?
> Answer: **each layer multiplies the incoming gradient by its local derivative.** NOT "gradients are computed from the input forward".
