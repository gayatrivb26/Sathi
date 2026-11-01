#!/usr/bin/env python3
"""Generate the demo upload samples in content/samples/.

  Lecture 3 notes.txt   plain-text lecture notes on attention (pages separated by form feeds)
  Lecture 3 notes.pdf   the same notes as a 3-page PDF with real, selectable text
  Scanned handout.pdf   a PDF that contains only a raster image (no text layer) to demo the
                        "Could not read text" state

Requires fpdf2 (which pulls in Pillow):  python -m pip install --user fpdf2
Usage: python content/tools/make_sample_pdfs.py
"""
from __future__ import annotations

import io
import random
from pathlib import Path

from fpdf import FPDF
from PIL import Image, ImageDraw, ImageFilter

SAMPLES = Path(__file__).resolve().parents[1] / "samples"

TITLE = "Lecture 3 - Attention mechanisms"
SUBTITLE = "AI Engineering - lecture notes"

# Each page is a list of (kind, text) where kind is "h" (heading) or "p" (paragraph).
# ASCII only so the built-in PDF fonts can render every character.
PAGES = [
    [
        ("h", "1. Why attention?"),
        ("p", "An embedding table gives every token one fixed vector, but the meaning of a word depends on "
              "its context. 'Bank' in 'river bank' and 'bank account' should end up with different "
              "representations. Recurrent networks tried to carry context forward one token at a time in a "
              "single hidden state, which made long-range dependencies hard to learn and made training "
              "sequential. Attention lets every token look at every other token directly, in parallel."),
        ("h", "2. Attention as a soft lookup"),
        ("p", "Think of a dictionary lookup. A query is compared with keys and the matching value is returned. "
              "Attention is the soft version: the query is compared with every key, the scores are turned "
              "into weights with a softmax, and the output is the weighted average of all the values."),
        ("p", "    score_i  = q . k_i\n"
              "    weight_i = exp(score_i) / sum_j exp(score_j)\n"
              "    output   = sum_i weight_i * v_i"),
        ("p", "The weights are positive and sum to one. They are recomputed for every input sentence; the "
              "learned parameters are the projection matrices that produce queries, keys and values, not the "
              "weights themselves."),
        ("h", "3. Where Q, K and V come from"),
        ("p", "In self-attention all three are linear projections of the same token embeddings X: "
              "Q = X W_Q, K = X W_K, V = X W_V. The query says what a token is looking for, the key says what "
              "it offers, and the value is the information it hands over. Because W_Q and W_K are different, "
              "the score from token i to token j is generally not the same as from j to i. That asymmetry is "
              "useful: a verb looking for its subject is not the same relationship as the subject looking "
              "for its verb."),
        ("p", "Shapes: X is n x d_model, W_Q and W_K are d_model x d_k, so Q K^T is n x n. One row per query, "
              "one column per key."),
    ],
    [
        ("h", "4. Scaled dot-product attention"),
        ("p", "The full formula is  Attention(Q, K, V) = softmax(Q K^T / sqrt(d_k) + M) V,  where M is a mask "
              "(0 where attention is allowed, minus infinity where it is not)."),
        ("p", "Why divide by sqrt(d_k)? If the entries of q and k are independent with mean 0 and variance 1, "
              "then each product q_i k_i has variance 1, and the dot product adds d_k of them. So the variance "
              "of q . k is d_k and its standard deviation is sqrt(d_k). With d_k = 64 the scores are typically "
              "around +/- 8."),
        ("p", "Large scores are bad for the softmax. It depends exponentially on score differences, so big "
              "scores push it towards a one-hot distribution: one token gets almost all the weight. A "
              "saturated softmax also has tiny gradients (the derivative p(1 - p) is close to zero when p is "
              "close to 0 or 1), so the attention weights stop learning. Dividing by sqrt(d_k) brings the "
              "variance back to 1 for any dimension and keeps the softmax in its useful range."),
        ("h", "5. Worked example (two keys, d_k = 4)"),
        ("p", "q = [1, 0, 1, 0], k1 = [2, 1, 2, 0], k2 = [0, 1, 0, 2], v1 = [1, 0], v2 = [0, 1].\n"
              "Raw scores: q . k1 = 4, q . k2 = 0. Divide by sqrt(4) = 2: scores [2, 0].\n"
              "Softmax: e^2 = 7.389, so weights = [7.389 / 8.389, 1 / 8.389] = [0.881, 0.119].\n"
              "Output = 0.881 * v1 + 0.119 * v2 = [0.881, 0.119].\n"
              "Without scaling the weights would be [0.982, 0.018] - already much closer to one-hot, and the "
              "gradient factor p(1 - p) drops from about 0.105 to about 0.018."),
        ("h", "6. Masks"),
        ("p", "A causal mask stops a token from attending to later tokens, which a next-token predictor must "
              "not see. Add minus infinity to those scores BEFORE the softmax so their weights become exactly "
              "zero and each row still sums to one. Padding masks hide the padding positions in a batch in "
              "the same way. Do not zero the weights after the softmax - the rows would no longer sum to one."),
    ],
    [
        ("h", "7. Multi-head attention"),
        ("p", "One softmax row has to compromise between all the relationships a token cares about. "
              "Multi-head attention runs h attention operations in parallel, each in its own subspace of size "
              "d_k = d_model / h, then concatenates the head outputs and mixes them with an output matrix W_O. "
              "With d_model = 512 and h = 8, each head has d_k = 64 and scales by sqrt(64) = 8. The parameter "
              "count is the same as one wide head: 4 x 512 x 512 = 1,048,576 weights for Q, K, V and O."),
        ("h", "8. Cost"),
        ("p", "The score matrix has n x n entries per head. For n = 4,096 tokens that is 16,777,216 scores, "
              "or 32 MiB per head per layer in 16-bit floats. This quadratic growth is why long contexts are "
              "expensive. FlashAttention computes the same result in tiles without storing the full matrix."),
        ("h", "9. Order"),
        ("p", "Self-attention on its own does not know token order: shuffle the input and the outputs are just "
              "shuffled. Positional information has to be added, either as position embeddings added to the "
              "input or by rotating queries and keys (RoPE) so that scores depend on relative distance."),
        ("h", "Summary"),
        ("p", "- Attention = softmax-weighted average of values, weights from query-key similarity.\n"
              "- Q, K, V are three learned projections of the same tokens.\n"
              "- Divide scores by sqrt(d_k): dot products grow with dimension, softmax saturates, gradients vanish.\n"
              "- Mask with minus infinity before the softmax.\n"
              "- Multiple heads = multiple relationships at the same parameter cost.\n"
              "- Cost is quadratic in sequence length."),
        ("p", "Reading for next week: the Transformer block (residual connections, layer norm, feed-forward)."),
    ],
]


