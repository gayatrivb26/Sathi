# Why RAG: grounding answers

## What a language model actually knows

A large language model learns from a huge snapshot of text during pretraining. Its "knowledge" is spread across billions of weights, and it has three hard limits that matter for any real product:

- **It is frozen in time.** Nothing that happened after its training cutoff is in the weights.
- **It has never seen your private data.** Your course notes, internal wiki, or contracts were not in the training set.
- **It cannot show its sources.** Weights do not record where a fact came from, so the model cannot cite reliably, and when it does not know something it may produce a fluent, plausible, wrong answer. This is usually called **hallucination**.

For a tutor, a support bot, or any system where answers must be correct and checkable, those limits are deal-breakers.

## The idea of retrieval-augmented generation

**Retrieval-augmented generation (RAG)** gives the model the right material at question time instead of hoping it memorised it. The flow has two halves.

**Offline: indexing.**

1. **Parse** each source document into text, keeping metadata such as title, page and section.
2. **Chunk** the text into passages of a manageable size.
3. **Embed** each chunk into a vector and store it, together with a keyword index.

**Online: answering.**

1. **Retrieve** the chunks most relevant to the question, using vector search, keyword search, or both.
2. **Augment** the prompt: combine instructions, the question and the retrieved passages, each labelled with an ID.
3. **Generate** an answer that uses only those passages and **cites** the IDs it relied on.

The model's job changes from "recall the answer" to "read these passages and explain". Language models are much better at the second.

## Grounding and citations

An answer is **grounded** when every claim in it is supported by the provided sources. Grounding is enforced by a combination of prompt rules and checks:

- Instruct the model to answer only from the passages, and to say plainly when they do not contain the answer.
- Require a citation marker such as `[c3]` after each claim.
- After generation, **validate** the citations: every cited ID must be one of the retrieved passages, and an uncited answer to a factual question is a warning sign.

When retrieval finds nothing relevant, the honest behaviour is to say so — "this isn't covered in your course material" — and, if allowed, give a clearly labelled general explanation. A tutor that confidently invents a citation is worse than one that admits a gap.

## Worked example: fitting passages into the context window

Every model has a **context window**, a maximum number of tokens it can read at once. RAG has to share it. Suppose the model has an $8{,}000$-token window and you plan the budget like this:

| part | tokens |
|---|---|
| system instructions and tutor rules | $600$ |
| recent conversation | $1{,}400$ |
| reserved for the answer | $1{,}000$ |

That leaves $8{,}000 - 600 - 1{,}400 - 1{,}000 = 5{,}000$ tokens for retrieved passages. If chunks average $400$ tokens, you can include at most $\lfloor 5{,}000 / 400 \rfloor = 12$ chunks. In practice you would send fewer, say the top 6 to 8, because irrelevant passages distract the model and every extra token adds cost and latency.

Even with very large context windows, retrieval still matters. Stuffing an entire library into the prompt is slow, expensive, and makes it harder for the model to find the one paragraph that answers the question.

## RAG versus fine-tuning

Fine-tuning changes the model's weights by training on extra examples. It is good at teaching **style and format** (always answer in this structure, use this tone) and specialised skills. It is a poor way to add **facts**: it is expensive to repeat whenever documents change, it cannot cite, and it is hard to remove information later, which matters for privacy.

RAG keeps knowledge outside the model. Updating it means re-indexing a document, which takes seconds. Access control is natural, because you can filter which documents each user may retrieve. And citations come for free, because you know exactly which passages were shown. Many production systems use both: RAG for knowledge, light fine-tuning or careful prompting for behaviour.

## Retrieved text is data, not instructions

Retrieved passages come from documents and, sometimes, the open web. Any of them might contain text like "ignore your previous instructions". This is **prompt injection**. A RAG system must treat passages strictly as quoted material: wrap them clearly in the prompt, tell the model never to follow instructions found inside them, and check outputs for signs of manipulation, such as unexpected links. Retrieval widens what the model can see, so it also widens the attack surface.

## Where quality comes from

A RAG answer can only be as good as what was retrieved. If the right passage never reaches the prompt, no model can cite it. That is why the rest of this module focuses on the retrieval pipeline — chunking, vector search, hybrid search with rank fusion — and on **measuring** it. In practice, most quality improvements in RAG systems come from better retrieval and evaluation, not from switching to a bigger model.

## Common mistakes

- **Assuming RAG eliminates hallucination.** It reduces it. The model can still misread or overreach beyond the passages, so validation is still needed.
- **Sending as many chunks as will fit.** More context is not always better; noise dilutes relevance.
- **Skipping the "not covered" path.** Without an explicit instruction, models fill gaps with confident guesses.
- **Trusting passage content as commands.** Retrieved text must never override system rules.

## Check yourself

1. Name two limitations of a model's built-in knowledge that RAG addresses.
2. A model has a $16{,}000$-token window. Instructions use $1{,}000$, history $3{,}000$ and you reserve $2{,}000$ for the answer. How many $500$-token chunks fit? (Answer: $10{,}000 / 500 = 20$.)
3. Why is fine-tuning a poor way to keep a model up to date with frequently changing documents?
