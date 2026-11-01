# Embeddings and similarity

## Turning symbols into vectors

Neural networks operate on numbers, but language arrives as symbols: words, sub-word tokens, product IDs, user IDs. The naive encoding is **one-hot**: give each token in a vocabulary of size $V$ its own position in a length-$V$ vector, put a $1$ there and zeros everywhere else. One-hot vectors are huge and, worse, every pair of them is equally different. "cat" is as far from "kitten" as it is from "carburettor".

An **embedding** fixes both problems. It maps each token to a dense vector of, say, $d = 768$ real numbers, and those numbers are learned so that tokens used in similar ways end up with similar vectors. Similarity becomes geometry: related items sit close together, and directions in the space can carry meaning.

## The embedding table

In code an embedding layer is just a lookup table: a matrix $E$ of shape $V \times d$. Token number $i$ is represented by row $i$. Looking up a row is mathematically the same as multiplying a one-hot vector by $E$, but much cheaper.

The table is a regular parameter, trained by backpropagation along with the rest of the model. Only the rows for tokens present in a batch receive gradients at each step. Tables can be large: a vocabulary of $50{,}000$ tokens with $d = 768$ has $50{,}000 \times 768 = 38{,}400{,}000$ parameters, often a sizeable fraction of a small language model.

Where does the meaning come from? From the training objective. If a model must predict a word from its neighbours, words that appear in similar contexts ("coffee" and "tea") get pushed towards similar vectors because similar vectors produce similar predictions. This is the **distributional hypothesis**: you know a word by the company it keeps.

## Measuring similarity

Given two embedding vectors $a$ and $b$, there are three standard measures.

**Dot product.** $a \cdot b = \sum_i a_i b_i$. Large when vectors point the same way and are long.

**Cosine similarity.** The dot product divided by the lengths:

$$\cos(a, b) = \frac{a \cdot b}{\|a\|\,\|b\|}$$

It ranges from $-1$ (opposite) through $0$ (unrelated, orthogonal) to $1$ (same direction), and ignores vector length.

**Euclidean distance.** $\|a - b\| = \sqrt{\sum_i (a_i - b_i)^2}$. Small means similar.

If every vector is normalised to unit length, these agree on ranking: the dot product equals the cosine, and $\|a - b\|^2 = 2 - 2\cos(a, b)$. That is why many systems normalise embeddings once at write time and then use the cheapest operation, the dot product.

## Worked example: cosine similarity

Let $a = [1, 2, 2]$, $b = [2, 0, 1]$ and $c = [2, 4, 4]$.

**Lengths.** $\|a\| = \sqrt{1 + 4 + 4} = 3$, $\|b\| = \sqrt{4 + 0 + 1} = \sqrt{5} \approx 2.236$, $\|c\| = \sqrt{4 + 16 + 16} = 6$.

**$a$ versus $b$.** $a \cdot b = 1 \times 2 + 2 \times 0 + 2 \times 1 = 4$, so

$$\cos(a, b) = \frac{4}{3 \times 2.236} = \frac{4}{6.708} \approx 0.596$$

**$a$ versus $c$.** $a \cdot c = 2 + 8 + 8 = 18$, so $\cos(a, c) = 18 / (3 \times 6) = 1$. The vector $c$ is just $2a$: same direction, twice as long. Cosine says they are identical in meaning. The dot product, $18$ versus $4$, also ranks $c$ above $b$, but it would rank *any* sufficiently long vector highly, which is why length-sensitive scores can be misleading for unnormalised embeddings.

**Euclidean.** $\|a - b\| = \|[-1, 2, 1]\| = \sqrt{6} \approx 2.449$ while $\|a - c\| = \|[-1, -2, -2]\| = 3$. By Euclidean distance $b$ is *closer* to $a$ than $c$ is, the opposite of cosine. The choice of metric changes the answer when vectors are not normalised.

## From words to sentences and documents

Token embeddings are the input layer of a language model. For search and RAG we usually want one vector per **passage**. **Sentence embedding models** are trained for this, typically with a **contrastive** objective: pairs that should match (a question and the passage that answers it) are pulled together, and non-matching pairs in the same batch are pushed apart. The result is a model where a question and its answer land near each other even when they share few words.

This is the foundation of semantic search: embed every chunk of your documents once, embed each incoming query, and return the chunks whose vectors are most similar. Later lessons cover how to do that quickly at scale.

## Practical rules for embeddings

- **Use the same model for queries and documents.** Vectors from different models live in different spaces and cannot be compared.
- **Re-embed everything when you change models.** Mixing versions in one index silently ruins search quality.
- **Use the metric the model was trained for.** Most text embedding models expect cosine similarity.
- **Watch for instruction prefixes.** Some models expect inputs such as `query:` and `passage:`; omitting them reduces quality.

## Common mistakes

- **Treating similarity as truth.** Embeddings capture relatedness, not correctness. "The drug is safe" and "The drug is not safe" can be very close.
- **Comparing raw dot products of unnormalised vectors.** Long vectors win regardless of direction.
- **Expecting exact-match behaviour.** Embeddings are weak at rare identifiers, codes and names. Keyword search complements them (see the hybrid search lesson).

## Check yourself

1. Compute the cosine similarity of $[1, 0]$ and $[1, 1]$. (Answer: $1 / (1 \times \sqrt{2}) \approx 0.707$.)
2. Why do one-hot vectors fail to capture that "cat" and "kitten" are related?
3. You switched embedding models but kept the old vectors in the index for old documents. What goes wrong?
