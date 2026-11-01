"""POST /internal/v1/eval/run: run golden datasets (also `python -m app.evaluation.runner`)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.container import Container
from app.deps import get_container
from app.evaluation.runner import EvaluationRunner
from app.openapi import internal
from app.schemas import EvalRunRequest, EvalRunResponse
from app.security import Principal, require_scope

router = APIRouter(prefix="/internal/v1", tags=["evaluation"])


@router.post(
    "/eval/run",
    response_model=EvalRunResponse,
    summary="Run the golden evaluation datasets",
    description="Runs `retrieval`, `tutor`, `injection`, `grading` or `all`; stores an evaluation run.",
    **internal("eval", 503),
)
async def run_eval(
    body: EvalRunRequest,
    _: Principal = Depends(require_scope("eval")),
    container: Container = Depends(get_container),
) -> EvalRunResponse:
    run_id, metrics = await EvaluationRunner(container).run(body.dataset)
    return EvalRunResponse(evaluation_run_id=run_id, metrics=metrics)
