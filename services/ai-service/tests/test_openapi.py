"""The committed OpenAPI document matches the code, and the documented SSE/error shapes match reality."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from pydantic import BaseModel

from app.export_openapi import default_path, generate, main, render
from app.openapi import PROBLEM_JSON, PROBLEM_REF
from app.schemas import SSE_EVENTS, ProblemDetails
from tests.conftest import COURSE_X, REPO_ROOT, auth, parse_sse

COMMITTED = REPO_ROOT / "contracts" / "openapi" / "ai-internal.v1.json"


def test_committed_document_matches_generated_output() -> None:
    assert default_path() == COMMITTED
    assert COMMITTED.exists(), "run `python -m app.export_openapi` and commit the file"
    expected = render(generate())
    actual = COMMITTED.read_text(encoding="utf-8")
    assert actual == expected, "contracts/openapi/ai-internal.v1.json is stale: run `python -m app.export_openapi`"


def test_export_is_deterministic(tmp_path: Any) -> None:
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    assert main([str(a)]) == 0 and main([str(b)]) == 0
    assert a.read_bytes() == b.read_bytes()
    assert a.read_text(encoding="utf-8").endswith("}\n")


def test_document_describes_auth_errors_and_operations() -> None:
    spec = generate()
    assert spec["openapi"].startswith("3.")
    assert spec["info"]["version"] == "1.0.0"
    assert spec["components"]["securitySchemes"]["serviceToken"]["scheme"] == "bearer"
    assert "HTTPValidationError" not in spec["components"]["schemas"]
    operation_ids: set[str] = set()
    for path, item in spec["paths"].items():
        for method, op in item.items():
            assert op.get("summary"), f"{method} {path} needs a summary"
            assert op["operationId"] not in operation_ids
            operation_ids.add(op["operationId"])
            responses = op["responses"]
            ok = [s for s in responses if s.startswith("2")]
            assert ok, f"{method} {path} has no success response"
            if path.startswith("/internal/"):
                assert op["security"] == [{"serviceToken": []}]
                assert op["x-required-scope"]
                for status in ("400", "401", "403", "500"):
                    assert responses[status]["content"] == {PROBLEM_JSON: {"schema": {"$ref": PROBLEM_REF}}}
                if "422" in responses:
                    assert PROBLEM_JSON in responses["422"]["content"]
                if ok == ["200"]:
                    content = responses["200"].get("content", {})
                    assert content, f"{method} {path} documents no response body"
    stream = spec["paths"]["/internal/v1/tutor/stream"]["post"]
    assert "text/event-stream" in stream["responses"]["200"]["content"]
    assert set(stream["responses"]["200"]["x-sse-events"]) == set(SSE_EVENTS)
    assert spec["paths"]["/internal/v1/runs/{run_id}"]["get"]["responses"]["200"]["content"]["application/json"][
        "schema"
    ] == {"$ref": "#/components/schemas/InternalRunDetail"}


def _check_shape(model: type[BaseModel], data: dict[str, Any]) -> None:
    """``data`` validates against the documented model and carries no undocumented keys."""
    model.model_validate(data)
    documented = {f.alias or name for name, f in model.model_fields.items()}
    assert set(data) <= documented, (model.__name__, set(data) - documented)


async def test_sse_payloads_match_documented_models(nodb_client: httpx.AsyncClient) -> None:
    body = {
        "runId": "00000000-0000-0000-0000-000000000123",
        "conversationId": "00000000-0000-0000-0000-000000000456",
        "course": {"id": str(COURSE_X), "title": "AI Engineering"},
        "question": "What is attention?",
        "webSearch": True,
    }
    r = await nodb_client.post("/internal/v1/tutor/stream", json=body, headers=auth(scopes="tutor"))
    events = parse_sse(r.text)
    assert {n for n, _ in events} >= {"status", "token", "usage", "done"}
    for name, data in events:
        _check_shape(SSE_EVENTS[name], data)


async def test_error_responses_match_problem_details(nodb_client: httpx.AsyncClient) -> None:
    r = await nodb_client.post("/internal/v1/mastery/update", json={"correct": "maybe"}, headers=auth(scopes="mastery"))
    assert r.status_code == 400 and r.headers["content-type"].startswith(PROBLEM_JSON)
    _check_shape(ProblemDetails, r.json())
    r = await nodb_client.post("/internal/v1/mastery/update", json={"correct": True})
    assert r.status_code == 401
    _check_shape(ProblemDetails, r.json())


@pytest.mark.parametrize("path", ["/openapi.json"])
async def test_live_document_matches_export_for_role_all(nodb_client: httpx.AsyncClient, path: str) -> None:
    live = (await nodb_client.get(path)).json()
    assert json.loads(render(live)) == json.loads(render(generate()))
