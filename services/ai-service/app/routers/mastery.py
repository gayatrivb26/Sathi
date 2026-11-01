"""Stateless mastery update and recommendations (contracts §7)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.mastery.mastery import update_mastery
from app.mastery.recommend import recommend
from app.openapi import internal
from app.schemas import (
    MasteryUpdateRequest,
    MasteryUpdateResponse,
    RecommendationRequest,
    RecommendationResponse,
)
from app.security import Principal, require_scope

router = APIRouter(prefix="/internal/v1", tags=["mastery"])


@router.post(
    "/mastery/update",
    response_model=MasteryUpdateResponse,
    summary="Update a concept mastery estimate after an answer",
    description="Stateless (contracts §7).",
    **internal("mastery"),
)
async def mastery_update(
    body: MasteryUpdateRequest, _: Principal = Depends(require_scope("mastery"))
) -> MasteryUpdateResponse:
    value = update_mastery(
        body.prior,
        attempts=body.attempts,
        correct=body.correct,
        difficulty=body.difficulty,
        score=body.score,
        diagnostic=body.diagnostic,
    )
    return MasteryUpdateResponse(mastery=value)


@router.post(
    "/recommendations",
    response_model=RecommendationResponse,
    summary="Recommend up to three next steps",
    description="Stateless (contracts §7): weak concepts, revision, next lesson, lesson check.",
    **internal("mastery"),
)
async def recommendations(
    body: RecommendationRequest, _: Principal = Depends(require_scope("mastery"))
) -> RecommendationResponse:
    return RecommendationResponse(items=recommend(body))
