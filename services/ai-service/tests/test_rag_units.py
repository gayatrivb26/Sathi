"""RRF fusion math, tsquery building, chunker and citation check."""

from __future__ import annotations

import pytest

from app.rag.chunking import PageText, chunk_markdown, chunk_pages
from app.rag.citations import GENERAL_MARKER, check_citations
from app.rag.retrieval import build_tsquery, rrf_fuse
from app.text import approx_tokens

# ---------------------------------------------------------------- RRF


def test_rrf_scores_match_formula() -> None:
    fused = dict(rrf_fuse([["a", "b", "c"], ["b", "d"]], k=60))
    assert fused["b"] == pytest.approx(1 / 62 + 1 / 61)
    assert fused["a"] == pytest.approx(1 / 61)
    assert fused["c"] == pytest.approx(1 / 63)
    assert fused["d"] == pytest.approx(1 / 62)


def test_rrf_order_and_ties() -> None:
    order = [key for key, _ in rrf_fuse([["a", "b", "c"], ["b", "d"]], k=60)]
    assert order == ["b", "a", "d", "c"]
    # a document ranked first by both lists always wins
    assert rrf_fuse([["x", "y"], ["x", "z"]])[0][0] == "x"
    # exact tie (a: rank1+rank2, b: rank2+rank1) → best individual rank, then first appearance
    tie = rrf_fuse([["a", "b"], ["b", "a"]])
    assert tie[0][1] == pytest.approx(tie[1][1])
    assert [k for k, _ in tie] == ["a", "b"]


def test_rrf_empty() -> None:
    assert rrf_fuse([[], []]) == []


def test_tsquery_is_sanitised() -> None:
    q = build_tsquery("What's the role of softmax & attention?! '; DROP TABLE x; --")
    assert q is not None
    assert all(part.strip().isalnum() for part in q.split("|"))
    assert "softmax" in q and "attention" in q
    assert build_tsquery("what is the") is None


# ---------------------------------------------------------------- chunking

LESSON = (
    "# Attention basics\n\nAttention lets a model look at every token. " * 3
    + "\n\n## Scaling\n\n"
    + " ".join(f"Sentence number {i} explains why scores are divided by the square root of d_k." for i in range(80))
    + "\n\n```python\nscores = q @ k.T / math.sqrt(d_k)\n```\n\n- item one\n- item two\n"
)


def test_chunks_respect_size_and_overlap() -> None:
    chunks = chunk_markdown(LESSON, target_tokens=120, overlap=0.15)
    assert len(chunks) > 3
    assert [c.index for c in chunks] == list(range(len(chunks)))
    for c in chunks:
        assert c.token_count <= 120 * 1.4  # one sentence of slack + overlap
        assert c.content.strip()
    scaling = [c for c in chunks if c.section and "Scaling" in c.section]
    assert len(scaling) >= 3
    # consecutive chunks in the same section share overlapping sentences
    first_tail = scaling[0].content.split(". ")[-1]
    assert first_tail[:30] in scaling[1].content


def test_chunks_keep_section_and_code_fence() -> None:
    chunks = chunk_markdown(LESSON, target_tokens=350)
    assert chunks[0].section == "Attention basics"
    assert any(c.section == "Attention basics › Scaling" for c in chunks)
    code = [c for c in chunks if "```python" in c.content]
    assert code and "math.sqrt(d_k)" in code[0].content and code[0].content.count("```") == 2


def test_chunks_keep_pages_and_do_not_cross_them() -> None:
    pages = [PageText(1, "Page one talks about embeddings. " * 20), PageText(2, "Page two covers HNSW graphs. " * 20)]
    chunks = chunk_pages(pages, target_tokens=350)
    assert {c.page for c in chunks} == {1, 2}
    for c in chunks:
        assert ("HNSW" in c.content) == (c.page == 2)


def test_chunk_default_size_is_about_350_tokens() -> None:
    text = "\n\n".join(" ".join(["word"] * 60) + "." for _ in range(40))
    chunks = chunk_markdown(text)
    sizes = [approx_tokens(c.content) for c in chunks[:-1]]
    assert sizes and max(sizes) <= 420 and min(sizes) >= 200


def test_empty_text_yields_no_chunks() -> None:
    assert chunk_markdown("   \n\n  ") == []
    assert chunk_markdown("# Only a heading") == []


# ---------------------------------------------------------------- citations


def test_citation_check_valid_and_dropped() -> None:
    text = "Attention scales scores [1]. Softmax saturates [3]. Both matter [1, 2]. Made up [9]."
    check = check_citations(text, {1: "course", 2: "web"})
    assert check.valid == [1, 2]
    assert [d.index for d in check.dropped] == [3, 9]
    assert "[3]" not in check.content and "[9]" not in check.content
    assert "[1]" in check.content and "[1, 2]" in check.content
    assert "saturates." in check.content  # no dangling space before the full stop
    assert check.answer_basis == ["course", "web"]


def test_citation_check_ignores_code_and_maths() -> None:
    text = "Index with `x[3]` or $a[2]$ but cite [1]."
    check = check_citations(text, {1: "upload"})
    assert check.content == text
    assert check.valid == [1] and not check.dropped
    assert check.answer_basis == ["upload"]


def test_general_basis_without_citations() -> None:
    check = check_citations(f"Not in your notes.\n\n**{GENERAL_MARKER}:** cookies need butter.", {})
    assert check.answer_basis == ["general"]
    assert check.valid == []
    mixed = check_citations(f"From the lesson [1].\n\n**{GENERAL_MARKER}:** more.", {1: "course"})
    assert mixed.answer_basis == ["course", "general"]
