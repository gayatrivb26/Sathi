"""Redaction: seeded secrets, e-mails and keys never appear in logs (contracts §8)."""

from __future__ import annotations

import json

import httpx
import pytest

from app.logging import configure_logging, get_logger, redact_value, set_level
from tests.conftest import auth

SEEDED = {
    "secret": "SuperSecretPassw0rd!",
    "email": "student.one@example.org",
    "sk": "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV",
    "bearer": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk",
}


def _lines(out: str) -> list[dict[str, object]]:
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def test_redaction_of_keys_and_values(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging(service="ai-service", env="test", version="0.0.1", level="DEBUG")
    log = get_logger("test")
    log.info(
        "test.event",
        password=SEEDED["secret"],
        api_key=SEEDED["sk"],
        authorization=SEEDED["bearer"],
        note=f"contact {SEEDED['email']} with key {SEEDED['sk']}",
        nested={"cookie": "sathi.auth=abc", "list": [SEEDED["email"]]},
        input_tokens=42,
    )
    out = capsys.readouterr().out
    for value in SEEDED.values():
        assert value not in out
    assert "sathi.auth=abc" not in out
    line = _lines(out)[-1]
    assert line["input_tokens"] == 42  # numeric token counts are not secrets
    for field in ("timestamp", "level", "message", "service", "env", "version", "trace_id", "span_id", "request_id"):
        assert field in line
    assert line["level"] == "info"
    assert line["event"] == "test.event"
    assert line["service"] == "ai-service"


def test_exception_stack_is_redacted(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging(service="ai-service", env="test", version="0.0.1", level="DEBUG")
    log = get_logger("test")
    try:
        raise ValueError(f"bad key {SEEDED['sk']} for {SEEDED['email']}")
    except ValueError as exc:
        log.error("test.failure", exc_info=exc)
    out = capsys.readouterr().out
    assert SEEDED["sk"] not in out
    assert SEEDED["email"] not in out
    line = _lines(out)[-1]
    assert line["exception_type"] == "ValueError"
    assert "stack" in line


def test_runtime_level_switch(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging(service="ai-service", env="test", version="0.0.1", level="INFO")
    log = get_logger("test")
    log.debug("hidden.debug")
    set_level("DEBUG")
    log.debug("visible.debug")
    set_level("INFO")
    out = capsys.readouterr().out
    assert "hidden.debug" not in out
    assert "visible.debug" in out


def test_redact_value_patterns() -> None:
    assert "[REDACTED]" in redact_value("mail me at a.b@c.io")
    assert redact_value("plain text") == "plain text"


async def test_seeded_secret_in_request_body_never_logged(
    nodb_client: httpx.AsyncClient, capsys: pytest.CaptureFixture[str]
) -> None:
    body = {
        "questionStem": "What is a gradient?",
        "rubric": {"version": 1, "criteria": [{"id": "c1", "description": "slope", "points": 2}], "modelAnswer": "x"},
        "answerText": f"My password is {SEEDED['secret']} and email {SEEDED['email']} key {SEEDED['sk']}",
    }
    configure_logging(service="ai-service", env="test", version="0.0.1", level="DEBUG")  # bind to captured stdout
    r = await nodb_client.post("/internal/v1/grade", json=body, headers=auth(scopes="grade"))
    assert r.status_code == 200
    out = capsys.readouterr().out
    assert out  # something was logged (http.request, llm.call, grading.completed)
    for value in (SEEDED["secret"], SEEDED["email"], SEEDED["sk"]):
        assert value not in out
    events = {line.get("event") for line in _lines(out)}
    assert {"http.request", "llm.call", "grading.completed"} <= events