def write_text() -> None:
    parts = [f"{TITLE}\n{SUBTITLE}\n"]
    for page in PAGES:
        lines = []
        for kind, text in page:
            lines.append(text.upper() if kind == "h" else text)
        parts.append("\n\n".join(lines))
    # Form feed (\f) is the conventional plain-text page break.
    text = parts[0] + "\n" + "\n\n\f\n".join(parts[1:]) + "\n"
    (SAMPLES / "Lecture 3 notes.txt").write_text(text, encoding="utf-8", newline="\n")


class LecturePDF(FPDF):
    def footer(self) -> None:
        self.set_y(-14)
        self.set_font("Helvetica", "", 9)
        self.cell(0, 6, f"Page {self.page_no()} of {{nb}}", align="C")


def write_lecture_pdf() -> None:
    pdf = LecturePDF(format="A4")
    pdf.set_title("Lecture 3 notes")
    pdf.set_author("AI Engineering course")
    pdf.set_auto_page_break(auto=True, margin=18)
    for n, page in enumerate(PAGES, 1):
        pdf.add_page()
        if n == 1:
            pdf.set_font("Helvetica", "B", 18)
            pdf.cell(0, 10, TITLE, new_x="LMARGIN", new_y="NEXT")
            pdf.set_font("Helvetica", "I", 11)
            pdf.cell(0, 7, SUBTITLE, new_x="LMARGIN", new_y="NEXT")
            pdf.ln(4)
        for kind, text in page:
            if kind == "h":
                pdf.ln(2)
                pdf.set_font("Helvetica", "B", 13)
                pdf.multi_cell(0, 7, text, new_x="LMARGIN", new_y="NEXT")
                pdf.ln(1)
            else:
                mono = text.startswith("    ")
                pdf.set_font("Courier" if mono else "Helvetica", "", 10 if mono else 11)
                pdf.multi_cell(0, 5.6, text, new_x="LMARGIN", new_y="NEXT")
                pdf.ln(2)
    pdf.output(str(SAMPLES / "Lecture 3 notes.pdf"))


def scanned_image() -> bytes:
    """Draw a 'photocopied handout': grey text-like bars and a diagram, plus noise. No real text."""
    rnd = random.Random(7)
    w, h = 1240, 1754  # A4 at 150 dpi
    img = Image.new("L", (w, h), 238)
    d = ImageDraw.Draw(img)
    # title block
    d.rectangle([120, 110, 900, 150], fill=70)
    d.rectangle([120, 175, 620, 195], fill=120)
    # paragraphs of fake 'text' made of word-shaped bars
    y = 260
    for para in range(4):
        for line in range(rnd.randint(4, 6)):
            x = 120
            end = 1120 if line < 5 else rnd.randint(500, 900)
            while x < end:
                ww = rnd.randint(25, 110)
                d.rectangle([x, y, min(x + ww, end), y + 14], fill=rnd.randint(60, 110))
                x += ww + rnd.randint(12, 20)
            y += 30
        y += 28
    # diagram: query box -> three key boxes -> weighted sum circle
    d.rectangle([160, y + 40, 330, y + 130], outline=40, width=5)
    for i in range(3):
        top = y + 10 + i * 110
        d.rectangle([520, top, 690, top + 80], outline=40, width=5)
        d.line([330, y + 85, 520, top + 40], fill=40, width=4)
        d.line([690, top + 40, 880, y + 140], fill=40, width=4)
    d.ellipse([880, y + 80, 1000, y + 200], outline=40, width=6)
    d.line([1000, y + 140, 1100, y + 140], fill=40, width=5)
    d.polygon([(1100, y + 125), (1130, y + 140), (1100, y + 155)], fill=40)
    # scanner noise, slight blur and a skewed page edge shadow
    px = img.load()
    for _ in range(25000):
        px[rnd.randrange(w), rnd.randrange(h)] = rnd.randint(150, 215)
    d.rectangle([0, 0, 28, h], fill=175)
    img = img.filter(ImageFilter.GaussianBlur(0.8)).rotate(0.7, fillcolor=238)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def write_scanned_pdf() -> None:
    pdf = FPDF(format="A4")
    pdf.set_title("Scanned handout")
    pdf.add_page()
    pdf.image(io.BytesIO(scanned_image()), x=0, y=0, w=210, h=297)
    pdf.output(str(SAMPLES / "Scanned handout.pdf"))


if __name__ == "__main__":
    SAMPLES.mkdir(parents=True, exist_ok=True)
    write_text()
    write_lecture_pdf()
    write_scanned_pdf()
    print("wrote samples to", SAMPLES)
