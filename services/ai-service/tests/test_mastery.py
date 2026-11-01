from __future__ import annotations

import uuid

import pytest

from app.evaluation.metrics import cohens_kappa, recall_at_k, reciprocal_rank, score_band
from app.mastery.mastery import expected_success, learning_rate, update_mastery
from app.mastery.recommend import recommend
from app.schemas import ConceptState, IdTitle, RecommendationRequest


def test_worked_example_042_to_0513() -> None:
    # contracts §7: m=0.42, d=0.5, attempts=3, correct → p=0.382, k=0.15, m'=0.513
    assert expected_success(0.42, 0.5) == pytest.approx(0.382, abs=0.001)
    assert learning_rate(3) == pytest.approx(0.15)
    assert update_mastery(0.42, attempts=3, correct=True, difficulty=0.5) == pytest.approx(0.513, abs=0.0005)


def test_wrong_answer_lowers_and_clamps() -> None:
    assert update_mastery(0.42, attempts=3, correct=False, difficulty=0.5) < 0.42
    assert update_mastery(0.05, attempts=0, correct=False, difficulty=0.05) == pytest.approx(
        0.02
    )  # 0.05 - 0.15 → clamp
    assert update_mastery(0.97, attempts=0, correct=True, difficulty=0.1) <= 0.98


def test_default_prior_partial_score_and_diagnostic() -> None:
    assert update_mastery(None, attempts=0, correct=True) > 0.30
    half = update_mastery(0.5, attempts=2, correct=False, difficulty=0.5, score=0.5)
    assert half == pytest.approx(0.5)  # o = 0.5 = p → no change
    assert update_mastery(0.1, attempts=5, correct=True, diagnostic=True) == 0.60
    assert update_mastery(0.9, attempts=5, correct=False, diagnostic=True) == 0.25
    assert learning_rate(1000) == 0.06


def test_recommendations_top3_with_prerequisites() -> None:
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    lesson = uuid.uuid4()
    req = RecommendationRequest(
        concepts=[
            ConceptState(id=a, name="Gradients", mastery=0.2, attempts=4),
            ConceptState(id=b, name="Backprop", mastery=0.1, attempts=2, prerequisite_ids=[a]),  # prereq weak
            ConceptState(id=c, name="Loss", mastery=0.9, attempts=6),
        ],
        next_lesson=IdTitle(id=uuid.uuid4(), title="Training in practice"),
        revision_due=3,
        lesson_concepts={str(lesson): [a, c]},
    )
    items = recommend(req)
    assert len(items) == 3
    assert items[0].type == "concept_practice" and items[0].target_id == str(a)
    assert items[0].score == pytest.approx(0.8)
    assert all(i.target_id != str(b) for i in items)  # unmet prerequisite
    assert [i.type for i in items[1:]] == ["revision", "lesson"]
    assert all(i.reason.endswith(".") for i in items)


def test_mastery_endpoint_contract_shape() -> None:
    from app.schemas import MasteryUpdateRequest

    m = MasteryUpdateRequest.model_validate({"prior": 0.42, "attempts": 3, "correct": True, "difficulty": 0.5})
    assert m.prior == 0.42


def test_eval_metrics() -> None:
    assert recall_at_k(["a", "x", "b"], {"a", "b"}, 2) == 0.5
    assert reciprocal_rank(["x", "y", "a"], {"a"}) == pytest.approx(1 / 3)
    assert cohens_kappa(["low", "high", "mid", "high"], ["low", "high", "mid", "high"]) == 1.0
    k = cohens_kappa(["low", "low", "high", "high"], ["low", "high", "low", "high"])
    assert k == pytest.approx(0.0)
    assert score_band(3, 4) == "high" and score_band(1, 4) == "low" and score_band(2, 4) == "mid"
