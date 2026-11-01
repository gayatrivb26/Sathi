"""Request/response models for the internal API (contracts §6). JSON is camelCase on the wire."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

Level = Literal["beginner", "intermediate", "advanced"]
Mode = Literal["explain", "hint", "quiz_me"]
Adjust = Literal["simpler", "harder"]


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    def dump(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, mode="json")


# ---------------------------------------------------------------- tutor
class IdTitle(CamelModel):
    id: uuid.UUID
    title: str = Field(max_length=500)


class HistoryTurn(CamelModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=20_000)


class WeakConcept(CamelModel):
    name: str = Field(max_length=200)
    mastery: float = Field(ge=0, le=1)


class TutorRequest(CamelModel):
    run_id: uuid.UUID
    conversation_id: uuid.UUID
    course: IdTitle
    lesson: IdTitle | None = None
    question: str = Field(default="", max_length=8000)
    level: Level = "intermediate"
    mode: Mode = "explain"
    adjust: Adjust | None = None
    previous_answer: str | None = Field(default=None, max_length=20_000)
    web_search: bool = False
    history: list[HistoryTurn] = Field(default_factory=list, max_length=16)
    weak_concepts: list[WeakConcept] = Field(default_factory=list, max_length=3)

    @field_validator("question")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


class Citation(CamelModel):
    index: int
    source_type: Literal["course", "upload", "web"]
    title: str
    document_id: uuid.UUID | None = None
    lesson_id: uuid.UUID | None = None
    page: int | None = None
    url: str | None = None
    snippet: str


# ---------------------------------------------------------------- ingestion
class ParseRequest(CamelModel):
    document_id: uuid.UUID
    document_version: int = Field(ge=1)
    storage_key: str = Field(min_length=1, max_length=1024)
    content_type: str = Field(max_length=200)
    file_name: str = Field(max_length=500)


class ParseResponse(CamelModel):
    page_count: int
    char_count: int
    parsed_key: str


class IndexRequest(CamelModel):
    document_id: uuid.UUID
    document_version: int = Field(ge=1)
    parsed_key: str = Field(min_length=1, max_length=1024)
    scope: Literal["user", "course"]
    owner_user_id: uuid.UUID | None = None
    course_id: uuid.UUID | None = None
    lesson_id: uuid.UUID | None = None
    source_type: Literal["upload", "course"]
    title: str = Field(min_length=1, max_length=500)


class IndexTextRequest(CamelModel):
    document_id: uuid.UUID
    document_version: int = Field(ge=1)
    scope: Literal["course"] = "course"
    course_id: uuid.UUID
    lesson_id: uuid.UUID | None = None
    source_type: Literal["course"] = "course"
    title: str = Field(min_length=1, max_length=500)
    markdown: str = Field(max_length=2_000_000)


class IndexResponse(CamelModel):
    passage_count: int
    embedding_model: str


# ---------------------------------------------------------------- quiz generation
class ConceptRef(CamelModel):
    id: uuid.UUID
    name: str = Field(max_length=200)
    description: str = Field(default="", max_length=4000)


class QuizGenerateRequest(CamelModel):
    course_id: uuid.UUID
    concept: ConceptRef
    count: int = Field(ge=1, le=10)
    difficulty: float = Field(ge=0, le=1)
    lesson_titles: list[str] = Field(default_factory=list, max_length=50)


class GeneratedOption(CamelModel):
    label: str
    text: str
    is_correct: bool


class GeneratedQuestion(CamelModel):
    stem: str
    explanation: str
    difficulty: float
    options: list[GeneratedOption]


class QuizGenerateResponse(CamelModel):
    questions: list[GeneratedQuestion]
    model: str
    prompt_hash: str
    input_tokens: int
    output_tokens: int
    cost_usd: float


# ---------------------------------------------------------------- grading
class RubricCriterion(CamelModel):
    id: str = Field(min_length=1, max_length=100)
    description: str = Field(max_length=4000)
    points: float = Field(gt=0, le=100)


class Rubric(CamelModel):
    version: int = 1
    criteria: list[RubricCriterion] = Field(min_length=1, max_length=20)
    model_answer: str = Field(default="", max_length=20_000)


class GradeRequest(CamelModel):
    question_stem: str = Field(max_length=8000)
    rubric: Rubric
    answer_text: str = Field(max_length=20_000)


class CriterionScore(CamelModel):
    id: str
    points: float
    comment: str


class GradeResponse(CamelModel):
    score: float
    max_score: float
    confidence: float
    feedback: str
    criteria_scores: list[CriterionScore]
    model: str
    prompt_hash: str
    input_tokens: int
    output_tokens: int
    cost_usd: float


# ---------------------------------------------------------------- mastery & recommendations
class MasteryUpdateRequest(CamelModel):
    prior: float | None = Field(default=None, ge=0, le=1)
    attempts: int = Field(default=0, ge=0)
    correct: bool
    difficulty: float = Field(default=0.5, ge=0, le=1)
    score: float | None = Field(default=None, ge=0, le=1)
    diagnostic: bool = False


class MasteryUpdateResponse(CamelModel):
    mastery: float


class ConceptState(CamelModel):
    id: uuid.UUID
    name: str
    mastery: float = Field(ge=0, le=1)
    attempts: int = Field(default=0, ge=0)
    last_practiced_at: datetime | None = None
    prerequisite_ids: list[uuid.UUID] = Field(default_factory=list)


class RecommendationRequest(CamelModel):
    concepts: list[ConceptState] = Field(default_factory=list)
    next_lesson: IdTitle | None = None
    revision_due: int = Field(default=0, ge=0)
    lesson_concepts: dict[str, list[uuid.UUID]] = Field(default_factory=dict)
    course_id: uuid.UUID | None = None


class RecommendationItem(CamelModel):
    type: Literal["lesson", "concept_practice", "quiz", "revision"]
    target_id: str
    title: str
    reason: str
    score: float


class RecommendationResponse(CamelModel):
    items: list[RecommendationItem]


# ---------------------------------------------------------------- admin / eval
class LogLevelRequest(CamelModel):
    level: Literal["debug", "info", "warning", "error", "DEBUG", "INFO", "WARNING", "ERROR"]


class DebugCaptureRequest(CamelModel):
    conversation_id: uuid.UUID
    enabled: bool
    expires_at: datetime | None = None


class EvalRunRequest(CamelModel):
    dataset: Literal["retrieval", "tutor", "injection", "grading", "all"] = "all"


class EvalRunResponse(CamelModel):
    evaluation_run_id: uuid.UUID
    metrics: dict[str, Any]


# ---------------------------------------------------------------- errors (RFC 9457, contracts §4.1)
class ProblemDetails(BaseModel):
    """``application/problem+json`` body of every non-2xx response."""

    model_config = ConfigDict(extra="forbid")

    type: str = Field(description="Error type URI, e.g. https://sathi.app/errors/service-token-invalid")
    title: str
    status: int
    detail: str = Field(description="Safe to show to users; never contains internals.")
    code: str = Field(description="Stable error code (contracts §4.2), e.g. SERVICE_TOKEN_INVALID.")
    traceId: str | None = Field(default=None, description="W3C trace id (32 hex characters).")
    referenceId: str | None = Field(default=None, description="XXXX-XXXX, first 8 hex chars of the trace id.")
    errors: dict[str, list[str]] | None = Field(default=None, description="Only for VALIDATION_FAILED.")


# ---------------------------------------------------------------- health
class HealthLive(BaseModel):
    status: Literal["ok"]


class HealthReady(BaseModel):
    status: Literal["ok", "unavailable"]
    checks: dict[str, str] = Field(
        description="database: ok|failed; storage: ok|failed; llm: provider name or 'disabled'; embeddings: model."
    )


# ---------------------------------------------------------------- run detail (GET /runs/{runId})
class ModelRunRow(CamelModel):
    id: uuid.UUID
    run_id: uuid.UUID | None
    trace_id: str | None
    purpose: str
    provider: str
    model: str
    prompt_name: str
    prompt_version: int
    prompt_hash: str
    params: dict[str, Any]
    input_tokens: int
    output_tokens: int
    estimated_cost_usd: float
    ttft_ms: int | None
    latency_ms: int
    retries: int
    finish_reason: str = Field(description="end_turn | max_tokens | refusal | error | cancelled | …")
    error_code: str | None
    fallback_used: bool
    created_at: datetime


class RetrievedSourceRow(CamelModel):
    id: uuid.UUID
    retrieval_run_id: uuid.UUID | None
    run_id: uuid.UUID | None
    rank: int
    source_type: Literal["course", "upload", "web"]
    chunk_id: uuid.UUID | None
    document_id: uuid.UUID | None
    url: str | None
    title: str
    score: float
    vector_rank: int | None
    keyword_rank: int | None
    cited: bool


class RetrievalRunRow(CamelModel):
    id: uuid.UUID
    run_id: uuid.UUID | None
    trace_id: str | None
    query_hash: str
    method: str
    scope_course_count: int
    scope_includes_uploads: bool
    top_k: int
    result_count: int
    timings: dict[str, Any]
    empty: bool
    created_at: datetime
    sources: list[RetrievedSourceRow]


class SearchRunRow(CamelModel):
    id: uuid.UUID
    run_id: uuid.UUID | None
    trace_id: str | None
    query_hash: str
    provider: str
    result_count: int
    urls: list[str]
    latency_ms: int
    cache_hit: bool
    outcome: Literal["ok", "empty", "failed", "skipped"]
    error_code: str | None
    created_at: datetime


class InternalRunDetail(CamelModel):
    model_runs: list[ModelRunRow]
    retrieval_runs: list[RetrievalRunRow]
    search_runs: list[SearchRunRow]
    web_sources: list[RetrievedSourceRow] = Field(description="Web sources (no retrieval run).")


# ---------------------------------------------------------------- tutor SSE payloads (contracts §6.1)
# Documentation models for the ``data:`` JSON of each SSE event; every payload also carries ``requestId``.
class SseStatusEvent(CamelModel):
    stage: Literal["retrieving", "searching_web", "reading_sources", "generating"]
    message: str
    request_id: str


class SseTokenEvent(CamelModel):
    text: str
    request_id: str


class SseCitationEvent(Citation):
    request_id: str


class SseUsageEvent(CamelModel):
    input_tokens: int
    output_tokens: int
    cost_usd: float
    model: str
    ttft_ms: int | None
    latency_ms: int
    request_id: str


class RunStep(CamelModel):
    step: Literal["retrieve", "web_search", "llm", "citation_check"]
    started_at: datetime
    ended_at: datetime
    outcome: Literal["ok", "empty", "failed", "skipped"]
    metrics: dict[str, Any]


class RunMetrics(CamelModel):
    provider: str
    model: str
    prompt_hash: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    ttft_ms: int | None
    latency_ms: int


class SseDoneEvent(CamelModel):
    content: str
    answer_basis: list[Literal["course", "upload", "web", "general"]]
    citations_valid: int
    citations_dropped: int
    warnings: list[str]
    steps: list[RunStep]
    run: RunMetrics
    request_id: str


class SseErrorEvent(CamelModel):
    code: str
    message: str
    reference_id: str | None
    request_id: str


SSE_EVENTS: dict[str, type[BaseModel]] = {
    "status": SseStatusEvent,
    "token": SseTokenEvent,
    "citation": SseCitationEvent,
    "usage": SseUsageEvent,
    "done": SseDoneEvent,
    "error": SseErrorEvent,
}
