"""File parsers: PDF (pypdf, per page), DOCX (python-docx, headings → Markdown), Markdown and plain text.

Errors carry the ingestion contract codes: ``INGEST_UNSUPPORTED_TYPE``, ``INGEST_PARSE_FAILED`` and
``INGEST_NO_TEXT`` (< 50 non-whitespace characters, e.g. a scanned PDF).
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass

from app.errors import AppError
from app.rag.chunking import PageText

MIN_TEXT_CHARS = 50

_TYPES = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "text/markdown": "md",
    "text/x-markdown": "md",
    "text/plain": "txt",
}
_EXTENSIONS = {".pdf": "pdf", ".docx": "docx", ".md": "md", ".markdown": "md", ".txt": "txt"}


@dataclass
class ParsedDocument:
    format: str
    pages: list[PageText]

    @property
    def char_count(self) -> int:
        return sum(len(p.text) for p in self.pages)

    @property
    def page_count(self) -> int:
        return len(self.pages)


def detect_format(content_type: str | None, file_name: str | None) -> str:
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct in _TYPES:
        return _TYPES[ct]
    name = (file_name or "").lower()
    for ext, fmt in _EXTENSIONS.items():
        if name.endswith(ext):
            return fmt
    raise AppError("INGEST_UNSUPPORTED_TYPE", "This file type is not supported.", internal=f"content_type={ct!r}")


def _clean(text: str) -> str:
    text = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"-\n(?=[a-z])", "", text)  # de-hyphenate line breaks
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _parse_pdf(data: bytes) -> list[PageText]:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    if not data.startswith(b"%PDF-"):
        raise AppError("INGEST_PARSE_FAILED", "This file is not a valid PDF.", internal="missing %PDF- magic")
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception as exc:
                raise AppError(
                    "INGEST_PARSE_FAILED", "This PDF is password-protected.", internal="encrypted pdf"
                ) from exc
        pages = []
        for i, page in enumerate(reader.pages, start=1):
            pages.append(PageText(i, _clean(page.extract_text() or "")))
        return pages
    except AppError:
        raise
    except (PdfReadError, ValueError, KeyError, TypeError, OSError) as exc:
        raise AppError("INGEST_PARSE_FAILED", internal=f"pypdf: {type(exc).__name__}") from exc


def _parse_docx(data: bytes) -> list[PageText]:
    import docx

    if not data.startswith(b"PK\x03\x04"):
        raise AppError("INGEST_PARSE_FAILED", "This file is not a valid Word document.", internal="bad zip magic")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            if not any(n.startswith("word/") for n in zf.namelist()):
                raise AppError("INGEST_PARSE_FAILED", internal="no word/ entry")
        document = docx.Document(io.BytesIO(data))
    except AppError:
        raise
    except Exception as exc:
        raise AppError("INGEST_PARSE_FAILED", internal=f"python-docx: {type(exc).__name__}") from exc

    lines: list[str] = []
    for para in document.paragraphs:
        text = para.text.strip()
        if not text:
            lines.append("")
            continue
        style = (para.style.name if para.style is not None else "") or ""
        m = re.match(r"Heading\s*(\d)", style)
        if m:
            lines.append("")
            lines.append("#" * min(6, int(m.group(1))) + " " + text)
            lines.append("")
        elif style.lower().startswith("title"):
            lines.append("# " + text)
            lines.append("")
        elif "list" in style.lower():
            lines.append("- " + text)
        else:
            lines.append(text)
            lines.append("")
    for table in document.tables:
        lines.append("")
        for row in table.rows:
            lines.append("| " + " | ".join(cell.text.strip() for cell in row.cells) + " |")
    return [PageText(None, _clean("\n".join(lines)))]


def _parse_text(data: bytes) -> list[PageText]:
    if b"\x00" in data:
        raise AppError("INGEST_PARSE_FAILED", "This text file contains binary data.", internal="NUL byte")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise AppError("INGEST_PARSE_FAILED", "This text file is not valid UTF-8.", internal="utf-8") from exc
    return [PageText(None, _clean(text))]


def parse_document(data: bytes, content_type: str | None, file_name: str | None) -> ParsedDocument:
    fmt = detect_format(content_type, file_name)
    if fmt == "pdf":
        pages = _parse_pdf(data)
    elif fmt == "docx":
        pages = _parse_docx(data)
    else:
        pages = _parse_text(data)
    doc = ParsedDocument(format=fmt, pages=pages)
    non_ws = sum(len(re.sub(r"\s", "", p.text)) for p in pages)
    if non_ws < MIN_TEXT_CHARS:
        raise AppError(
            "INGEST_NO_TEXT",
            "We couldn't find selectable text in this file. If it is a scan, please upload a text version.",
            internal=f"non_whitespace_chars={non_ws}",
        )
    return doc
