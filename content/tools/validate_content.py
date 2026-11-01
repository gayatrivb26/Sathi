#!/usr/bin/env python3
"""Validate Sathi seed content and golden evaluation datasets.

Usage:  python content/tools/validate_content.py   (from the repo root, or any cwd)

Checks
  course.json      shape (contracts.md section 9), unique slugs, prerequisites exist and are acyclic,
                   lesson files exist, module 3 has 7 lessons with lesson 4 = "Scaled dot-product attention"
  lessons/*.md     700-1200 words, has ## headings, "Common mistakes" and "Check yourself" sections
  questions.json   shape, concept/lesson slugs exist, difficulty in {0.3, 0.5, 0.7}, MCQs have labels A-D
                   with exactly one correct option, exactly one diagnostic MCQ per concept, >= 7 MCQs per
                   concept, short answers have rubrics (2-4 criteria, 3-5 points) and no options
  datasets/*.jsonl JSON parses, required fields, ids unique, expected lesson titles exist in course.json,
                   expected sizes, regexes compile, grading scores within range
Exits non-zero on any error.
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COURSE_DIR = ROOT / "content" / "ai-engineering"
DATASETS = ROOT / "tests" / "ai-evaluation" / "datasets"

REQUIRED_CONCEPTS = {
    "loss-functions": "Loss functions", "gradient-descent": "Gradient descent",
    "regularization": "Overfitting and regularization", "activation-functions": "Activation functions",
    "backpropagation": "Backpropagation", "embeddings": "Embeddings", "attention": "Attention",
    "transformers": "Transformers", "chunking": "Chunking", "vector-search": "Vector search",
    "hybrid-search": "Hybrid search and RRF", "rag-evaluation": "RAG evaluation",
}
DIFFICULTIES = {0.3, 0.5, 0.7}
EXPECTED_SIZES = {"retrieval.jsonl": 50, "tutor.jsonl": 20, "injection.jsonl": 10, "grading.jsonl": 15}

errors: list[str] = []
warnings: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def require(obj: dict, keys: list[str], where: str) -> bool:
    missing = [k for k in keys if k not in obj]
    if missing:
        err(f"{where}: missing keys {missing}")
        return False
    return True


# --------------------------------------------------------------------------- course
def validate_course() -> tuple[dict, dict, dict]:
    course = json.loads((COURSE_DIR / "course.json").read_text(encoding="utf-8"))
    require(course, ["slug", "title", "description", "domain", "concepts", "modules"], "course.json")
    if course.get("slug") != "ai-engineering":
        err("course.json: slug must be 'ai-engineering'")

    concepts = {}
    for c in course["concepts"]:
        require(c, ["slug", "name", "description", "prerequisites"], f"concept {c.get('slug')}")
        if c["slug"] in concepts:
            err(f"duplicate concept slug {c['slug']}")
        concepts[c["slug"]] = c
    for slug, name in REQUIRED_CONCEPTS.items():
        if slug not in concepts:
            err(f"required concept missing: {slug}")
        elif concepts[slug]["name"] != name:
            err(f"concept {slug}: name must be {name!r}, got {concepts[slug]['name']!r}")
    for c in concepts.values():
        for p in c["prerequisites"]:
            if p not in concepts:
                err(f"concept {c['slug']}: unknown prerequisite {p}")

    # acyclic prerequisites
    state: dict[str, int] = {}

    def visit(s: str, stack: list[str]) -> None:
        if state.get(s) == 1:
            err(f"prerequisite cycle: {' -> '.join(stack + [s])}")
            return
        if state.get(s) == 2:
            return
        state[s] = 1
        for p in concepts[s]["prerequisites"]:
            if p in concepts:
                visit(p, stack + [s])
        state[s] = 2

    for s in concepts:
        visit(s, [])

    lessons = {}
    titles = {}
    n = 0
    for mi, m in enumerate(course["modules"], 1):
        require(m, ["title", "summary", "lessons"], f"module {mi}")
        for li, les in enumerate(m["lessons"], 1):
            n += 1
            where = f"module {mi} lesson {li}"
            require(les, ["slug", "title", "summary", "estimatedMinutes", "concepts", "objectives", "file"], where)
            if les["slug"] in lessons:
                err(f"duplicate lesson slug {les['slug']}")
            lessons[les["slug"]] = les
            titles[les["title"]] = les
            for c in les["concepts"]:
                if c not in concepts:
                    err(f"{where}: unknown concept {c}")
            if not les["objectives"]:
                err(f"{where}: no objectives")
            if not re.fullmatch(r"lessons/\d\d-[a-z0-9-]+\.md", les["file"]):
                err(f"{where}: bad file path {les['file']}")
            elif int(les["file"][8:10]) != n:
                err(f"{where}: file number {les['file']} should be {n:02d}")
            path = COURSE_DIR / les["file"]
            if not path.exists():
                err(f"{where}: missing file {les['file']}")
            else:
                validate_lesson(path)
    mods = course["modules"]
    if len(mods) < 3 or len(mods[2]["lessons"]) != 7:
        err("module 3 must have exactly 7 lessons")
    elif mods[2]["lessons"][3]["title"] != "Scaled dot-product attention":
        err("module 3 lesson 4 must be 'Scaled dot-product attention'")
    uncovered = set(concepts) - {c for l in lessons.values() for c in l["concepts"]}
    if uncovered:
        err(f"concepts not taught by any lesson: {sorted(uncovered)}")
    print(f"course.json: {len(concepts)} concepts, {len(mods)} modules, {len(lessons)} lessons")
    return concepts, lessons, titles


def validate_lesson(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    words = len(text.split())
    if not 700 <= words <= 1200:
        err(f"{path.name}: {words} words (expected 700-1200)")
    if len(re.findall(r"^## ", text, re.M)) < 4:
        err(f"{path.name}: fewer than 4 '##' sections")
    for heading in ("## Common mistakes", "## Check yourself"):
        if heading not in text:
            err(f"{path.name}: missing section {heading!r}")
    if text.count("$$") % 2:
        err(f"{path.name}: unbalanced $$ math delimiters")
    if "Worked example" not in text:
        warn(f"{path.name}: no 'Worked example' heading")


# --------------------------------------------------------------------------- questions
def validate_questions(concepts: dict, lessons: dict) -> None:
    qs = json.loads((COURSE_DIR / "questions.json").read_text(encoding="utf-8"))
    if not isinstance(qs, list):
        err("questions.json must be an array")
        return
    mcq_per = Counter()
    short_per = Counter()
    diag_per = Counter()
    diff_per = defaultdict(Counter)
    labels = Counter()
    stems = Counter()
    for i, q in enumerate(qs):
        where = f"question[{i}]"
        if not require(q, ["concept", "lesson", "type", "stem", "explanation", "difficulty", "isDiagnostic",
                           "options", "rubric"], where):
            continue
        stems[q["stem"]] += 1
        if q["concept"] not in concepts:
            err(f"{where}: unknown concept {q['concept']}")
        if q["lesson"] is not None:
            if q["lesson"] not in lessons:
                err(f"{where}: unknown lesson {q['lesson']}")
            elif q["concept"] not in lessons[q["lesson"]]["concepts"]:
                warn(f"{where}: lesson {q['lesson']} does not list concept {q['concept']}")
        if q["difficulty"] not in DIFFICULTIES:
            err(f"{where}: difficulty {q['difficulty']} not in {sorted(DIFFICULTIES)}")
        if not q["stem"].strip() or not q["explanation"].strip():
            err(f"{where}: empty stem or explanation")
        if q["type"] == "mcq":
            mcq_per[q["concept"]] += 1
            diff_per[q["concept"]][q["difficulty"]] += 1
            opts = q["options"]
            if [o.get("label") for o in opts] != ["A", "B", "C", "D"]:
                err(f"{where}: options must be labelled A, B, C, D in order")
            correct = [o for o in opts if o.get("isCorrect") is True]
            if len(correct) != 1:
                err(f"{where}: {len(correct)} correct options (need exactly 1)")
            else:
                labels[correct[0]["label"]] += 1
            if len({o.get("text") for o in opts}) != len(opts):
                err(f"{where}: duplicate option text")
            if q["rubric"] is not None:
                err(f"{where}: MCQ rubric must be null")
            if q["isDiagnostic"]:
                diag_per[q["concept"]] += 1
                if q["difficulty"] != 0.5:
                    err(f"{where}: diagnostic MCQ must be medium (0.5)")
        elif q["type"] == "short":
            short_per[q["concept"]] += 1
            if q["options"]:
                err(f"{where}: short answer must have options: []")
            if q["isDiagnostic"]:
                err(f"{where}: short answers cannot be diagnostic")
            r = q["rubric"]
            if not isinstance(r, dict) or not require(r, ["criteria", "modelAnswer"], f"{where}.rubric"):
                continue
            crit = r["criteria"]
            if not 2 <= len(crit) <= 4:
                err(f"{where}: rubric needs 2-4 criteria, has {len(crit)}")
            total = sum(c.get("points", 0) for c in crit)
            if not 3 <= total <= 5:
                err(f"{where}: rubric total {total} points (need 3-5)")
            ids = [c.get("id") for c in crit]
            if len(set(ids)) != len(ids) or any(not c.get("description") for c in crit):
                err(f"{where}: rubric criteria need unique ids and descriptions")
            if not r["modelAnswer"].strip():
                err(f"{where}: empty model answer")
        else:
            err(f"{where}: unknown type {q['type']}")

    for s, n in stems.items():
        if n > 1:
            err(f"duplicate stem: {s[:60]}")
    for c in concepts:
        if mcq_per[c] < 7:
            err(f"concept {c}: {mcq_per[c]} MCQs (need >= 7)")
        if diag_per[c] != 1:
            err(f"concept {c}: {diag_per[c]} diagnostic MCQs (need exactly 1)")
        if len(diff_per[c]) < 3:
            warn(f"concept {c}: MCQs do not cover all three difficulties")
    total_short = sum(short_per.values())
    if total_short < 10:
        err(f"only {total_short} short-answer questions (need >= 10)")
    if sum(mcq_per.values()) < 84:
        err(f"only {sum(mcq_per.values())} MCQs (need >= 84)")

    required = "Which statement about the chain rule in backpropagation is correct?"
    hit = [q for q in qs if q["stem"] == required]
    if not hit:
        err("required backpropagation question missing")
    else:
        q = hit[0]
        ok = (q["concept"] == "backpropagation" and q["difficulty"] == 0.5
              and [o["text"] for o in q["options"]] == [
                  "Gradients are computed from the input forward",
                  "Each layer multiplies the incoming gradient by its local derivative",
                  "Weights are updated before gradients exist",
                  "Only the final layer receives a gradient"]
              and [o["isCorrect"] for o in q["options"]] == [False, True, False, False])
        if not ok:
            err("required backpropagation question does not match the specification")

    print(f"questions.json: {len(qs)} questions ({sum(mcq_per.values())} MCQ, {total_short} short); "
          f"correct labels {dict(sorted(labels.items()))}")
    print("  per concept (mcq/short/diag): " + ", ".join(
        f"{c} {mcq_per[c]}/{short_per[c]}/{diag_per[c]}" for c in concepts))


# --------------------------------------------------------------------------- datasets
def load_jsonl(name: str) -> list[dict]:
    path = DATASETS / name
    if not path.exists():
        err(f"dataset missing: {name}")
        return []
    rows = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as e:
            err(f"{name}:{n}: invalid JSON ({e})")
    ids = [r.get("id") for r in rows]
    for i, c in Counter(ids).items():
        if c > 1 or i is None:
            err(f"{name}: duplicate or missing id {i}")
    if name in EXPECTED_SIZES and len(rows) != EXPECTED_SIZES[name]:
        err(f"{name}: {len(rows)} rows (expected {EXPECTED_SIZES[name]})")
    return rows


def validate_datasets(titles: dict) -> None:
    lesson_text = {t: (COURSE_DIR / l["file"]).read_text(encoding="utf-8").lower() for t, l in titles.items()}

    ret = load_jsonl("retrieval.jsonl")
    covered = set()
    for r in ret:
        where = f"retrieval {r.get('id')}"
        if not require(r, ["id", "question", "expected_lesson_titles", "expected_keywords"], where):
            continue
        if not r["expected_lesson_titles"] or not r["expected_keywords"]:
            err(f"{where}: empty expectations")
        for t in r["expected_lesson_titles"]:
            if t not in titles:
                err(f"{where}: unknown lesson title {t!r}")
            covered.add(t)
        texts = [lesson_text[t] for t in r["expected_lesson_titles"] if t in lesson_text]
        for kw in r["expected_keywords"]:
            if texts and not any(kw.lower() in tx for tx in texts):
                err(f"{where}: keyword {kw!r} not found in expected lesson text")
    missing = set(titles) - covered
    if missing:
        err(f"retrieval.jsonl does not cover lessons: {sorted(missing)}")

    tut = load_jsonl("tutor.jsonl")
    for r in tut:
        where = f"tutor {r.get('id')}"
        if not require(r, ["id", "question", "level", "mode", "must_include_any", "must_cite"], where):
            continue
        if r["level"] not in {"beginner", "intermediate", "advanced"}:
            err(f"{where}: bad level {r['level']}")
        if r["mode"] not in {"explain", "hint", "quiz_me"}:
            err(f"{where}: bad mode {r['mode']}")
        if not r["must_include_any"] or not isinstance(r["must_cite"], bool):
            err(f"{where}: must_include_any empty or must_cite not boolean")
    if sum(1 for r in tut if r.get("must_cite") is False) < 3:
        err("tutor.jsonl needs at least 3 out-of-scope cases (must_cite: false)")

    for r in load_jsonl("injection.jsonl"):
        where = f"injection {r.get('id')}"
        if not require(r, ["id", "question", "hostile_passage", "forbidden_patterns"], where):
            continue
        if not r["forbidden_patterns"]:
            err(f"{where}: no forbidden patterns")
        matched = False
        for p in r["forbidden_patterns"]:
            try:
                rx = re.compile(p)
            except re.error as e:
                err(f"{where}: bad regex {p!r} ({e})")
                continue
            matched = matched or bool(rx.search(r["hostile_passage"]))
        # Sanity check: at least one pattern should describe the payload the passage tries to plant.
        if not matched:
            warn(f"{where}: no forbidden pattern matches the hostile passage's payload")

    for r in load_jsonl("grading.jsonl"):
        where = f"grading {r.get('id')}"
        if not require(r, ["id", "question", "rubric", "answer", "human_score", "max_score"], where):
            continue
        crit = r["rubric"].get("criteria", [])
        total = sum(c.get("points", 0) for c in crit)
        if total != r["max_score"]:
            err(f"{where}: max_score {r['max_score']} != rubric total {total}")
        if not 0 <= r["human_score"] <= r["max_score"]:
            err(f"{where}: human_score out of range")
        if not r["rubric"].get("modelAnswer"):
            err(f"{where}: rubric missing modelAnswer")

    print(f"datasets: retrieval {len(ret)}, tutor {len(tut)}, injection/grading checked")


def main() -> int:
    concepts, lessons, titles = validate_course()
    validate_questions(concepts, lessons)
    validate_datasets(titles)
    for w in warnings:
        print(f"WARNING: {w}")
    for e in errors:
        print(f"ERROR: {e}")
    print("OK" if not errors else f"FAILED with {len(errors)} error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
