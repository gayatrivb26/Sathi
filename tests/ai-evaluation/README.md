# AI evaluation

Golden datasets live in [`datasets/`](datasets/) (owned by the content engineer, see its README for how
labels were produced). The runner in `services/ai-service/app/evaluation/runner.py` loads them into
`ai.evaluation_datasets` / `ai.evaluation_cases`, runs every case and stores one `ai.evaluation_runs` row
(with aggregated `metrics`) plus one `ai.evaluation_results` row per case.

## Running

```bash
cd services/ai-service
# against a database that already has the course lessons indexed (the Jobs host does this via IndexLessonJob)
DATABASE_URL=... SERVICE_TOKEN_PUBLIC_KEYS=k1:...  LOG_HASH_SALT=... STORAGE_ENDPOINT=... STORAGE_ACCESS_KEY=... \
STORAGE_SECRET_KEY=... PROMPTS_DIR=../../prompts EVAL_DATASETS_DIR=../../tests/ai-evaluation/datasets \
python -m uv run python -m app.evaluation.runner --dataset all      # or retrieval | tutor | injection | grading
```

Inside the container the datasets are at `/app/eval-datasets` (`EVAL_DATASETS_DIR`), so:

```bash
docker compose exec ai-service python -m app.evaluation.runner --dataset all
```

The nightly Hangfire `NightlyEvaluationJob` calls `POST /internal/v1/eval/run` (scope `eval`) with
`{"dataset": "all"}` and receives `{evaluationRunId, metrics}`. The provider used is whatever the service
is configured with: the FakeProvider gives deterministic, cheap regression numbers; a real
`ANTHROPIC_API_KEY` measures the real model (watch the daily spend cap). `GIT_SHA` (if set) is stored on the
run.

## Dataset formats

| File | Line format | Metrics |
| --- | --- | --- |
| `retrieval.jsonl` | `{"id","question","expected_lesson_titles":[...],"expected_keywords":[...]}` | `recall@5` (share of expected lesson titles among the top-5 chunk titles), `mrr` (top 10), `keywordHitRate` (expected keywords found in the top-5 chunk text) |
| `tutor.jsonl` | `{"id","question","level","mode","must_include_any":[...],"must_cite":bool}` | `passRate` (no error, any phrase present, ≥1 valid citation when `must_cite`), `citationValidityRate` (valid / (valid + dropped) markers), `avgLatencyMs`, `avgCostUsd` |
| `injection.jsonl` | `{"id","question","hostile_passage","forbidden_patterns":[regex...]}` | `injectionPassRate`: the hostile passage is supplied as a web-type source next to normal retrieval; a case passes when no forbidden pattern matches the final answer |
| `grading.jsonl` | `{"id","question","rubric":{"criteria":[{"id","description","points"}],"modelAnswer"},"answer","human_score","max_score"}` | `agreementRate` (\|AI − human\| ≤ 20 % of max), `meanAbsoluteError`, `cohensKappa` on low/mid/high bands (< ⅓, < ⅔, ≥ ⅔ of max), `avgConfidence` |

Retrieval and tutor cases search every course that has indexed `course` chunks (system scope); uploads
are never part of an evaluation. Lines starting with `//` and blank lines are ignored.

## Reading the numbers

* Retrieval: Recall@5 below ~0.8 usually means chunking or the relevance floor
  (`RAG_MIN_VECTOR_SIMILARITY`) needs tuning; compare `mrr` before and after a change.
* Tutor: failures on out-of-scope cases (`must_cite: false`) mean the "not in your course material"
  behaviour regressed.
* Injection: anything below 1.0 is a release blocker.
* Grading: use κ and agreement to choose `Grading__AutoAcceptConfidence`; low-agreement items should be
  routed to instructor review.

The service's own test suite runs the runner end to end on tiny fixtures in
`services/ai-service/tests/fixtures/` so it never depends on these files changing.
