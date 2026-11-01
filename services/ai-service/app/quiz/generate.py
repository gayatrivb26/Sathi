"""Question generation grounded in course retrieval, validated with Pydantic + business rules."""

from __future__ import annotations

import uuid

from pydantic import BaseModel, Field

from app.config import Settings
from app.db import Database
from app.embeddings.base import EmbeddingProvider
from app.errors import AppError
from app.llm.base import LlmError, LlmRequest
from app.llm.router import LlmRouter
from app.logging import get_logger
from app.prompts import PromptLibrary
from app.rag.retrieval import HybridRetriever
from app.schemas import GeneratedOption, GeneratedQuestion, QuizGenerateRequest, QuizGenerateResponse
from app.security import Principal, RetrievalScope
from app.tutor.prompting import quote_data

log = get_logger(__name__)


# ---- structured-output schema sent to the model (kept simple: no unsupported JSON-schema constraints)
class LlmOption(BaseModel):
    label: str = Field(description="A, B, C or D")
    text: str
    is_correct: bool


class LlmQuestion(BaseModel):
    stem: str
    explanation: str
    difficulty: float = Field(description="0 (easy) to 1 (hard)")
    options: list[LlmOption]


class LlmQuiz(BaseModel):
    questions: list[LlmQuestion]


def validate_question(q: LlmQuestion) -> GeneratedQuestion | None:
    """Business rules: 4 options labelled A–D, exactly one correct, non-empty unique texts."""
    if not q.stem.strip() or not q.explanation.strip() or len(q.options) != 4:
        return None
    if sum(1 for o in q.options if o.is_correct) != 1:
        return None
    texts = [o.text.strip() for o in q.options]
    if any(not t for t in texts) or len({t.lower() for t in texts}) != 4:
        return None
    return GeneratedQuestion(
        stem=q.stem.strip(),
        explanation=q.explanation.strip(),
        difficulty=round(min(1.0, max(0.0, q.difficulty)), 2),
        options=[
            GeneratedOption(label="ABCD"[i], text=t, is_correct=o.is_correct)
            for i, (o, t) in enumerate(zip(q.options, texts, strict=True))
        ],
    )


class QuizGenerator:
    def __init__(
        self,
        settings: Settings,
        db: Database | None,
        router: LlmRouter,
        prompts: PromptLibrary,
        embedder: EmbeddingProvider,
        retriever: HybridRetriever,
    ) -> None:
        self.settings = settings
        self.db = db
        self.router = router
        self.prompts = prompts
        self.embedder = embedder
        self.retriever = retriever

    async def _sources(self, req: QuizGenerateRequest, principal: Principal) -> list[dict[str, str | int]]:
        if self.db is None:
            return []
        # Course-scope material only (never uploads). The course must be in the token's rscope; a system
        # token with an empty rscope (jobs host) may read the requested course's shared material.
        rs = principal.rscope.course_ids
        if rs and req.course_id not in rs:
            return []
        allowed = (req.course_id,)
        query = f"{req.concept.name}. {req.concept.description} " + " ".join(req.lesson_titles[:5])
        qvec = await self.embedder.embed_query(query)
        async with self.db.session() as s:
            result = await self.retriever.search(
                s,
                query=query,
                query_vector=qvec,
                scope=RetrievalScope(course_ids=allowed),
                source_types=["course"],
                top_k=8,
            )
        return [{"index": i + 1, "title": c.title, "content": c.content} for i, c in enumerate(result.chunks)]

    async def generate(
        self, req: QuizGenerateRequest, principal: Principal, run_id: uuid.UUID | None
    ) -> QuizGenerateResponse:
        sources = await self._sources(req, principal)
        src_text = (
            "\n".join(
                f'<source index="{s["index"]}" title="{quote_data(str(s["title"]))[:200]}">\n"""\n'
                f'{quote_data(str(s["content"]))}\n"""\n</source>'
                for s in sources
            )
            or "(no course passages found; rely on the concept description)"
        )
        user = (
            f"<concept>\nname: {quote_data(req.concept.name)}\ndescription: {quote_data(req.concept.description)}\n"
            f"</concept>\n<lessons>{quote_data(', '.join(req.lesson_titles))}</lessons>\n"
            f"<target_difficulty>{req.difficulty:.2f}</target_difficulty>\n<count>{req.count}</count>\n\n"
            f"<sources>\n{src_text}\n</sources>\n\nWrite exactly {req.count} questions."
        )
        prompt = self.prompts.get("quiz_generation")
        questions: list[GeneratedQuestion] = []
        totals = {"in": 0, "out": 0, "cost": 0.0}
        model = ""
        for attempt in range(2):  # one retry when validation drops questions
            request = LlmRequest(
                purpose="quiz_generation",
                prompt=prompt,
                messages=[{"role": "user", "content": user}],
                max_tokens=self.settings.llm_structured_max_tokens,
                effort=self.settings.llm_structured_effort,
                run_id=run_id,
                context={
                    "concept": req.concept.dump(),
                    "count": req.count - len(questions),
                    "difficulty": req.difficulty,
                    "sources": sources,
                },
            )
            try:
                parsed, outcome = await self.router.structured(request, LlmQuiz)
            except LlmError as err:
                if err.code == "LLM_INVALID_OUTPUT":
                    if attempt == 0:
                        continue
                    raise AppError("QUIZ_GENERATION_FAILED", internal=err.message) from err
                raise AppError(err.code, internal=err.message) from err
            totals["in"] += outcome.usage.input_tokens
            totals["out"] += outcome.usage.output_tokens
            totals["cost"] += outcome.cost_usd
            model = outcome.model
            valid = [v for v in (validate_question(q) for q in parsed.questions) if v is not None]
            dropped = len(parsed.questions) - len(valid)
            if dropped:
                log.warning(
                    "quiz.validation_dropped",
                    message="Dropped invalid generated questions",
                    dropped=dropped,
                    attempt=attempt + 1,
                )
            seen = {q.stem.lower() for q in questions}
            questions.extend(q for q in valid if q.stem.lower() not in seen)
            if len(questions) >= req.count:
                break
        if not questions:
            raise AppError("QUIZ_GENERATION_FAILED", internal="no valid questions after retry")
        log.info(
            "quiz.generated",
            message="Questions generated",
            count=len(questions[: req.count]),
            requested=req.count,
            source_count=len(sources),
            concept_id=str(req.concept.id),
        )
        return QuizGenerateResponse(
            questions=questions[: req.count],
            model=model,
            prompt_hash=prompt.hash,
            input_tokens=int(totals["in"]),
            output_tokens=int(totals["out"]),
            cost_usd=round(float(totals["cost"]), 6),
        )
