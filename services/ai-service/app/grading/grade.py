"""Rubric grading of short answers. The learner's answer is passed as quoted data, never instructions.

Business rules after structured output: one score per rubric criterion, 0 ≤ points ≤ criterion max,
score = Σ points ≤ max_score. Repairs (clamped/missing criteria) lower the confidence so the result is
routed to instructor review.
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel, Field

from app.config import Settings
from app.errors import AppError
from app.llm.base import LlmError, LlmRequest
from app.llm.router import LlmRouter
from app.logging import get_logger
from app.prompts import PromptLibrary
from app.schemas import CriterionScore, GradeRequest, GradeResponse
from app.text import looks_like_injection
from app.tutor.prompting import quote_data

log = get_logger(__name__)


class LlmCriterionScore(BaseModel):
    id: str
    points: float
    comment: str


class LlmGrade(BaseModel):
    criteria_scores: list[LlmCriterionScore]
    feedback: str
    confidence: float = Field(description="0 to 1")


def apply_rubric(req: GradeRequest, parsed: LlmGrade) -> tuple[list[CriterionScore], float, float, float, bool]:
    """Return (criteria scores, score, max_score, confidence, repaired)."""
    by_id = {c.id: c for c in parsed.criteria_scores}
    repaired = False
    scores: list[CriterionScore] = []
    for criterion in req.rubric.criteria:
        got = by_id.get(criterion.id)
        if got is None:
            repaired = True
            scores.append(CriterionScore(id=criterion.id, points=0.0, comment="Not assessed."))
            continue
        points = got.points
        if points < 0 or points > criterion.points:
            repaired = True
            points = min(max(points, 0.0), criterion.points)
        scores.append(CriterionScore(id=criterion.id, points=round(points, 2), comment=got.comment.strip()[:500]))
    if set(by_id) - {c.id for c in req.rubric.criteria}:
        repaired = True
    max_score = round(sum(c.points for c in req.rubric.criteria), 2)
    score = round(min(sum(s.points for s in scores), max_score), 2)
    confidence = min(max(parsed.confidence, 0.0), 1.0)
    if repaired:
        confidence = min(confidence, 0.5)
    return scores, score, max_score, round(confidence, 3), repaired


class Grader:
    def __init__(self, settings: Settings, router: LlmRouter, prompts: PromptLibrary) -> None:
        self.settings = settings
        self.router = router
        self.prompts = prompts

    async def grade(self, req: GradeRequest, run_id: uuid.UUID | None) -> GradeResponse:
        criteria = "\n".join(
            f'<criterion id="{quote_data(c.id)}" points="{c.points:g}">{quote_data(c.description)}</criterion>'
            for c in req.rubric.criteria
        )
        user = (
            f"<question>\n{quote_data(req.question_stem)}\n</question>\n\n"
            f'<rubric version="{req.rubric.version}">\n{criteria}\n</rubric>\n\n'
            f'<model_answer>\n"""\n{quote_data(req.rubric.model_answer)}\n"""\n</model_answer>\n\n'
            f'<student_answer>\n"""\n{quote_data(req.answer_text)}\n"""\n</student_answer>'
        )
        prompt = self.prompts.get("grading")
        request = LlmRequest(
            purpose="grading",
            prompt=prompt,
            messages=[{"role": "user", "content": user}],
            max_tokens=self.settings.llm_structured_max_tokens,
            effort=self.settings.llm_structured_effort,
            run_id=run_id,
            context={
                "answer": req.answer_text,
                "model_answer": req.rubric.model_answer,
                "criteria": [c.dump() for c in req.rubric.criteria],
            },
        )
        try:
            parsed, outcome = await self.router.structured(request, LlmGrade)
        except LlmError as err:
            code = "GRADING_FAILED" if err.code == "LLM_INVALID_OUTPUT" else err.code
            raise AppError(code, internal=err.message) from err

        scores, score, max_score, confidence, repaired = apply_rubric(req, parsed)
        suspicious = looks_like_injection(req.answer_text)
        if suspicious:
            confidence = min(confidence, 0.4)
        if not req.answer_text.strip():
            score, confidence = 0.0, 1.0
            scores = [CriterionScore(id=c.id, points=0.0, comment="No answer given.") for c in req.rubric.criteria]
        log.info(
            "grading.completed",
            message="Answer graded",
            rubric_version=req.rubric.version,
            score=score,
            max_score=max_score,
            confidence=confidence,
            repaired=repaired,
            suspicious_answer=suspicious,
            answer_chars=len(req.answer_text),
        )
        return GradeResponse(
            score=score,
            max_score=max_score,
            confidence=confidence,
            feedback=parsed.feedback.strip()[:2000],
            criteria_scores=scores,
            model=outcome.model,
            prompt_hash=prompt.hash,
            input_tokens=outcome.usage.input_tokens,
            output_tokens=outcome.usage.output_tokens,
            cost_usd=outcome.cost_usd,
        )
