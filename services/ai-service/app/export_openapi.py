"""Export the internal API's OpenAPI document (contracts §11.9).

    python -m app.export_openapi [path]      # default: <repo>/contracts/openapi/ai-internal.v1.json
    python -m app.export_openapi -           # print to stdout

Needs no configuration (no database, keys or network): the routers are mounted on a bare FastAPI app with
``AI_INSTANCE_ROLE=all``. The output is deterministic (sorted keys, 2-space indent, trailing newline) so CI can
fail when the committed file differs from the generated one.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI

from app.openapi import API_DESCRIPTION, API_TITLE, API_VERSION, build_openapi, operation_id
from app.routers import mount_routers

FILE_NAME = "ai-internal.v1.json"


def default_path() -> Path:
    """``<repo>/contracts/openapi/ai-internal.v1.json``; outside a checkout (e.g. in the image) the cwd."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "services" / "ai-service").is_dir():
            return parent / "contracts" / "openapi" / FILE_NAME
    return Path(FILE_NAME)


def document_app() -> FastAPI:
    app = FastAPI(
        title=API_TITLE, version=API_VERSION, description=API_DESCRIPTION, generate_unique_id_function=operation_id
    )
    mount_routers(app, "all")
    return app


def generate() -> dict[str, Any]:
    return build_openapi(document_app())


def render(spec: dict[str, Any]) -> str:
    return json.dumps(spec, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    text = render(generate())
    if args and args[0] == "-":
        sys.stdout.buffer.write(text.encode("utf-8"))
        return 0
    path = Path(args[0]) if args else default_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
