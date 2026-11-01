"""POST /internal/v1/grade."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends

from app.container import Container
from app.deps import get_container, header_run_id
from app.openapi import internal
from app.schemas import GradeRequest, GradeResponse
from app.security import Principal, require_scope

router = APIRouter(prefix="/internal/v1", tags=["grading"])


@router.post(
    "/grade",
    response_model=GradeResponse,
    summary="Grade a short answer against a rubric",
    description="The learner's answer is passed to the model as quoted data, never as instructions.",
    **internal("grade", 422, 502, 503, 504),
)
async def grade(
    body: GradeRequest,
    _: Principal = Depends(require_scope("grade")),
    container: Container = Depends(get_container),
    run_id: uuid.UUID | None = Depends(header_run_id),
) -> GradeResponse:
    return await container.grader.grade(body, run_id)
