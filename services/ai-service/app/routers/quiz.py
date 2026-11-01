"""POST /internal/v1/quiz/generate."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends

from app.container import Container
from app.deps import get_container, header_run_id
from app.openapi import internal
from app.schemas import QuizGenerateRequest, QuizGenerateResponse
from app.security import Principal, require_scope

router = APIRouter(prefix="/internal/v1", tags=["quiz"])


@router.post(
    "/quiz/generate",
    response_model=QuizGenerateResponse,
    summary="Generate multiple-choice questions for a concept",
    description="Grounded in course retrieval (token `rscope`); exactly one correct option per question.",
    **internal("quiz", 422, 502, 503, 504),
)
async def generate(
    body: QuizGenerateRequest,
    principal: Principal = Depends(require_scope("quiz")),
    container: Container = Depends(get_container),
    run_id: uuid.UUID | None = Depends(header_run_id),
) -> QuizGenerateResponse:
    return await container.quiz.generate(body, principal, run_id)
