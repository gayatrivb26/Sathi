"""Web search provider interface."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str = ""
    content: str | None = None  # full/extended text when the provider returns it (no fetch needed)
    score: float | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "url": self.url,
            "snippet": self.snippet,
            "content": self.content,
            "score": self.score,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> SearchResult:
        return cls(
            title=str(data.get("title") or ""),
            url=str(data.get("url") or ""),
            snippet=str(data.get("snippet") or ""),
            content=data.get("content"),
            score=data.get("score"),
        )


class SearchError(Exception):
    pass


class SearchProvider(Protocol):
    name: str
    cost_per_query: float
    fetch_pages: bool  # whether result pages should be fetched (fake results carry their content)

    async def search(self, query: str, max_results: int) -> list[SearchResult]: ...
