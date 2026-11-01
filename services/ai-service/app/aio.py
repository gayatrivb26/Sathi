"""Small asyncio helpers for cancellation-safe cleanup."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Coroutine
from typing import Any

# Strong references to shielded cleanup tasks so they are not garbage-collected while the caller unwinds.
_background: set[asyncio.Task[Any]] = set()


async def shielded[T](coro: Coroutine[Any, Any, T]) -> T:
    """Run ``coro`` to completion even if the awaiting task is cancelled again meanwhile.

    Used for ledger writes during cancellation: the caller still sees ``CancelledError`` when it is cancelled
    a second time, but the write itself finishes in the background.
    """
    task: asyncio.Task[T] = asyncio.ensure_future(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)
    return await asyncio.shield(task)


async def aclose_quietly(iterator: AsyncIterator[Any]) -> None:
    """Close an async generator explicitly (so ``async with`` blocks inside it exit now, not at GC time)."""
    aclose = getattr(iterator, "aclose", None)
    if aclose is not None:
        await aclose()


async def drain_background(max_wait: float = 5.0) -> None:
    """Wait for pending shielded cleanup tasks (tests and shutdown)."""
    pending = [t for t in _background if not t.done()]
    if pending:
        await asyncio.wait(pending, timeout=max_wait)
