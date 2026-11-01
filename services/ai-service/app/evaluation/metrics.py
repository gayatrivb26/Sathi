"""Evaluation metrics: Recall@k, reciprocal rank, Cohen's kappa, agreement bands."""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence


def recall_at_k(retrieved: Sequence[str], relevant: set[str], k: int) -> float:
    if not relevant:
        return 0.0
    return len(set(retrieved[:k]) & relevant) / len(relevant)


def reciprocal_rank(retrieved: Sequence[str], relevant: set[str]) -> float:
    for rank, item in enumerate(retrieved, start=1):
        if item in relevant:
            return 1.0 / rank
    return 0.0


def cohens_kappa(a: Sequence[str], b: Sequence[str]) -> float | None:
    """κ = (p_o − p_e) / (1 − p_e). Returns None for empty input; 1.0 when both raters are constant and equal."""
    if len(a) != len(b):
        raise ValueError("rater sequences must have the same length")
    n = len(a)
    if n == 0:
        return None
    p_o = sum(1 for x, y in zip(a, b, strict=True) if x == y) / n
    ca, cb = Counter(a), Counter(b)
    p_e = sum((ca[label] / n) * (cb[label] / n) for label in set(ca) | set(cb))
    if p_e >= 1.0:
        return 1.0 if p_o == 1.0 else 0.0
    return round((p_o - p_e) / (1 - p_e), 4)


def score_band(score: float, max_score: float) -> str:
    """Discretise a rubric score for κ: low < 1/3 ≤ mid < 2/3 ≤ high."""
    if max_score <= 0:
        return "low"
    frac = score / max_score
    if frac < 1 / 3:
        return "low"
    if frac < 2 / 3:
        return "mid"
    return "high"


def mean(values: Sequence[float]) -> float | None:
    return round(sum(values) / len(values), 4) if values else None
