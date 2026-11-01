"""Deterministic FakeProvider for CI, tests and keyless local runs.

It behaves like a well-behaved model: it answers from the supplied passages with ``[n]`` markers, never
follows instructions found inside sources, says so when nothing is relevant and gives a marked general
explanation. Structured outputs (quiz generation, grading) are deterministic functions of the input.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import AsyncIterator
from typing import Any

from app.llm.base import LlmRequest, LlmResult, LlmUsage, T, TextDelta
from app.text import content_words, drop_exercise_sections, looks_like_injection, overlap_score, sentences, truncate

GENERAL_MARKER = "**General explanation (not from your course materials):**"


def _tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _input_tokens(request: LlmRequest) -> int:
    return _tokens(request.prompt.text) + sum(_tokens(m["content"]) for m in request.messages)


def _seed(text: str) -> int:
    return int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:8], 16)


def _topic(question: str) -> str:
    words = content_words(question)
    return " ".join(words[:6]) if words else "this topic"


_SKIP_SECTIONS = ("check yourself", "common mistakes")


def _explanatory(s: str) -> bool:
    """True for declarative prose: not a question, heading, list marker, answer key or exercise."""
    t = s.strip()
    return not (
        t.endswith("?")
        or t.startswith(("#", "|", "-", "*", ">"))
        or t[:2].rstrip(".").isdigit()
        or "(Answer:" in t
        or any(sec in t.lower() for sec in _SKIP_SECTIONS)
    )


def _best_sentences(question: str, content: str, limit: int = 2) -> list[str]:
    scored = []
    for i, s in enumerate(sentences(drop_exercise_sections(content))):
        if looks_like_injection(s) or len(s) < 20 or not _explanatory(s):
            continue
        scored.append((overlap_score(question, s), -i, s))
    scored.sort(reverse=True)
    return [truncate(s, 300) for score, _, s in scored[:limit] if score > 0] or [
        truncate(s, 300) for _, _, s in scored[:1]
    ]


class FakeProvider:
    name = "fake"

    def __init__(self, *, delay_seconds: float = 0.0) -> None:
        self.delay_seconds = delay_seconds
        self.calls: list[tuple[str, LlmRequest]] = []

    # ------------------------------------------------------------------ tutor text
    def _tutor_answer(self, ctx: dict[str, Any]) -> str:
        question = str(ctx.get("question") or "")
        mode = ctx.get("mode", "explain")
        level = ctx.get("level", "intermediate")
        adjust = ctx.get("adjust")
        sources: list[dict[str, Any]] = list(ctx.get("sources") or [])
        topic = _topic(question or str(ctx.get("previous_answer") or ""))

        relevant = sorted(
            ((overlap_score(question, f"{s.get('title', '')} {s.get('content', '')}"), s) for s in sources),
            key=lambda x: (-x[0], x[1]["index"]),
        )
        relevant = [(sc, s) for sc, s in relevant if sc > 0][:3]

        lines: list[str] = []
        if adjust == "simpler":
            lines.append(f"Let's make that simpler ({level} level).")
        elif adjust == "harder":
            lines.append(f"Let's go deeper ({level} level).")

        if mode == "quiz_me":
            fact = ""
            if relevant:
                best = _best_sentences(question, str(relevant[0][1].get("content", "")), 1)
                fact = f" (see [{relevant[0][1]['index']}])" if best else ""
            lines.append(f"Here is a question to check your understanding of {topic}{fact}:")
            lines.append("")
            lines.append(f"**Question:** In your own words, what is the main idea of {topic}, and when is it used?")
            lines.append("")
            lines.append("Reply with your answer and I will give you feedback.")
            return "\n".join(lines)

        if not relevant:
            lines.append("I couldn't find this in your course materials or the sources I was given.")
            lines.append("")
            lines.append(GENERAL_MARKER)
            lines.append(
                f"In general terms, {topic} is best understood by starting from its definition, looking at "
                "a small worked example, and then checking how it connects to ideas you already know."
            )
        else:
            if mode == "hint":
                first = relevant[0][1]
                best = _best_sentences(question, str(first.get("content", "")), 1)
                hint = best[0] if best else str(first.get("title", ""))
                lines.append(f"Here's a hint to get you started: {hint} [{first['index']}]")
                lines.append("")
                lines.append(f"What do you think that tells you about {topic}?")
                return "\n".join(lines)
            lines.append("Here is what your sources say:")
            lines.append("")
            for _, src in relevant:
                for s in _best_sentences(question, str(src.get("content", "")), 2 if level == "advanced" else 1):
                    lines.append(f"- {s} [{src['index']}]")
            types = {s.get("type") for _, s in relevant}
            if "web" in types and types & {"course", "upload"}:
                lines.append("")
                lines.append("Your course material takes priority where the web sources differ.")
        if mode == "explain":
            lines.append("")
            lines.append("Quick check: can you explain this back to me in one sentence?")
            lines.append("")
            lines.append("_Offline demo mode: this answer was assembled from your sources without a language model._")
        return "\n".join(lines)

    def _query(self, ctx: dict[str, Any]) -> str:
        return " ".join(content_words(str(ctx.get("question") or ""))[:10]) or "learning topic"

    async def stream_chat(self, request: LlmRequest, model: str) -> AsyncIterator[TextDelta | LlmResult]:
        self.calls.append(("stream", request))
        if request.purpose == "query_rewrite":
            text = self._query(request.context)
        else:
            text = self._tutor_answer(request.context)
        pieces = text.split(" ")
        for i in range(0, len(pieces), 3):
            if self.delay_seconds:
                await asyncio.sleep(self.delay_seconds)
            chunk = " ".join(pieces[i : i + 3])
            yield TextDelta(chunk if i + 3 >= len(pieces) else chunk + " ")
        yield LlmResult(
            text=text,
            model=model,
            provider=self.name,
            stop_reason="end_turn",
            usage=LlmUsage(input_tokens=_input_tokens(request), output_tokens=_tokens(text)),
            request_id=f"fake_{_seed(text):08x}",
        )

    # ------------------------------------------------------------------ structured
    def _quiz(self, ctx: dict[str, Any]) -> dict[str, Any]:
        concept = ctx.get("concept") or {}
        name = str(concept.get("name") or "the concept")
        description = str(concept.get("description") or f"the core idea behind {name}")
        count = int(ctx.get("count") or 3)
        difficulty = float(ctx.get("difficulty") or 0.5)
        facts = [
            s
            for src in ctx.get("sources") or []
            for s in _best_sentences(name + " " + description, str(src.get("content", "")), 2)
        ] or [truncate(description, 200)]
        questions = []
        for i in range(count):
            fact = facts[i % len(facts)]
            correct_pos = _seed(f"{name}{i}") % 4
            distractors = [
                f"It is unrelated to {name} and only applies to databases.",
                f"It means {name} can be ignored once a model is trained.",
                f"It is a formatting convention with no effect on results ({i + 1}).",
            ]
            texts = list(distractors)
            texts.insert(correct_pos, truncate(fact, 200))
            questions.append(
                {
                    "stem": f"Which statement about {name} is correct? (Q{i + 1})",
                    "explanation": f"The correct option reflects the course material: {truncate(fact, 160)}",
                    "difficulty": round(difficulty, 2),
                    "options": [
                        {"label": "ABCD"[j], "text": t, "is_correct": j == correct_pos} for j, t in enumerate(texts)
                    ],
                }
            )
        return {"questions": questions}

    def _grade(self, ctx: dict[str, Any]) -> dict[str, Any]:
        answer = str(ctx.get("answer") or "")
        model_answer = str(ctx.get("model_answer") or "")
        criteria: list[dict[str, Any]] = list(ctx.get("criteria") or [])
        suspicious = looks_like_injection(answer)
        answer_words = set(content_words(answer))
        scores = []
        borderline = False
        for c in criteria:
            ref = set(content_words(f"{c.get('description', '')} {model_answer}"))
            ratio = len(ref & answer_words) / len(ref) if ref else 0.0
            ratio = min(1.0, ratio * 2.0)  # answers rarely reuse every reference word
            if suspicious:
                ratio = 0.0
            max_points = float(c.get("points") or 0)
            points = round(max_points * ratio * 2) / 2
            if 0.3 < ratio < 0.7:
                borderline = True
            scores.append({"id": str(c.get("id")), "points": points, "comment": f"Matched {ratio:.0%} of key ideas."})
        confidence = 0.3 if suspicious or len(answer_words) < 3 else (0.6 if borderline else 0.9)
        return {
            "criteria_scores": scores,
            "feedback": "Good effort. Compare your answer with the key ideas in the lesson and add any missing ones.",
            "confidence": confidence,
        }

    async def complete_structured(self, request: LlmRequest, model: str, output_type: type[T]) -> tuple[T, LlmResult]:
        self.calls.append(("structured", request))
        if self.delay_seconds:
            await asyncio.sleep(self.delay_seconds)
        if request.purpose == "quiz_generation":
            data = self._quiz(request.context)
        elif request.purpose == "grading":
            data = self._grade(request.context)
        else:
            raise ValueError(f"FakeProvider has no structured output for {request.purpose}")
        parsed = output_type.model_validate(data)
        text = parsed.model_dump_json()
        return parsed, LlmResult(
            text=text,
            model=model,
            provider=self.name,
            stop_reason="end_turn",
            usage=LlmUsage(input_tokens=_input_tokens(request), output_tokens=_tokens(text)),
            request_id=f"fake_{_seed(text):08x}",
        )
