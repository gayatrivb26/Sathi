"""RFC 9457 ProblemDetails responses (contracts §4.1) and exception handlers.

Each failure is logged once, here at the boundary, with the error code and exception details.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from opentelemetry import trace
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.ids import reference_id
from app.logging import get_logger

log = get_logger(__name__)

PROBLEM_JSON = "application/problem+json"

# code -> (status, title, safe default detail)
ERROR_CATALOG: dict[str, tuple[int, str, str]] = {
    "VALIDATION_FAILED": (400, "Validation failed", "The request is not valid."),
    "AUTH_FORBIDDEN": (403, "Forbidden", "You are not allowed to do that."),
    "NOT_FOUND": (404, "Not found", "The resource was not found."),
    "CONFLICT": (409, "Conflict", "The request conflicts with the current state."),
    "RATE_LIMITED": (429, "Too many requests", "Please slow down and try again shortly."),
    "LLM_TIMEOUT": (504, "The AI took too long", "The AI tutor took too long to answer. Please try again."),
    "LLM_RATE_LIMITED": (503, "AI busy", "The AI tutor is busy right now. Please try again in a minute."),
    "LLM_UNAVAILABLE": (503, "AI unavailable", "The AI tutor is temporarily unavailable. Please try again."),
    "LLM_REFUSED": (422, "AI declined", "The AI tutor could not help with that request."),
    "LLM_DISABLED": (503, "AI disabled", "The AI tutor is switched off for maintenance."),
    "SPEND_CAP_REACHED": (503, "AI limit reached", "The AI tutor has reached today's usage limit."),
    "INGEST_PARSE_FAILED": (422, "Could not read the file", "We could not read this file."),
    "INGEST_NO_TEXT": (422, "No text found", "This file has no selectable text (it may be a scan)."),
    "INGEST_UNSUPPORTED_TYPE": (422, "Unsupported file type", "This file type is not supported."),
    "INGEST_INDEX_FAILED": (503, "Indexing failed", "We could not index this file. It will be retried."),
    "GRADING_FAILED": (502, "Grading failed", "The answer could not be graded automatically."),
    "QUIZ_GENERATION_FAILED": (502, "Generation failed", "Questions could not be generated."),
    "SERVICE_TOKEN_INVALID": (401, "Invalid service token", "The service token is missing or invalid."),
    "STORAGE_UNAVAILABLE": (503, "Storage unavailable", "File storage is temporarily unavailable."),
    "INTERNAL_ERROR": (500, "Internal error", "Something went wrong on our side."),
}


class AppError(Exception):
    """An error with a stable contract code. ``detail`` must be safe to show users."""

    def __init__(
        self,
        code: str,
        detail: str | None = None,
        *,
        status: int | None = None,
        internal: str | None = None,
        errors: dict[str, list[str]] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        default_status, title, default_detail = ERROR_CATALOG.get(code, (500, "Error", "Something went wrong."))
        self.code = code
        self.status = status or default_status
        self.title = title
        self.detail = detail or default_detail
        self.internal = internal  # logged, never returned
        self.errors = errors
        self.headers = headers
        super().__init__(f"{code}: {internal or self.detail}")


def current_trace_id() -> str | None:
    ctx = trace.get_current_span().get_span_context()
    return format(ctx.trace_id, "032x") if ctx.is_valid else None


def problem_body(
    code: str, status: int, title: str, detail: str, errors: dict[str, list[str]] | None = None
) -> dict[str, Any]:
    trace_id = current_trace_id()
    body: dict[str, Any] = {
        "type": f"https://sathi.app/errors/{code.lower().replace('_', '-')}",
        "title": title,
        "status": status,
        "detail": detail,
        "code": code,
        "traceId": trace_id,
        "referenceId": reference_id(trace_id),
    }
    if errors:
        body["errors"] = errors
    return body


def problem_response(err: AppError) -> JSONResponse:
    return JSONResponse(
        problem_body(err.code, err.status, err.title, err.detail, err.errors),
        status_code=err.status,
        media_type=PROBLEM_JSON,
        headers=err.headers,
    )


def _camel_path(loc: tuple[Any, ...]) -> str:
    parts = [str(p) for p in loc if p not in ("body", "query", "path", "header")]
    return ".".join(parts) or "body"


async def _app_error_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, AppError)
    level = "error" if exc.status >= 500 else "warning"
    getattr(log, level)(
        "http.error",
        message=f"{exc.code} on {request.method} {request.url.path}",
        error_code=exc.code,
        status=exc.status,
        exception_type=type(exc).__name__,
        exception_message=exc.internal or exc.detail,
    )
    return problem_response(exc)


async def _validation_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    errors: dict[str, list[str]] = {}
    for e in exc.errors():
        errors.setdefault(_camel_path(tuple(e.get("loc", ()))), []).append(str(e.get("msg", "invalid")))
    log.warning(
        "http.error",
        message=f"VALIDATION_FAILED on {request.method} {request.url.path}",
        error_code="VALIDATION_FAILED",
        status=400,
        fields=sorted(errors),
    )
    return problem_response(AppError("VALIDATION_FAILED", errors=errors))


async def _http_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)
    code = {404: "NOT_FOUND", 405: "NOT_FOUND", 401: "SERVICE_TOKEN_INVALID", 403: "AUTH_FORBIDDEN"}.get(
        exc.status_code, "INTERNAL_ERROR" if exc.status_code >= 500 else "VALIDATION_FAILED"
    )
    if exc.status_code >= 500:
        log.error("http.error", error_code=code, status=exc.status_code)
    return problem_response(AppError(code, status=exc.status_code))


async def _unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
    log.error(
        "http.unhandled",
        message=f"Unhandled error on {request.method} {request.url.path}",
        error_code="INTERNAL_ERROR",
        exc_info=exc,
    )
    return problem_response(AppError("INTERNAL_ERROR"))


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(AppError, _app_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(StarletteHTTPException, _http_handler)
    app.add_exception_handler(Exception, _unhandled_handler)
