"""OpenAPI document of the internal API (contracts §6, §11.9).

``build_openapi(app)`` is used both for the live ``/openapi.json`` (non-production) and by
``python -m app.export_openapi``, which writes the committed ``contracts/openapi/ai-internal.v1.json``.

Post-processing on top of FastAPI's generator:

* every error response is ``application/problem+json`` with the ``ProblemDetails`` schema, and FastAPI's
  automatic ``422 HTTPValidationError`` is dropped (validation failures are ``400 VALIDATION_FAILED``);
* the ``serviceToken`` bearer scheme (RS256 JWT, contracts §11.7) and an ``x-required-scope`` per operation;
* the tutor SSE payload schemas (``x-sse-events`` on the stream operation, contracts §6.1).
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from fastapi.routing import APIRoute
from pydantic.alias_generators import to_camel
from pydantic.json_schema import models_json_schema

from app.schemas import SSE_EVENTS, ProblemDetails

API_TITLE = "Sathi AI service — internal API"
API_VERSION = "1.0.0"  # contract version of /internal/v1 (not the build version), keeps the export stable
API_DESCRIPTION = (
    "Private API called only by the .NET `api` and `jobs` services (contracts §6). Every `/internal/v1` call "
    "needs `Authorization: Bearer <service token>`: an RS256 JWT (`kid` header) with `iss` sathi-api|sathi-jobs, "
    "`aud` ai-service, `sub`, `uh`, `scp` (space-separated scopes), `rscope` (retrieval scope), `rid`, `iat`, "
    "`exp`. Also send `traceparent`, `X-Request-Id` and `X-Run-Id`. Errors are RFC 9457 ProblemDetails."
)
PROBLEM_JSON = "application/problem+json"
PROBLEM_REF = "#/components/schemas/ProblemDetails"
SECURITY_SCHEME = "serviceToken"

ERROR_DESCRIPTIONS: dict[int, str] = {
    400: "VALIDATION_FAILED — the request body or parameters are invalid (`errors` lists the fields).",
    401: "SERVICE_TOKEN_INVALID — missing, expired, wrongly signed or wrong-audience service token.",
    403: "AUTH_FORBIDDEN — the token lacks the required scope.",
    404: "NOT_FOUND — the resource (or stored file) does not exist.",
    422: "The content could not be processed (INGEST_PARSE_FAILED, INGEST_NO_TEXT, INGEST_UNSUPPORTED_TYPE, "
    "LLM_REFUSED).",
    500: "INTERNAL_ERROR.",
    502: "The model output could not be used (GRADING_FAILED, QUIZ_GENERATION_FAILED).",
    503: "A dependency is unavailable (LLM_UNAVAILABLE, LLM_RATE_LIMITED, LLM_DISABLED, SPEND_CAP_REACHED, "
    "STORAGE_UNAVAILABLE, INGEST_INDEX_FAILED).",
    504: "LLM_TIMEOUT — the model took too long.",
}
BASE_ERRORS = (400, 401, 403, 500)


def problem_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    return {s: {"model": ProblemDetails, "description": ERROR_DESCRIPTIONS[s]} for s in sorted(set(statuses))}


def internal(scope: str, *errors: int) -> dict[str, Any]:
    """Decorator kwargs for an ``/internal/v1`` route: error responses, bearer security and required scope."""
    return {
        "responses": problem_responses(*BASE_ERRORS, *errors),
        "openapi_extra": {"security": [{SECURITY_SCHEME: []}], "x-required-scope": scope},
    }


def operation_id(route: APIRoute) -> str:
    return to_camel(route.name)


def _problem_content() -> dict[str, Any]:
    return {PROBLEM_JSON: {"schema": {"$ref": PROBLEM_REF}}}


def _sse_schemas() -> tuple[dict[str, Any], dict[str, Any]]:
    """Component schemas for the SSE payload models and the ``x-sse-events`` map (event → $ref)."""
    models = [(model, "serialization") for model in SSE_EVENTS.values()]
    key_map, defs = models_json_schema(models, ref_template="#/components/schemas/{model}")  # type: ignore[arg-type]
    events = {name: key_map[(model, "serialization")] for name, model in SSE_EVENTS.items()}
    return defs.get("$defs", {}), events


def build_openapi(app: FastAPI) -> dict[str, Any]:
    spec = get_openapi(title=API_TITLE, version=API_VERSION, description=API_DESCRIPTION, routes=app.routes)
    components = spec.setdefault("components", {})
    schemas: dict[str, Any] = components.setdefault("schemas", {})

    for item in spec.get("paths", {}).values():
        for operation in item.values():
            responses: dict[str, Any] = operation.get("responses", {})
            auto_422 = responses.get("422", {})
            if auto_422.get("description") == "Validation Error":
                del responses["422"]  # FastAPI's default; our validation errors are 400 ProblemDetails
            for response in responses.values():
                schema = response.get("content", {}).get("application/json", {}).get("schema", {})
                if schema.get("$ref") == PROBLEM_REF:
                    response["content"] = _problem_content()

    for unused in ("HTTPValidationError", "ValidationError"):
        schemas.pop(unused, None)

    sse_defs, sse_events = _sse_schemas()
    for name, schema in sse_defs.items():
        schemas.setdefault(name, schema)
    stream_op = spec.get("paths", {}).get("/internal/v1/tutor/stream", {}).get("post")
    if stream_op is not None:
        stream_op["responses"]["200"]["x-sse-events"] = sse_events

    components["securitySchemes"] = {
        SECURITY_SCHEME: {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "JWT",
            "description": "RS256 service token signed by api/jobs (contracts §11.7); verified with "
            "SERVICE_TOKEN_PUBLIC_KEYS by kid.",
        }
    }
    return spec


def install_openapi(app: FastAPI) -> None:
    """Serve the post-processed document at ``/openapi.json``."""

    def openapi() -> dict[str, Any]:
        if app.openapi_schema is None:
            app.openapi_schema = build_openapi(app)
        return app.openapi_schema

    app.openapi = openapi  # type: ignore[method-assign]
