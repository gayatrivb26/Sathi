"""Stateless mastery update (contracts §7).

p  = 1 / (1 + e^(−6·(m − d)))            expected success
k  = max(0.06, 0.30 / √(1 + attempts))    learning rate
m' = clamp(m + k·(o − p), 0.02, 0.98)     o = 1/0, or the rubric score fraction

Worked example: m=0.42, d=0.5, attempts=3, correct → p=0.382, k=0.15, m'=0.513.
Diagnostic answers set the prior directly: correct → 0.60, wrong → 0.25.
"""

from __future__ import annotations

import math

MIN_MASTERY = 0.02
MAX_MASTERY = 0.98
DEFAULT_PRIOR = 0.30
DIAGNOSTIC_CORRECT = 0.60
DIAGNOSTIC_WRONG = 0.25


def clamp(m: float) -> float:
    return min(MAX_MASTERY, max(MIN_MASTERY, m))


def expected_success(mastery: float, difficulty: float) -> float:
    return 1.0 / (1.0 + math.exp(-6.0 * (mastery - difficulty)))


def learning_rate(attempts: int) -> float:
    return max(0.06, 0.30 / math.sqrt(1 + max(0, attempts)))


def update_mastery(
    prior: float | None,
    *,
    attempts: int,
    correct: bool,
    difficulty: float = 0.5,
    score: float | None = None,
    diagnostic: bool = False,
) -> float:
    if diagnostic:
        return DIAGNOSTIC_CORRECT if correct else DIAGNOSTIC_WRONG
    m = clamp(DEFAULT_PRIOR if prior is None else prior)
    outcome = min(1.0, max(0.0, score)) if score is not None else (1.0 if correct else 0.0)
    p = expected_success(m, min(1.0, max(0.0, difficulty)))
    k = learning_rate(attempts)
    return round(clamp(m + k * (outcome - p)), 4)
