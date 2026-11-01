# What a model learns: loss functions

## The big idea

As a software developer you are used to writing the rules yourself: given an input, your code computes an output. Machine learning flips this around. You supply many examples of inputs together with the outputs you want, and a training procedure searches for the rules. The "rules" are numbers called **parameters** (or weights), and the model is a function $f_\theta(x)$ whose behaviour depends on those parameters $\theta$.

To search for good parameters, the training procedure needs a way to say how wrong the model currently is. That is the job of the **loss function**. A loss function takes the model's prediction $\hat{y}$ and the correct answer $y$ and returns a single non-negative number. Small means "close to right", large means "badly wrong". Training is nothing more than adjusting $\theta$ to make the average loss over the training data as small as possible:

$$\theta^* = \arg\min_\theta \frac{1}{N} \sum_{i=1}^{N} L\big(f_\theta(x_i), y_i\big)$$

So when people ask "what does a model learn?", the honest answer is: whatever makes the loss small. If the loss rewards the wrong thing, the model will faithfully learn the wrong thing. Choosing the loss is a design decision, much like choosing what your tests assert.

## Losses for regression: MSE and MAE

When the target is a number (a house price, a delivery time), the two classic choices are:

- **Mean squared error (MSE)**: $\text{MSE} = \frac{1}{N}\sum_i (y_i - \hat{y}_i)^2$
- **Mean absolute error (MAE)**: $\text{MAE} = \frac{1}{N}\sum_i |y_i - \hat{y}_i|$

Squaring punishes large errors much more than small ones. An error of 2 costs 4, but an error of 10 costs 100. That makes MSE sensitive to outliers: a single wildly wrong label can dominate training. MAE grows linearly, so it is more robust to outliers, but its gradient has the same size whether the error is tiny or huge, which can make the final approach to the minimum less smooth.

There is also a statistical reading. Minimising MSE makes the model predict the **mean** of the plausible targets for an input; minimising MAE makes it predict the **median**. If your data has heavy tails, that difference matters.

## Worked example: computing MSE and MAE

Suppose we have three examples with targets $y = [3, 5, 2]$ and the model predicts $\hat{y} = [2.5, 5, 4]$.

The errors $y - \hat{y}$ are $[0.5,\ 0,\ -2]$.

For MSE we square them: $[0.25,\ 0,\ 4]$. The sum is $4.25$, and the mean is

$$\text{MSE} = \frac{4.25}{3} \approx 1.417$$

For MAE we take absolute values: $[0.5,\ 0,\ 2]$. The sum is $2.5$, so

$$\text{MAE} = \frac{2.5}{3} \approx 0.833$$

Notice that the third example contributes $4/4.25 \approx 94\%$ of the MSE but only $2/2.5 = 80\%$ of the MAE. Squaring concentrates attention on the worst mistake.

## Losses for classification: cross-entropy

When the target is a category (spam or not spam, which of 10 digits), the model usually outputs a probability for each class. The standard loss is **cross-entropy**, also called log loss. If the model assigns probability $p_{\text{true}}$ to the correct class, the loss for that example is

$$L = -\ln p_{\text{true}}$$

For binary classification with label $y \in \{0, 1\}$ and predicted probability $p$ of class 1, this becomes binary cross-entropy:

$$L = -\big[y \ln p + (1 - y)\ln(1 - p)\big]$$

The numbers tell the story:

- If the model gives the correct class probability $0.7$, the loss is $-\ln 0.7 \approx 0.357$.
- If it gives $0.99$, the loss is $-\ln 0.99 \approx 0.010$.
- If it gives only $0.1$, the loss is $-\ln 0.1 \approx 2.303$.
- As $p_{\text{true}} \to 0$, the loss goes to infinity.

Cross-entropy therefore punishes **confident wrong answers** very hard, which is exactly what we want from a classifier. It also has a useful sanity check: a model that guesses uniformly over $C$ classes has loss $\ln C$. For 10 classes that is $\ln 10 \approx 2.303$, so if your untrained classifier starts far above that, something is off.

Why not use accuracy as the loss? Accuracy only changes when a prediction crosses the decision threshold, so it is flat almost everywhere. A flat function gives the optimiser no signal about which direction to move. Cross-entropy changes smoothly as probabilities shift, so it always provides a direction to improve.

## Loss, metric and objective are different things

Three words get mixed up constantly:

- The **loss** is what the optimiser minimises. It must be differentiable (or close to it).
- The **metric** is what you report and care about: accuracy, F1, Recall@k, revenue. It does not need to be differentiable.
- The **objective** is the total quantity minimised, which is often the average loss plus extra terms such as a regularisation penalty (covered in a later lesson).

A good loss is a smooth proxy that moves in the same direction as your metric. When they disagree — for example, you minimise cross-entropy but the business cares about recall on a rare class — you may need to weight the classes or change the threshold after training.

## Common mistakes

- **Using MSE for classification.** It works poorly with probabilities and gives weak gradients when the model is confidently wrong. Use cross-entropy.
- **Computing $\ln 0$.** If a probability is exactly zero you get infinity or `NaN`. Libraries avoid this by working with logits (`log_softmax`, `BCEWithLogitsLoss`); prefer those over hand-rolled formulas.
- **Treating low training loss as success.** A low loss on training data says nothing about new data. Always check a held-out validation set.
- **Ignoring outliers.** A few mislabelled points can dominate MSE. Inspect your largest errors before blaming the model.

## Check yourself

1. Targets are $[1, 4]$ and predictions are $[2, 2]$. What are the MSE and the MAE? (Answer: MSE $= (1 + 4)/2 = 2.5$, MAE $= (1 + 2)/2 = 1.5$.)
2. A classifier gives the correct class probability $0.5$. What is its cross-entropy loss, and would it go up or down if the probability rose to $0.8$?
3. Why is accuracy a poor choice of training loss even though it is often the metric we report?
