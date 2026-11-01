"""Study-next recommendations (contracts §7). Deterministic, top 3, one human sentence each.

Candidates:
* weakest concepts whose prerequisites are all ≥ 0.5 mastery → ``concept_practice``, score 1 − m
* revision cards due → ``revision``, score 0.6
* next lesson → ``lesson``, score 0.5
* lesson-check quiz for the most recent lesson's concepts → ``quiz``, score 0.35 + 0.3·(1 − avg m)
"""

from __future__ import annotations

import uuid

from app.schemas import ConceptState, RecommendationItem, RecommendationRequest

NIL_UUID = "00000000-0000-0000-0000-000000000000"
PREREQ_THRESHOLD = 0.5
WEAK_THRESHOLD = 0.7


def _pct(m: float) -> str:
    return f"{round(m * 100)}%"


def _concept_reason(c: ConceptState) -> str:
    if c.attempts == 0:
        return f"You haven't practised {c.name} yet — a few questions will show where you stand."
    if c.mastery < 0.35:
        return (
            f"{c.name} is your weakest area ({_pct(c.mastery)} mastery after {c.attempts} attempts); "
            "recent answers suggest the basics need another look."
        )
    return (
        f"Your mastery of {c.name} is {_pct(c.mastery)} after {c.attempts} attempts — "
        "a short practice set will strengthen it."
    )


def recommend(req: RecommendationRequest, limit: int = 3) -> list[RecommendationItem]:
    by_id = {c.id: c for c in req.concepts}
    items: list[RecommendationItem] = []

    for c in sorted(req.concepts, key=lambda c: (c.mastery, c.name)):
        if c.mastery >= WEAK_THRESHOLD:
            continue
        prereqs = [by_id[p] for p in c.prerequisite_ids if p in by_id]
        if any(p.mastery < PREREQ_THRESHOLD for p in prereqs):
            continue  # practise the prerequisite first (it will surface on its own)
        items.append(
            RecommendationItem(
                type="concept_practice",
                target_id=str(c.id),
                title=f"Practise {c.name}",
                reason=_concept_reason(c),
                score=round(1 - c.mastery, 4),
            )
        )

    if req.revision_due > 0:
        minutes = max(1, round(req.revision_due * 1.2))
        items.append(
            RecommendationItem(
                type="revision",
                target_id=str(req.course_id) if req.course_id else NIL_UUID,
                title="Review due cards",
                reason=f"You have {req.revision_due} revision card{'s' if req.revision_due != 1 else ''} due "
                f"(about {minutes} minute{'s' if minutes != 1 else ''}) — reviewing now keeps them fresh.",
                score=0.6,
            )
        )

    if req.next_lesson is not None:
        items.append(
            RecommendationItem(
                type="lesson",
                target_id=str(req.next_lesson.id),
                title=req.next_lesson.title,
                reason=f"Continue the course with “{req.next_lesson.title}”.",
                score=0.5,
            )
        )

    if req.lesson_concepts:
        lesson_id, concept_ids = next(reversed(req.lesson_concepts.items()))
        known = [by_id[cid] for cid in concept_ids if cid in by_id]
        if known:
            avg = sum(c.mastery for c in known) / len(known)
            names = ", ".join(c.name for c in known[:3])
            items.append(
                RecommendationItem(
                    type="quiz",
                    target_id=str(uuid.UUID(lesson_id)) if _is_uuid(lesson_id) else lesson_id,
                    title="Lesson check",
                    reason=f"A quick lesson check on {names} confirms what you just studied.",
                    score=round(0.35 + 0.3 * (1 - avg), 4),
                )
            )

    seen: set[tuple[str, str]] = set()
    unique = []
    for item in sorted(items, key=lambda i: -i.score):
        key = (item.type, item.target_id)
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique[:limit]


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
        return True
    except ValueError:
        return False
