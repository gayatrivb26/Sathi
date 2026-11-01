# syntax=docker/dockerfile:1.7
# Sathi AI service (also used for ai-ingest and migrator-ai).
# Build context = repository root:
#   docker build -f services/ai-service/Dockerfile -t sathi-ai:dev .
ARG PYTHON_IMAGE=python:3.12-slim

# ---------------------------------------------------------------- builder
FROM ${PYTHON_IMAGE} AS builder
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
RUN pip install "uv==0.13.1"
WORKDIR /build
COPY services/ai-service/pyproject.toml services/ai-service/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# Bake the embedding model into the image so the runtime never downloads it.
RUN /opt/venv/bin/python -c "\
from fastembed import TextEmbedding; \
m = TextEmbedding('BAAI/bge-small-en-v1.5', cache_dir='/opt/models'); \
v = next(iter(m.embed(['warm up']))); \
assert len(v) == 384, len(v); print('embedding model baked, dim', len(v))"

# ---------------------------------------------------------------- runtime
FROM ${PYTHON_IMAGE} AS runtime
LABEL org.opencontainers.image.title="sathi-ai-service" \
      org.opencontainers.image.description="Sathi AI service (FastAPI): tutor, RAG, ingestion, grading, evaluation"
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    PROMPTS_DIR=/app/prompts \
    EVAL_DATASETS_DIR=/app/eval-datasets \
    FASTEMBED_CACHE_PATH=/app/models \
    FASTEMBED_OFFLINE=true \
    HF_HUB_OFFLINE=1 \
    HF_HOME=/tmp/hf \
    TMPDIR=/tmp \
    AI_INSTANCE_ROLE=all
RUN groupadd --system --gid 10001 sathi \
 && useradd --system --uid 10001 --gid sathi --home-dir /app --no-create-home --shell /usr/sbin/nologin sathi
WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /opt/models /app/models
COPY services/ai-service/alembic.ini ./alembic.ini
COPY services/ai-service/migrations ./migrations
COPY services/ai-service/app ./app
COPY prompts ./prompts
# Golden datasets are optional: copy the folder (README always exists) and keep only *.jsonl.
COPY tests/ai-evaluation /tmp/ai-evaluation
RUN mkdir -p /app/eval-datasets \
 && (cp /tmp/ai-evaluation/datasets/*.jsonl /app/eval-datasets/ 2>/dev/null || true) \
 && rm -rf /tmp/ai-evaluation \
 && python -m compileall -q /app/app \
 && chown -R sathi:sathi /app/models
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health/live', timeout=4).status == 200 else 1)"]
# migrator-ai overrides the command with: alembic upgrade head
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--no-access-log", "--timeout-graceful-shutdown", "20"]
