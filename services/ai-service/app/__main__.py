"""Local runner: ``python -m app`` (uses a selector event loop on Windows, which psycopg async needs).

Containers use ``uvicorn app.main:app`` directly.
"""

from __future__ import annotations

import asyncio
import os
import sys

import uvicorn


def main() -> None:
    from app.main import create_app

    config = uvicorn.Config(
        create_app(),
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8000")),
        proxy_headers=True,
        log_config=None,
        loop="none",
    )
    server = uvicorn.Server(config)
    if sys.platform == "win32":
        asyncio.run(server.serve(), loop_factory=asyncio.SelectorEventLoop)
    else:
        asyncio.run(server.serve())


if __name__ == "__main__":
    main()
