"""Deterministic FakeSearchProvider: canned results that carry their own content (nothing is fetched)."""

from __future__ import annotations

from app.search.base import SearchError, SearchResult
from app.text import content_words


class FakeSearchProvider:
    name = "fake"
    fetch_pages = False
    cost_per_query = 0.0

    def __init__(self, results: list[SearchResult] | None = None, *, fail: bool = False) -> None:
        self._results = results
        self._fail = fail
        self.queries: list[str] = []

    async def search(self, query: str, max_results: int) -> list[SearchResult]:
        self.queries.append(query)
        if self._fail:
            raise SearchError("fake search failure")
        if self._results is not None:
            return self._results[:max_results]
        topic = " ".join(content_words(query)[:5]) or "the topic"
        slug = "-".join(content_words(query)[:5]) or "topic"
        return [
            SearchResult(
                title=f"{topic.title()} — Encyclopedia entry",
                url=f"https://en.wikipedia.org/wiki/{slug}",
                snippet=f"An overview of {topic}.",
                content=(
                    f"{topic.capitalize()} is a topic studied in computer science and statistics. "
                    f"Researchers describe {topic} using precise definitions and worked examples. "
                    f"A common way to learn {topic} is to start with a small example and generalise."
                ),
            ),
            SearchResult(
                title=f"A gentle tutorial on {topic}",
                url=f"https://example-tutorials.dev/{slug}",
                snippet=f"Tutorial about {topic}.",
                content=(
                    f"This tutorial introduces {topic} step by step. "
                    f"Practitioners apply {topic} when building machine learning systems."
                ),
            ),
        ][:max_results]
