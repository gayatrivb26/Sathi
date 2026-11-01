"""Structured JSON logging per contracts §8: structlog → stdlib → stdout (and OTLP when enabled).

* Required fields on every line: timestamp, level, message, service, env, version, trace_id, span_id,
  request_id, user_id_hash (when known). `event` carries the dotted event name (e.g. ``llm.call``).
* A redaction processor masks sensitive keys and secret-looking values everywhere (incl. stack traces).
* The minimum level can be changed at runtime (``PUT /internal/v1/admin/log-level``).
"""

from __future__ import annotations

import logging
import re
import sys
import traceback
from collections.abc import Mapping, MutableMapping
from typing import Any

import structlog
from structlog.types import EventDict, Processor, WrappedLogger

_LEVELS = {"DEBUG": logging.DEBUG, "INFO": logging.INFO, "WARNING": logging.WARNING, "ERROR": logging.ERROR}
_state: dict[str, Any] = {"level": logging.INFO, "static": {}}

REDACTED = "[REDACTED]"
SENSITIVE_KEY = re.compile(r"password|secret|token|authorization|cookie|api[_-]?key|email", re.IGNORECASE)
# keys that match SENSITIVE_KEY but only ever carry counts / hashes (never secrets)
_SAFE_KEYS = {"token_count", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"}
_VALUE_PATTERNS = [
    re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),  # e-mail
    re.compile(r"(?i)bearer\s+[A-Za-z0-9\-._~+/]+=*"),  # bearer tokens
    re.compile(r"\bsk-[A-Za-z0-9_\-]{6,}"),  # sk- API keys (Anthropic/OpenAI style)
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]*"),  # JWTs
    re.compile(r"(?i)\b(tvly|BSA)[-_][A-Za-z0-9]{12,}"),  # search API keys
]


def redact_value(value: Any) -> Any:
    if isinstance(value, str):
        for pattern in _VALUE_PATTERNS:
            value = pattern.sub(REDACTED, value)
        return value
    if isinstance(value, Mapping):
        return _redact_mapping(value)
    if isinstance(value, (list, tuple, set)):
        return [redact_value(v) for v in value]
    return value


def _redact_mapping(data: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in data.items():
        k = str(key)
        if (
            SENSITIVE_KEY.search(k)
            and k not in _SAFE_KEYS
            and not isinstance(value, (bool, int, float))
            and value is not None
        ):
            out[k] = REDACTED
        else:
            out[k] = redact_value(value)
    return out


def redact_processor(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    record = event_dict.pop("_record", None)
    from_structlog = event_dict.pop("_from_structlog", None)
    redacted = _redact_mapping(event_dict)
    event_dict.clear()
    event_dict.update(redacted)
    if record is not None:
        event_dict["_record"] = record
    if from_structlog is not None:
        event_dict["_from_structlog"] = from_structlog
    return event_dict


def _level_filter(_: WrappedLogger, method_name: str, event_dict: EventDict) -> EventDict:
    name = "WARNING" if method_name in ("warn", "warning") else method_name.upper()
    level = _LEVELS.get(name, logging.ERROR if name in ("EXCEPTION", "CRITICAL") else logging.INFO)
    if level < _state["level"]:
        raise structlog.DropEvent
    return event_dict


def _normalise_level(_: WrappedLogger, method_name: str, event_dict: EventDict) -> EventDict:
    level = str(event_dict.get("level", method_name)).lower()
    event_dict["level"] = {"warn": "warning", "exception": "error", "critical": "error"}.get(level, level)
    return event_dict


def _static_fields(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    for k, v in _state["static"].items():
        event_dict.setdefault(k, v)
    return event_dict


def _trace_fields(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    try:
        from opentelemetry import trace

        ctx = trace.get_current_span().get_span_context()
        if ctx.is_valid:
            event_dict.setdefault("trace_id", format(ctx.trace_id, "032x"))
            event_dict.setdefault("span_id", format(ctx.span_id, "016x"))
    except Exception:  # noqa: S110 - logging must never fail
        pass
    event_dict.setdefault("trace_id", None)
    event_dict.setdefault("span_id", None)
    event_dict.setdefault("request_id", None)
    return event_dict


def _message_field(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    record = event_dict.get("_record")
    if record is not None and not event_dict.get("_from_structlog", False):
        # foreign (stdlib) record: event = logger name, message = text
        event_dict["message"] = str(event_dict.get("event", ""))
        event_dict["event"] = f"log.{record.name}"
    else:
        event_dict.setdefault("message", event_dict.get("event"))
    return event_dict


def _exception_fields(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    exc_info = event_dict.pop("exc_info", None)
    if exc_info:
        if exc_info is True:
            exc_info = sys.exc_info()
        elif isinstance(exc_info, BaseException):
            exc_info = (type(exc_info), exc_info, exc_info.__traceback__)
        if isinstance(exc_info, tuple) and exc_info[0] is not None:
            etype, evalue, tb = exc_info
            event_dict.setdefault("exception_type", etype.__name__)
            event_dict.setdefault("exception_message", str(evalue)[:2000])
            event_dict["stack"] = "".join(traceback.format_exception(etype, evalue, tb))[-8000:]
    return event_dict


def shared_processors() -> list[Processor]:
    return [
        structlog.contextvars.merge_contextvars,
        _static_fields,
        _trace_fields,
        structlog.processors.TimeStamper(fmt="iso", utc=True, key="timestamp"),
        _exception_fields,
        _message_field,
        redact_processor,
    ]


def configure_logging(*, service: str, env: str, version: str, level: str = "INFO") -> None:
    _state["static"] = {"service": service, "env": env, "version": version}
    set_level(level)

    renderer = structlog.processors.JSONRenderer(sort_keys=False)
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=[structlog.stdlib.add_log_level, _normalise_level, *shared_processors()],
        processors=[structlog.stdlib.ProcessorFormatter.remove_processors_meta, renderer],
    )
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    handler.set_name("sathi-stdout")
    root = logging.getLogger()
    for h in list(root.handlers):
        if h.get_name() == "sathi-stdout":
            root.removeHandler(h)
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    for noisy in ("httpx", "httpcore", "httpx2", "botocore", "boto3", "urllib3", "anthropic"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    for name in ("uvicorn", "uvicorn.error"):  # route uvicorn's own lines through the JSON handler
        uv_logger = logging.getLogger(name)
        uv_logger.handlers.clear()
        uv_logger.propagate = True
    logging.getLogger("uvicorn.access").disabled = True  # we log http.request ourselves

    structlog.configure(
        processors=[
            _level_filter,
            structlog.stdlib.add_log_level,
            _normalise_level,
            *shared_processors(),
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=False,
    )


def json_formatter() -> logging.Formatter:
    return structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=[structlog.stdlib.add_log_level, _normalise_level, *shared_processors()],
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.JSONRenderer(),
        ],
    )


def set_level(level: str) -> None:
    name = level.upper()
    if name not in _LEVELS:
        raise ValueError(f"unknown log level {level!r}")
    _state["level"] = _LEVELS[name]
    for h in logging.getLogger().handlers:
        h.setLevel(_LEVELS[name])


def current_level() -> str:
    return next(k for k, v in _LEVELS.items() if v == _state["level"])


def bind(**values: Any) -> None:
    structlog.contextvars.bind_contextvars(**{k: v for k, v in values.items() if v is not None})


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    logger: structlog.stdlib.BoundLogger = structlog.stdlib.get_logger(name)
    return logger


def context_snapshot() -> MutableMapping[str, Any]:
    return structlog.contextvars.get_contextvars()
