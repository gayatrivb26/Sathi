# Evaluating retrieval and citations

## You cannot improve what you do not measure

A RAG system has many moving parts: chunk size, embedding model, index settings, fusion, prompt wording, the model itself. Change any of them and quality can quietly go up or down. Reading a handful of answers and deciding they "look good" does not catch regressions, and it does not tell you **which** part broke. Evaluation turns quality into numbers you can track on every change, the same way unit tests turn correctness into a pass/fail signal.

It helps to evaluate the two halves separately:

- **Retrieval**: did the right passages reach the prompt?
- **Generation**: given those passages, is the answer correct, grounded and properly cited?

## Golden datasets

Both need a **golden dataset**: a fixed set of realistic questions, each labelled with what a correct system should do. For retrieval, each question lists the chunks, sections or lessons that contain the answer. For generation, it lists key facts the answer must include, or a reference answer.

Good golden sets include easy and hard questions, paraphrases, student-style phrasing with typos, questions that need two passages, and questions the corpus **cannot** answer (to test the "not covered" path). Fifty well-chosen cases catch far more problems than none, and they grow over time: every bug report becomes a new case.

## Retrieval metrics

Let the system return a ranked list of results for each query.

**Hit rate@k**: the fraction of queries with at least one relevant result in the top $k$. Simple and intuitive.

**Recall@k**: for one query, the fraction of all relevant items that appear in the top $k$. If a question has $3$ relevant chunks and $2$ appear in the top $5$, Recall@5 $= 2/3 \approx 0.667$.

**Precision@k**: the fraction of the top $k$ that is relevant. In the same example, Precision@5 $= 2/5 = 0.4$.

**MRR (mean reciprocal rank)**: for each query, take $1/\text{rank}$ of the **first** relevant result (or $0$ if none), then average across queries. It rewards putting a good result at the top.

**nDCG@k (normalised discounted cumulative gain)**: rewards relevant results more the higher they appear, with a logarithmic discount, and divides by the best possible score so the result is between $0$ and $1$:

$$\text{DCG@}k = \sum_{i=1}^{k} \frac{\text{rel}_i}{\log_2(i + 1)}, \qquad \text{nDCG@}k = \frac{\text{DCG@}k}{\text{IDCG@}k}$$

## Worked example: MRR and nDCG

**MRR.** Four test queries have their first relevant result at ranks $1$, $3$, none, and $2$. The reciprocal ranks are $1$, $1/3$, $0$, $1/2$, so

$$\text{MRR} = \frac{1 + 0.333 + 0 + 0.5}{4} = \frac{1.833}{4} \approx 0.458$$

**nDCG@3.** One query's top three results are relevant, not relevant, relevant (binary relevance $1, 0, 1$).

$$\text{DCG@3} = \frac{1}{\log_2 2} + \frac{0}{\log_2 3} + \frac{1}{\log_2 4} = 1 + 0 + 0.5 = 1.5$$

The ideal order puts both relevant results first: $1, 1, 0$, so $\text{IDCG@3} = 1 + \frac{1}{\log_2 3} = 1 + 0.631 = 1.631$. Therefore

$$\text{nDCG@3} = \frac{1.5}{1.631} \approx 0.920$$

Swapping the second and third results would give a perfect $1.0$.

## Evaluating answers and citations

Retrieval metrics do not tell you whether the answer is any good. For generation, check:

- **Correctness**: does the answer contain the key facts? Simple checks look for required phrases; better checks use a rubric.
- **Groundedness (faithfulness)**: is every claim supported by the retrieved passages? An answer can be correct but ungrounded, if the model used its own memory, which still matters because it cannot be cited.
- **Citation validity**: every cited ID must exist in the set of passages actually shown to the model. A citation to a passage that was never retrieved is fabricated, and the system should strip it or flag the answer.
- **Citation support**: the cited passage should actually support the sentence it is attached to.
- **Refusal behaviour**: for out-of-scope questions, the system should say the material does not cover it rather than invent an answer.
- **Injection resistance**: when a retrieved passage contains hostile instructions, the answer must not follow them.

## LLM-as-judge, carefully

Many of these checks are too nuanced for string matching, so teams use a language model as a **judge**: give it the question, the passages, the answer and a rubric, and ask for a score with a short justification. Judges are useful but biased: they can favour longer answers, be swayed by confident tone, and disagree with humans on edge cases.

Treat the judge like any other model: **calibrate** it. Have humans score a set of answers with the same rubric, then measure how often the judge agrees, for example the exact-agreement rate or a correlation between judge and human scores. Only trust the judge for decisions where its agreement with humans is high, and re-check whenever you change the judge prompt or model.

## Worked example: is the change real?

Your system passes $40$ of $50$ golden cases, a pass rate of $p = 0.8$. How precise is that number? The standard error of a proportion is

$$\text{SE} = \sqrt{\frac{p(1 - p)}{n}} = \sqrt{\frac{0.8 \times 0.2}{50}} = \sqrt{0.0032} \approx 0.057$$

A rough $95\%$ confidence interval is $0.8 \pm 1.96 \times 0.057 \approx 0.8 \pm 0.111$, or about $[0.69, 0.91]$. If a prompt tweak moves you from $40$ to $42$ passes, that is well within the noise. Small datasets can catch big regressions, but they cannot prove small improvements. Comparing two systems **on the same cases**, and counting where they disagree, is more sensitive than comparing two separate pass rates.

## Common mistakes

- **Only evaluating end-to-end.** When the score drops, you will not know whether retrieval or generation broke.
- **Tuning on the golden set until it is perfect.** It stops representing real users; keep a held-out portion.
- **Trusting an uncalibrated judge.** Validate it against human labels first.
- **Ignoring confidence intervals.** A two-point change on 50 cases is usually noise.

## Check yourself

1. Three queries have their first relevant result at ranks $2$, $1$ and $4$. What is the MRR? (Answer: $(0.5 + 1 + 0.25)/3 \approx 0.583$.)
2. What is the difference between a correct answer and a grounded answer?
3. Why should an LLM judge be compared with human scores before you rely on it?
