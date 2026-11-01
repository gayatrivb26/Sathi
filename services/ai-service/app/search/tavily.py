"""Tavily search API (https://docs.tavily.com)."""

from __future__ import annotations

import httpx

from app.search.base import SearchError, SearchResult


class TavilySearchProvider:
    name = "tavily"
    fetch_pages = True
    URL = "https://api.tavily.com/search"

    def __init__(
        self,
        api_key: str,
        *,
        timeout: float = 6.0,
        cost_per_query: float = 0.008,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._key = api_key
        self._timeout = timeout
        self.cost_per_query = cost_per_query
        self._client = client

    async def search(self, query: str, max_results: int) -> list[SearchResult]:
        body = {"query": query, "max_results": max_results, "search_depth": "basic", "include_answer": False}
        headers = {"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}
        try:
            if self._client is not None:
                resp = await self._client.post(self.URL, json=body, headers=headers, timeout=self._timeout)
            else:
                async with httpx.AsyncClient(timeout=self._timeout, trust_env=False) as client:
                    resp = await client.post(self.URL, json=body, headers=headers)
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise SearchError(f"tavily: {type(exc).__name__}") from exc
        results = []
        for item in data.get("results") or []:
            url = str(item.get("url") or "")
            if url:
                results.append(
                    SearchResult(
                        title=str(item.get("title") or url),
                        url=url,
                        snippet=str(item.get("content") or "")[:1000],
                        score=item.get("score"),
                    )
                )
        return results[:max_results]
