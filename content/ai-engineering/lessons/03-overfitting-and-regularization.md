# Overfitting and regularization

## Memorising versus learning

Imagine a test suite where every test hard-codes the expected output for one exact input. An implementation that is just a giant lookup table passes every test and is useless on any input the tests did not cover. A model can do the same thing. With enough parameters it can drive the training loss close to zero by memorising the training examples, noise and all, without capturing the pattern that would carry over to new data.

This is **overfitting**: excellent performance on the data the model was trained on, poor performance on data it has not seen. The opposite failure, **underfitting**, is when the model is too simple or too briefly trained to capture the pattern even on the training data.

What we actually want is **generalisation**: low loss on new examples drawn from the same distribution. Everything in this lesson is a tool for getting that.

## How to detect overfitting

You cannot detect overfitting from the training loss alone, because the training loss keeps going down when the model memorises. You need data the model never trains on:

- **Training set**: used to compute gradients and update weights.
- **Validation set**: used to choose hyperparameters and decide when to stop.
- **Test set**: touched once, at the end, to report an honest number.

Plot training loss and validation loss against training steps. Early on both fall. If the model starts to overfit, training loss keeps falling while validation loss flattens and then **rises**. The gap between them is the signal. For example, training loss $0.05$ with validation loss $0.90$ is a classic overfit, while training loss $0.85$ with validation loss $0.88$ suggests underfitting (both are high and close together).

A related trap is **data leakage**: information from the validation or test set sneaking into training, such as normalising features using statistics computed on the full dataset, or having near-duplicate documents in both splits. Leakage makes validation scores look better than reality.

## The bias–variance picture

A helpful way to think about the two failures:

- A model with high **bias** makes strong, wrong assumptions (a straight line through curved data). It underfits.
- A model with high **variance** is so flexible that small changes in the training data change it a lot. It overfits.

Adding capacity (more parameters, more layers) lowers bias and raises variance. Regularisation is any technique that reduces variance, usually by limiting how freely the model can use its capacity.

## L2 regularisation (weight decay)

The most common technique adds a penalty on large weights to the objective:

$$J(\theta) = \frac{1}{N}\sum_i L\big(f_\theta(x_i), y_i\big) + \lambda \sum_j \theta_j^2$$

The hyperparameter $\lambda$ sets how much we care about small weights compared with fitting the data. The intuition: a function built from small weights changes gently as the input changes, so it cannot contort itself to hit every noisy training point.

The gradient of the penalty $\lambda \theta_j^2$ is $2\lambda\theta_j$, so every update pulls each weight a little towards zero in proportion to its size. That is why L2 regularisation is also called **weight decay**.

## Worked example: computing penalties

Take weights $w = [3,\ -1,\ 0.5]$ and $\lambda = 0.1$.

**L2 penalty.** $\sum w_j^2 = 9 + 1 + 0.25 = 10.25$, so the penalty is $0.1 \times 10.25 = 1.025$. This is added to the data loss.

**L2 gradient step.** For the weight $w_1 = 3$, the penalty gradient is $2 \times 0.1 \times 3 = 0.6$. With learning rate $\eta = 0.1$, the penalty alone moves the weight by $-0.1 \times 0.6 = -0.06$, from $3$ to $2.94$. The weight $0.5$ moves only by $-0.01$. Large weights shrink fastest.

**L1 penalty.** The alternative uses absolute values: $\lambda \sum |w_j| = 0.1 \times (3 + 1 + 0.5) = 0.45$. Its gradient is $\lambda \cdot \text{sign}(w_j)$, a constant-size push regardless of magnitude, so small weights get pushed all the way to exactly zero. L1 therefore produces **sparse** models, which is handy for feature selection.

## Other regularisers you will meet

**Dropout.** During training, randomly set each hidden activation to zero with probability $p$ (often $0.1$ to $0.5$). The network cannot rely on any single unit, so it learns redundant, robust features. In the common "inverted dropout" implementation the surviving activations are multiplied by $1/(1-p)$ so their expected value is unchanged; with $p = 0.5$ that factor is $2$. At inference time dropout is switched off.

**Early stopping.** Keep a copy of the weights with the best validation loss and stop when validation loss has not improved for a set number of evaluations (the "patience"). It is cheap and effective.

**More data and data augmentation.** The most reliable cure for overfitting is more varied training data. When you cannot collect more, you can create plausible variants: crops and flips for images, paraphrases for text.

**Smaller models.** Reducing capacity is a blunt but valid option, especially when data is scarce.

## Common mistakes

- **Tuning hyperparameters on the test set.** Once you choose $\lambda$ by looking at test scores, the test set has become a validation set and your reported number is optimistic.
- **Leaving dropout on at inference.** Predictions become random and worse. In PyTorch, call `model.eval()` before evaluating.
- **Applying weight decay to everything blindly.** Biases and normalisation parameters are usually excluded from weight decay in modern training recipes.
- **Mistaking underfitting for overfitting.** If training and validation loss are both high, adding regularisation makes things worse; you need more capacity or more training.

## Check yourself

1. Training loss is $0.10$ and still falling; validation loss fell to $0.40$, and has since risen to $0.65$. What is happening and what would you do?
2. Compute the L2 penalty for $w = [2, -2]$ with $\lambda = 0.05$. (Answer: $0.05 \times (4 + 4) = 0.4$.)
3. Why does L1 regularisation tend to produce weights that are exactly zero, while L2 produces weights that are small but non-zero?
