"""HTML → clean text (title + main content, no scripts/navigation/boilerplate)."""

from __future__ import annotations

import re
from dataclasses import dataclass

from bs4 import BeautifulSoup, Tag

_DROP = [
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "iframe",
    "form",
    "nav",
    "footer",
    "header",
    "aside",
    "button",
    "input",
    "select",
    "object",
    "embed",
]
_BLOCK = {
    "p",
    "div",
    "section",
    "article",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "pre",
    "blockquote",
    "tr",
    "td",
    "th",
    "dd",
    "dt",
    "figcaption",
    "br",
}
MAX_TEXT = 200_000


@dataclass
class ExtractedPage:
    title: str
    text: str


def html_to_text(html: str) -> ExtractedPage:
    soup = BeautifulSoup(html, "html.parser")
    title = ""
    if soup.title and soup.title.string:
        title = " ".join(soup.title.string.split())
    for tag in soup(_DROP):
        tag.decompose()
    for tag in soup.find_all(attrs={"aria-hidden": "true"}):
        tag.decompose()
    for tag in soup.find_all(style=re.compile(r"display\s*:\s*none|visibility\s*:\s*hidden", re.I)):
        tag.decompose()  # hidden text is a classic prompt-injection hiding place
    found = soup.find("main") or soup.find("article") or soup.body
    root: Tag | BeautifulSoup = found if isinstance(found, Tag) else soup
    for tag in root.find_all(_BLOCK):
        tag.insert_before("\n")
        tag.insert_after("\n")
    text = root.get_text(" ")
    lines = [" ".join(line.split()) for line in text.split("\n")]
    cleaned = "\n".join(line for line in lines if len(line) > 1)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return ExtractedPage(title=title[:300], text=cleaned[:MAX_TEXT])


def plain_text(body: str) -> ExtractedPage:
    return ExtractedPage(title="", text=re.sub(r"\n{3,}", "\n\n", body.replace("\r\n", "\n"))[:MAX_TEXT])
