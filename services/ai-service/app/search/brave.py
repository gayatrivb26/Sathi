"""Brave Search API (https://api.search.brave.com)."""

from __future__ import annotations

import re

import httpx

from app.search.base import SearchError, SearchResult

_TAGS = re.compile(r"<[^>]+>")


class BraveSearchProvider:
    name = "brave"
    fetch_pages = True
    URL = "https://api.search.brave.com/res/v1/web/search"

    def __init__(
        self,
        api_key: str,
        *,
        timeout: float = 6.0,
        cost_per_query: float = 0.005,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._key = api_key
        self._timeout = timeout
        self.cost_per_query = cost_per_query
        self._client = client

    async def search(self, query: str, max_results: int) -> list[SearchResult]:
        params: dict[str, str | int] = {"q": query, "count": max_results, "safesearch": "strict"}
        headers = {"X-Subscription-Token": self._key, "Accept": "application/json"}
        try:
            if self._client is not None:
                resp = await self._client.get(self.URL, params=params, headers=headers, timeout=self._timeout)
            else:
                async with httpx.AsyncClient(timeout=self._timeout, trust_env=False) as client:
                    resp = await client.get(self.URL, params=params, headers=headers)
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise SearchError(f"brave: {type(exc).__name__}") from exc
        results = []
        for item in (data.get("web") or {}).get("results") or []:
            url = str(item.get("url") or "")
            if url:
                results.append(
                    SearchResult(
                        title=_TAGS.sub("", str(item.get("title") or url)),
                        url=url,
                        snippet=_TAGS.sub("", str(item.get("description") or ""))[:1000],
                    )
                )
        return results[:max_results]
