# Chunking documents

## Why we split documents at all

Retrieval works on units of text, and the whole document is almost never the right unit. A 40-page PDF covers dozens of topics; one embedding vector for all of it would be a blurry average that matches nothing well. And even if you found the right document, you could not fit it in the prompt.

So during indexing we split each document into **chunks**: passages that are small enough to embed precisely and to fit several into a prompt, but large enough to carry a complete thought. Each chunk is embedded, indexed and retrieved on its own. Chunking looks like a boring preprocessing step, but it has an outsized effect on retrieval quality.

## The size trade-off

Chunk size is a balance between two failure modes:

- **Too small** (a sentence or two): each chunk is precise, but it loses context. "It is divided by the square root of the key dimension" is useless if the chunk does not say what "it" is. You also need many more chunks to answer one question.
- **Too large** (several pages): each chunk contains the answer somewhere, but its embedding is diluted by everything else, so it ranks poorly. It also consumes a large share of the context window.

A common starting point for text is $200$ to $800$ tokens per chunk, then tune on your own evaluation set. As a rough rule for English, one token is about four characters, or three-quarters of a word.

## Strategies

**Fixed-size chunking.** Split every $N$ tokens. It is simple and predictable, but it cuts through sentences and sections blindly.

**Overlap.** Repeat the last few tokens of one chunk at the start of the next. If a key sentence straddles a boundary, at least one chunk contains it whole. Overlap of $10\%$ to $20\%$ is typical.

**Recursive or separator-based splitting.** Try to split on the biggest natural boundary first (headings, then blank lines, then sentences), and only fall back to smaller separators when a piece is still too large. This keeps paragraphs and sentences intact.

**Structure-aware chunking.** Use the document's own structure. Markdown headings, HTML sections, PDF pages and slide boundaries are strong signals that the topic changes. Course lessons, like this one, are written with `##` headings precisely so they can be split along them.

**Semantic chunking.** Embed sentences and start a new chunk where similarity between neighbouring sentences drops sharply. It can follow topic shifts in unstructured text, at the cost of extra computation.

## Worked example: counting chunks with overlap

A document has $10{,}000$ tokens. You use a chunk size of $500$ and an overlap of $100$, so each new chunk starts $500 - 100 = 400$ tokens after the previous one (the **stride**).

Chunks start at positions $0, 400, 800, \dots$. The last chunk must reach the end of the document, so we need the first start position $s$ with $s + 500 \ge 10{,}000$, that is, $s \ge 9{,}500$. The multiples of $400$ go $\dots, 9{,}200, 9{,}600$, so the last chunk starts at $9{,}600$, which is index $9{,}600 / 400 = 24$. Counting from index $0$, that is

$$24 + 1 = 25 \text{ chunks}$$

Twenty-four of them are full $500$-token chunks and the last runs from $9{,}600$ to $10{,}000$, so it holds $400$ tokens. In total you embed $24 \times 500 + 400 = 12{,}400$ tokens, which is $24\%$ more than the document itself. Overlap buys robustness at the cost of storage and embedding time. Without overlap you would need exactly $10{,}000 / 500 = 20$ chunks.

## Metadata: the part people forget

A chunk is not just text. Store alongside it:

- **Source identifiers**: document ID, title, version.
- **Location**: page number, section heading path (for example "Module 3 > Scaled dot-product attention > Why large scores are harmful"), character offsets.
- **Access information**: which users or courses may see it.

Metadata powers citations ("Lecture 3 notes, page 2"), filtering ("only this student's uploads and this course"), and debugging. A very effective trick is to **prepend the heading path to the chunk text before embedding it**. A chunk that says only "divide by 8" becomes far more findable when it is embedded as "Scaled dot-product attention — Worked example: divide by 8".

## Special content

- **Tables**: keep a table in one chunk if possible, and repeat the header row if you must split it.
- **Code**: split on function or class boundaries, not mid-function.
- **Scanned PDFs**: if a page has no extractable text, there is nothing to chunk. The pipeline should report that clearly (or run OCR) instead of silently indexing nothing.
- **Very short documents**: a short note can be a single chunk.

## Parent–child retrieval

A useful refinement separates what you **search** from what you **show**. Index small child chunks (say $200$ tokens) for precise matching, but when one is retrieved, send its larger parent section to the model for context. You get sharp retrieval and complete passages.

## Common mistakes

- **Splitting on characters without respecting tokens.** Chunk limits should be measured in the embedding model's tokens; character counts are only a proxy.
- **Exceeding the embedding model's input limit.** Text beyond the limit is silently truncated and never represented in the vector.
- **Dropping headings and page numbers.** Without them, you cannot cite properly or filter by section.
- **Choosing a chunk size once and never testing it.** Measure retrieval quality on real questions at two or three sizes.

## Check yourself

1. A $6{,}000$-token document is split into $1{,}000$-token chunks with $200$ tokens of overlap. How many chunks are there? (Answer: stride $800$; starts $0, 800, \dots, 5{,}600$, so $8$ chunks.)
2. Why can a very large chunk rank poorly even though it contains the answer?
3. Give two reasons to store a heading path with each chunk.
