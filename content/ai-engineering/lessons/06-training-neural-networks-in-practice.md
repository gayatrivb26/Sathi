# Training neural networks in practice

## From algorithm to working training run

You now know the three core pieces: a loss that measures error, backpropagation that computes gradients, and gradient descent that uses them. Real training runs add a layer of engineering on top. Most failed experiments do not fail because the maths is wrong; they fail because of a bad learning rate, an unnormalised input, a bug in the data pipeline, or a missing `zero_grad()`. This lesson is the practical checklist.

## The training loop

Almost every training script has the same shape:

```python
for epoch in range(num_epochs):
    model.train()
    for x, y in train_loader:          # mini-batches
        optimizer.zero_grad()          # clear old gradients
        loss = loss_fn(model(x), y)    # forward pass
        loss.backward()                # backward pass
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()               # update weights
    model.eval()
    evaluate(model, val_loader)        # no gradients, no dropout
```

Each line maps to a concept you have met: mini-batch gradient descent, backpropagation, an optimiser, and a validation check for overfitting.

## Worked example: steps, epochs and budgets

You have $50{,}000$ training examples and a batch size of $128$. How many optimiser steps is one epoch?

$$\frac{50{,}000}{128} = 390.625 \;\Rightarrow\; 391 \text{ steps (the last batch is partial)}$$

Ten epochs is therefore $3{,}910$ steps. If each step takes $40$ ms, ten epochs take $3{,}910 \times 0.04 = 156.4$ seconds, about two and a half minutes. Doing this arithmetic before you start tells you whether an experiment fits your time budget and how often to log or evaluate.

Batch size interacts with the learning rate. Larger batches give less noisy gradients, so they often tolerate a larger learning rate; a common heuristic is to scale the learning rate roughly in proportion to the batch size, then verify empirically.

## Initialisation

Weights cannot start at zero: every neuron in a layer would compute the same thing and receive the same gradient, so they would stay identical forever. They are initialised randomly, with a scale chosen so activations neither blow up nor shrink as they pass through layers.

For ReLU networks, **He initialisation** draws weights with variance $2 / n_{\text{in}}$, where $n_{\text{in}}$ is the number of inputs to the layer. For a layer with $512$ inputs, the standard deviation is $\sqrt{2/512} = \sqrt{0.00390625} = 0.0625$. Frameworks apply sensible defaults, but if you build custom layers it matters.

## Learning-rate schedules and Adam

A fixed learning rate is rarely best. Common schedules:

- **Warmup**: increase the learning rate linearly from near zero over the first few hundred or thousand steps. This avoids large, destabilising updates while Adam's statistics are still unreliable. Transformers almost always use it.
- **Decay**: reduce the learning rate later in training (step decay, linear decay, or cosine decay) so the model can settle into a minimum.

**Adam** is the default optimiser for most deep learning. A small calculation shows why its first steps are well behaved. With $\beta_1 = 0.9$, $\beta_2 = 0.999$ and a first gradient $g = 0.2$:

- $m = 0.1 \times 0.2 = 0.02$, bias-corrected $\hat{m} = 0.02 / (1 - 0.9) = 0.2$
- $v = 0.001 \times 0.2^2 = 0.00004$, bias-corrected $\hat{v} = 0.00004 / (1 - 0.999) = 0.04$
- step $= \eta \cdot \hat{m} / (\sqrt{\hat{v}} + \epsilon) = \eta \times 0.2 / 0.2 \approx \eta$

So the first step moves each parameter by about $\eta$ regardless of the raw gradient's scale. **AdamW** applies weight decay separately from the gradient-based update and is the usual choice for Transformers.

## Normalisation and gradient clipping

**Normalising inputs** (zero mean, unit variance per feature, using statistics from the training set only) keeps gradients comparable across features.

**Normalisation layers** do the same inside the network. Batch normalisation normalises each feature across the batch; layer normalisation normalises across the features of each example and is what Transformers use. Both make training faster and less sensitive to the learning rate.

**Gradient clipping** caps the size of the gradient vector before the update. If the gradient is $g = [3, 4]$ its norm is $\sqrt{9 + 16} = 5$. With a maximum norm of $1$, clipping rescales it by $1/5$ to $[0.6, 0.8]$: same direction, bounded size. This protects against occasional exploding gradients, which are common in recurrent networks and long Transformer runs.

## Debugging a training run

When a model does not learn, work through these checks in order:

1. **Check the starting loss.** For $C$-class classification, an untrained model should start near $\ln C$ (for 10 classes, about $2.30$). A much higher value suggests a bug in the labels or the output layer.
2. **Overfit a tiny batch.** Train on 10–50 examples. A correct model and pipeline should drive training loss close to zero. If it cannot, the bug is in the code, not the data size.
3. **Inspect the data.** Print a few batches after all preprocessing. Mismatched inputs and labels are depressingly common.
4. **Watch the loss curve.** A loss that becomes `NaN` usually means the learning rate is too high or there is a numerical problem; a flat loss can mean the learning rate is too low or gradients are not flowing.
5. **Track gradient norms.** Zero norms for a layer mean it is disconnected or dead; huge norms mean instability.

## Common mistakes

- **Calling `optimizer.step()` without `zero_grad()`.** Gradients accumulate across steps and updates become wrong.
- **Evaluating in training mode.** Dropout and batch-norm behave differently; always switch to evaluation mode.
- **Computing normalisation statistics on all data.** That leaks validation information into training.
- **Changing many things at once.** Change one hyperparameter at a time and log every run so results are comparable.

## Check yourself

1. With $12{,}000$ examples and a batch size of $64$, how many steps make one epoch? (Answer: $12{,}000 / 64 = 187.5$, so $188$ steps.)
2. A gradient $[6, 8]$ is clipped to a maximum norm of $2$. What is the clipped gradient? (Answer: the norm is $10$, so scale by $0.2$ to get $[1.2, 1.6]$.)
3. Why is "overfit a tiny batch" a useful first debugging step?
