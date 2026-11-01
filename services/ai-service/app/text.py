"""Small text utilities shared by chunking, retrieval, search and the fake providers."""

from __future__ import annotations

import re

WORD_RE = re.compile(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*")
TOKEN_RE = re.compile(r"\w+|[^\w\s]", re.UNICODE)
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[$])")

STOPWORDS = frozenset(
    (
        "a",
        "about",
        "above",
        "after",
        "again",
        "against",
        "all",
        "am",
        "an",
        "and",
        "any",
        "are",
        "as",
        "at",
        "be",
        "because",
        "been",
        "before",
        "being",
        "below",
        "between",
        "both",
        "but",
        "by",
        "can",
        "could",
        "did",
        "do",
        "does",
        "doing",
        "down",
        "during",
        "each",
        "few",
        "for",
        "from",
        "further",
        "had",
        "has",
        "have",
        "having",
        "he",
        "her",
        "here",
        "hers",
        "herself",
        "him",
        "himself",
        "his",
        "how",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "itself",
        "just",
        "me",
        "more",
        "most",
        "my",
        "myself",
        "no",
        "nor",
        "not",
        "now",
        "of",
        "off",
        "on",
        "once",
        "only",
        "or",
        "other",
        "our",
        "ours",
        "ourselves",
        "out",
        "over",
        "own",
        "same",
        "she",
        "should",
        "so",
        "some",
        "such",
        "than",
        "that",
        "the",
        "their",
        "theirs",
        "them",
        "themselves",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "through",
        "to",
        "too",
        "under",
        "until",
        "up",
        "very",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "while",
        "who",
        "whom",
        "why",
        "will",
        "with",
        "would",
        "you",
        "your",
        "yours",
        "yourself",
        "yourselves",
        "explain",
        "tell",
        "please",
        "give",
        "show",
        "describe",
        "mean",
        "means",
        "meaning",
        "define",
        "definition",
        "simple",
        "simply",
        "example",
        "examples",
        "help",
        "understand",
        "know",
        "want",
        "like",
        "also",
        "use",
        "used",
        "using",
        "get",
        "got",
        "make",
        "much",
        "many",
        "way",
        "ways",
        "thing",
        "things",
        "really",
        "can't",
        "don't",
        "doesn't",
        "isn't",
        "what's",
        "whats",
    )
)

# Phrases that look like instructions aimed at the model (prompt-injection heuristics).
INJECTION_RE = re.compile(
    r"(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)*(previous|prior|above|earlier|system)"
    r"|ignora\s+todas|instrucci\S{1,2}n\s+oculta|system\s*prompt|system\s+(notice|override|message)"
    r"|developer\s+message|you\s+are\s+now|new\s+instructions?|act\s+as\s+(an?\s+)?"
    r"|reveal\s+(your|the)\s+(instructions|prompt|rules)|jailbr(eak|oken)|do\s+anything\s+now|\bDAN\b"
    r"|</?\s*(system|assistant|instructions?|sources?|source|passages?)\s*>|<!--"
    r"|\b(assistant|ai\s+agents?|ai\s+assistants?|note\s+to\s+the\s+model)\b[^.\n]{0,40}[:,]"
    r"|you\s+must\s+(reply|respond|say|answer|include|print|output|tell)"
    r"|(reply|respond|answer)\s+with\s+only|\b(say|print|output|respond\s+with|reply\s+with)\s+[\"'“]"
    r"|tell\s+the\s+student|before\s+(helping|answering)|!\[[^\]]*\]\(https?://"
    r"|\b(password|passcode|credentials?)\b"
    r"|give\s+(me\s+)?(full|maximum|max|all)\s+(marks|points|score)",
    re.IGNORECASE,
)


def words(text: str) -> list[str]:
    return [w.lower() for w in WORD_RE.findall(text)]


def content_words(text: str) -> list[str]:
    return [w for w in words(text) if w not in STOPWORDS and len(w) > 1]


def approx_tokens(text: str) -> int:
    """Rough token estimate (word pieces + punctuation) used for chunk sizing."""
    return int(len(TOKEN_RE.findall(text)) * 1.15) + 1


def sentences(text: str) -> list[str]:
    parts = [p.strip() for p in SENTENCE_RE.split(text.strip()) if p.strip()]
    return parts


def looks_like_injection(text: str) -> bool:
    return bool(INJECTION_RE.search(text))


def overlap_score(query: str, text: str) -> float:
    q = set(content_words(query))
    if not q:
        return 0.0
    t = set(content_words(text))
    return len(q & t) / len(q)


_EXERCISE_SECTION_RE = re.compile(
    r"^#{1,6}\s*(check yourself|common mistakes)\b.*?(?=^#{1,6}\s|\Z)", re.IGNORECASE | re.MULTILINE | re.DOTALL
)
_MD_HEADING_RE = re.compile(r"^#{1,6}\s*", re.MULTILINE)
_MD_EMPHASIS_RE = re.compile(r"(\*\*|__|`)")


def drop_exercise_sections(markdown: str) -> str:
    """Remove "Check yourself" / "Common mistakes" sections (questions and pitfalls, not explanations)."""
    return _EXERCISE_SECTION_RE.sub("", markdown)


def plain_snippet(text: str, limit: int) -> str:
    """A short display snippet: markdown headings, emphasis and inline-math dollar signs removed."""
    text = _MD_EMPHASIS_RE.sub("", _MD_HEADING_RE.sub("", text)).replace("$", "")
    return truncate(text, limit)


def truncate(text: str, limit: int) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0]
    return cut + "…"
