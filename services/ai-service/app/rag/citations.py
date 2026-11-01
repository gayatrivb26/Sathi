"""Citation check: parse ``[n]`` markers, validate them against the supplied sources, strip invalid ones
and compute ``answer_basis`` (contracts §5.3)."""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field

MARKER_RE = re.compile(r"\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]")
# regions where [n] is not a citation: fenced code, inline code, display/inline maths
_PROTECTED_RE = re.compile(r"```.*?```|~~~.*?~~~|`[^`\n]*`|\$\$.*?\$\$|\$[^$\n]+\$", re.DOTALL)
GENERAL_MARKER = "General explanation (not from your course materials)"
BASIS_ORDER = ("course", "upload", "web", "general")


@dataclass
class DroppedCitation:
    index: int
    reason: str  # "unknown_source"


@dataclass
class CitationCheck:
    content: str
    valid: list[int] = field(default_factory=list)  # distinct valid indices, first-appearance order
    dropped: list[DroppedCitation] = field(default_factory=list)
    answer_basis: list[str] = field(default_factory=list)

    @property
    def valid_count(self) -> int:
        return len(self.valid)

    @property
    def dropped_count(self) -> int:
        return len(self.dropped)


def _protected_spans(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in _PROTECTED_RE.finditer(text)]


def _inside(pos: int, spans: list[tuple[int, int]]) -> bool:
    return any(a <= pos < b for a, b in spans)


def check_citations(text: str, source_types: dict[int, str]) -> CitationCheck:
    """``source_types`` maps each supplied source index to its type (course/upload/web)."""
    spans = _protected_spans(text)
    valid: list[int] = []
    dropped: list[DroppedCitation] = []

    def replace(m: re.Match[str]) -> str:
        if _inside(m.start(), spans):
            return m.group(0)
        nums = [int(n) for n in re.split(r"\s*,\s*", m.group(1))]
        keep = []
        for n in nums:
            if n in source_types:
                keep.append(n)
                if n not in valid:
                    valid.append(n)
            else:
                dropped.append(DroppedCitation(n, "unknown_source"))
        if not keep:
            return ""
        return "[" + ", ".join(str(n) for n in keep) + "]"

    cleaned = MARKER_RE.sub(replace, text)
    if dropped:
        cleaned = re.sub(r"[ \t]+([.,;:!?])", r"\1", cleaned)  # tidy space left before punctuation
        cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    basis = answer_basis((source_types[i] for i in valid), general=GENERAL_MARKER in text or not valid)
    return CitationCheck(content=cleaned, valid=valid, dropped=dropped, answer_basis=basis)


def answer_basis(types: Iterable[str], *, general: bool) -> list[str]:
    found = set(types)
    if general:
        found.add("general")
    return [t for t in BASIS_ORDER if t in found]
