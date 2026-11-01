"""Output guard for the final tutor answer (defence in depth against prompt injection).

* Markdown images with remote URLs are removed (tracking-pixel / data-exfiltration channel).
* Links and bare URLs are kept only when they point at a supplied web source page or appear in trusted
  (course/upload) material; anything else is replaced by ``[link removed]``.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

from app.tutor.prompting import SourceItem

_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(\s*<?(?:https?:)?//[^)]*\)")
_LINK_RE = re.compile(r"\[([^\]]+)\]\(\s*<?((?:https?:)?//[^)\s>]+)>?[^)]*\)")
_URL_RE = re.compile(r"(?:https?://|www\.)[^\s)\]>\"'`]+", re.IGNORECASE)
REMOVED = "[link removed]"


@dataclass
class GuardResult:
    text: str
    removed_images: int
    removed_links: int


def _norm(url: str) -> str:
    url = url.strip().rstrip(".,;:!?").lower()
    url = re.sub(r"^https?://", "", url)
    url = re.sub(r"^www\.", "", url)
    return url.rstrip("/")


def allowed_urls(sources: Iterable[SourceItem]) -> set[str]:
    allowed: set[str] = set()
    for s in sources:
        if s.url:
            allowed.add(_norm(s.url))
        if s.source_type in ("course", "upload"):
            allowed.update(_norm(u) for u in _URL_RE.findall(s.content))
    return allowed


def guard_output(text: str, sources: Iterable[SourceItem]) -> GuardResult:
    allowed = allowed_urls(sources)
    images = len(_IMAGE_RE.findall(text))
    text = _IMAGE_RE.sub("", text)
    removed = 0

    def link(m: re.Match[str]) -> str:
        nonlocal removed
        if _norm(m.group(2)) in allowed:
            return m.group(0)
        removed += 1
        return f"{m.group(1)} {REMOVED}"

    text = _LINK_RE.sub(link, text)

    def bare(m: re.Match[str]) -> str:
        nonlocal removed
        if _norm(m.group(0)) in allowed:
            return m.group(0)
        removed += 1
        return REMOVED

    # skip URLs already kept inside markdown links: only replace bare ones
    parts = re.split(r"(\[[^\]]+\]\([^)]*\))", text)
    text = "".join(p if p.startswith("[") and "](" in p else _URL_RE.sub(bare, p) for p in parts)
    return GuardResult(text=text, removed_images=images, removed_links=removed)
