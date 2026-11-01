from __future__ import annotations

import io

import pytest

from app.errors import AppError
from app.ingestion.parsers import parse_document
from tests.conftest import REPO_ROOT

SAMPLES = REPO_ROOT / "content" / "samples"
BODY = "Gradient descent moves parameters against the gradient of the loss. " * 5


def test_txt_and_md() -> None:
    doc = parse_document(BODY.encode(), "text/plain", "notes.txt")
    assert doc.format == "txt" and doc.page_count == 1 and "Gradient descent" in doc.pages[0].text
    md = parse_document(f"# Title\n\n{BODY}".encode(), "application/octet-stream", "notes.md")
    assert md.format == "md" and md.pages[0].text.startswith("# Title")


def test_no_text() -> None:
    with pytest.raises(AppError) as exc:
        parse_document(b"   tiny   \n\n", "text/plain", "a.txt")
    assert exc.value.code == "INGEST_NO_TEXT"
    assert exc.value.status == 422


def test_unsupported_type() -> None:
    with pytest.raises(AppError) as exc:
        parse_document(b"\x89PNG....", "image/png", "photo.png")
    assert exc.value.code == "INGEST_UNSUPPORTED_TYPE"


def test_binary_txt_and_bad_pdf_fail_to_parse() -> None:
    with pytest.raises(AppError) as exc:
        parse_document(b"abc\x00def" * 20, "text/plain", "a.txt")
    assert exc.value.code == "INGEST_PARSE_FAILED"
    with pytest.raises(AppError) as exc2:
        parse_document(b"%PDF-1.7 this is not really a pdf", "application/pdf", "a.pdf")
    assert exc2.value.code == "INGEST_PARSE_FAILED"
    with pytest.raises(AppError) as exc3:
        parse_document(
            b"not a zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx"
        )
    assert exc3.value.code == "INGEST_PARSE_FAILED"


def test_blank_pdf_has_no_text() -> None:
    from pypdf import PdfWriter

    w = PdfWriter()
    w.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    w.write(buf)
    with pytest.raises(AppError) as exc:
        parse_document(buf.getvalue(), "application/pdf", "scan.pdf")
    assert exc.value.code == "INGEST_NO_TEXT"


def test_docx_headings_become_markdown() -> None:
    import docx

    d = docx.Document()
    d.add_heading("Backpropagation", level=1)
    d.add_paragraph(BODY)
    d.add_heading("Chain rule", level=2)
    d.add_paragraph("Multiply the upstream gradient by the local derivative at every node of the graph.")
    buf = io.BytesIO()
    d.save(buf)
    doc = parse_document(buf.getvalue(), None, "notes.docx")
    text = doc.pages[0].text
    assert doc.format == "docx"
    assert "# Backpropagation" in text and "## Chain rule" in text


@pytest.mark.skipif(not (SAMPLES / "Lecture 3 notes.pdf").exists(), reason="content samples not present")
def test_sample_pdfs() -> None:
    doc = parse_document((SAMPLES / "Lecture 3 notes.pdf").read_bytes(), "application/pdf", "Lecture 3 notes.pdf")
    assert doc.page_count >= 1 and doc.char_count > 200
    assert all(p.page == i for i, p in enumerate(doc.pages, start=1))
    scanned = SAMPLES / "Scanned handout.pdf"
    if scanned.exists():
        with pytest.raises(AppError) as exc:
            parse_document(scanned.read_bytes(), "application/pdf", scanned.name)
        assert exc.value.code == "INGEST_NO_TEXT"
