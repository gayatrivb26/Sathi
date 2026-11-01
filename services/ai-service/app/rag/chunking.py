"""Structure-aware chunking: ~350 tokens, ~15% overlap, keeps page and section heading.

Input is a list of pages (PDF pages, or a single page for docx/md/txt). Markdown headings start new
sections; chunks never cross a section or page boundary. Paragraphs are split into sentences; code fences,
list items and table rows are kept as whole units. Overlap carries the trailing sentences of the previous
chunk (within the same section) into the next one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.text import approx_tokens, sentences

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
LIST_RE = re.compile(r"^\s*([-*+]|\d+[.)]|\|)\s")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
PARA = "\n\n"
LINE = "\n"


@dataclass(frozen=True)
class PageText:
    page: int | None
    text: str


@dataclass(frozen=True)
class Chunk:
    index: int
    content: str
    page: int | None
    section: str | None
    token_count: int


@dataclass
class _Unit:
    text: str
    page: int | None
    section: str | None
    joiner: str  # how this unit attaches to the previous one (paragraph break, line break or space)
    tokens: int


def _split_long(text: str, max_tokens: int) -> list[str]:
    """Split one over-long sentence/line into word windows."""
    words = text.split()
    step = max(20, int(max_tokens / 1.3))
    return [" ".join(words[i : i + step]) for i in range(0, len(words), step)]


class _UnitBuilder:
    """Turns page text into sentence/line units carrying page + section metadata."""

    def __init__(self, max_tokens: int) -> None:
        self.max_tokens = max_tokens
        self.units: list[_Unit] = []
        self.headings: dict[int, str] = {}
        self.page: int | None = None
        self.para: list[str] = []

    def section(self) -> str | None:
        if not self.headings:
            return None
        parts = [self.headings[lv] for lv in sorted(self.headings)][-2:]
        return " › ".join(parts)[:200]

    def add(self, text: str, joiner: str) -> None:
        pieces = [text] if approx_tokens(text) <= self.max_tokens else _split_long(text, self.max_tokens)
        for i, piece in enumerate(pieces):
            self.units.append(_Unit(piece, self.page, self.section(), joiner if i == 0 else " ", approx_tokens(piece)))

    def flush_para(self) -> None:
        if not self.para:
            return
        text = " ".join(s.strip() for s in self.para).strip()
        self.para.clear()
        for i, sent in enumerate(sentences(text) or [text]):
            self.add(sent, PARA if i == 0 else " ")

    def heading(self, marks: str, title: str) -> None:
        self.flush_para()
        level = len(marks)
        for lv in [lv for lv in self.headings if lv >= level]:
            del self.headings[lv]
        self.headings[level] = title
        self.units.append(_Unit(f"{marks} {title}", self.page, self.section(), PARA, approx_tokens(title)))

    def feed_page(self, page: PageText) -> None:
        self.page = page.page
        fence: list[str] | None = None
        for line in page.text.replace("\r\n", "\n").split("\n"):
            if FENCE_RE.match(line):
                if fence is not None:
                    fence.append(line)
                    self.add(LINE.join(fence), PARA)
                    fence = None
                else:
                    self.flush_para()
                    fence = [line]
                continue
            if fence is not None:
                fence.append(line)
                continue
            m = HEADING_RE.match(line)
            if m:
                self.heading(m.group(1), m.group(2).strip())
            elif not line.strip():
                self.flush_para()
            elif LIST_RE.match(line):
                self.flush_para()
                self.add(line.rstrip(), LINE)
            else:
                self.para.append(line)
        self.flush_para()
        if fence:
            self.add(LINE.join(fence), PARA)


def _units(pages: list[PageText], max_tokens: int) -> list[_Unit]:
    builder = _UnitBuilder(max_tokens)
    for page in pages:
        builder.feed_page(page)
    return builder.units


def _tokens(units: list[_Unit]) -> int:
    return sum(u.tokens for u in units)


def chunk_pages(pages: list[PageText], *, target_tokens: int = 350, overlap: float = 0.15) -> list[Chunk]:
    units = _units(pages, target_tokens)
    overlap_tokens = int(target_tokens * overlap)
    chunks: list[Chunk] = []

    def emit(body: list[_Unit]) -> None:
        # a chunk made only of headings carries no information
        if not body or all(u.text.startswith("#") for u in body):
            return
        text = body[0].text
        for u in body[1:]:
            text += u.joiner + u.text
        text = text.strip()
        if text:
            chunks.append(
                Chunk(
                    index=len(chunks),
                    content=text,
                    page=body[0].page,
                    section=body[-1].section or body[0].section,
                    token_count=approx_tokens(text),
                )
            )

    current: list[_Unit] = []
    fresh = 0  # units in `current` that are new (not overlap)
    for unit in units:
        if current and (unit.page != current[-1].page or unit.section != current[-1].section):
            if fresh:
                emit(current)
            current, fresh = [], 0
        if current and fresh and _tokens(current) + unit.tokens > target_tokens:
            emit(current)
            carry: list[_Unit] = []  # trailing sentences repeated as overlap
            for u in reversed(current):
                if _tokens(carry) + u.tokens > overlap_tokens:
                    break
                carry.insert(0, u)
            current, fresh = carry, 0
        current.append(unit)
        fresh += 1
    if current and fresh:
        emit(current)
    return chunks


def chunk_markdown(markdown: str, *, target_tokens: int = 350, overlap: float = 0.15) -> list[Chunk]:
    return chunk_pages([PageText(None, markdown)], target_tokens=target_tokens, overlap=overlap)
