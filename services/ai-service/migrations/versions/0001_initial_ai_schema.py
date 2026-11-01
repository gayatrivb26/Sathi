"""Initial ai schema (contracts §3.2).

Revision ID: 0001_initial
Revises:
Create Date: 2026-10-17
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _require_vector() -> None:
    # Extensions are created by the Postgres init script (superuser) in schema `extensions`, which is on the
    # sathi_ai search_path. We never CREATE EXTENSION here (no superuser); fail with a clear message instead.
    op.execute(
        """
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
            RAISE EXCEPTION 'extension "vector" is missing: run the Postgres init script (CREATE EXTENSION vector)';
          END IF;
          IF to_regtype('vector') IS NULL THEN
            RAISE EXCEPTION 'type "vector" is not on the search_path (expected schema "extensions")';
          END IF;
        END $$;
        """
    )


def upgrade() -> None:
    _require_vector()

    op.execute(
        """
        CREATE TABLE ai.document_chunks (
            id uuid PRIMARY KEY,
            document_id uuid NOT NULL,
            document_version int NOT NULL,
            scope text NOT NULL CHECK (scope IN ('user', 'course')),
            owner_user_id uuid NULL,
            course_id uuid NULL,
            lesson_id uuid NULL,
            source_type text NOT NULL CHECK (source_type IN ('course', 'upload')),
            title text NOT NULL,
            page int NULL,
            section text NULL,
            chunk_index int NOT NULL,
            content text NOT NULL,
            token_count int NOT NULL,
            content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_document_chunks_doc_ver_idx UNIQUE (document_id, document_version, chunk_index),
            CONSTRAINT ck_document_chunks_scope_owner CHECK (
                (scope = 'user' AND owner_user_id IS NOT NULL) OR (scope = 'course' AND course_id IS NOT NULL)
            )
        );
        CREATE INDEX ix_document_chunks_tsv ON ai.document_chunks USING gin (content_tsv);
        CREATE INDEX ix_document_chunks_scope_course ON ai.document_chunks (scope, course_id);
        CREATE INDEX ix_document_chunks_owner ON ai.document_chunks (owner_user_id);

        CREATE TABLE ai.chunk_embeddings (
            chunk_id uuid PRIMARY KEY REFERENCES ai.document_chunks (id) ON DELETE CASCADE,
            model text NOT NULL,
            dim int NOT NULL,
            embedding vector(384) NOT NULL
        );
        CREATE INDEX ix_chunk_embeddings_hnsw ON ai.chunk_embeddings
            USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

        CREATE TABLE ai.retrieval_runs (
            id uuid PRIMARY KEY,
            run_id uuid NULL,
            trace_id text NULL,
            query_hash text NOT NULL,
            method text NOT NULL CHECK (method IN ('vector', 'keyword', 'hybrid')),
            scope_course_count int NOT NULL,
            scope_includes_uploads bool NOT NULL,
            top_k int NOT NULL,
            result_count int NOT NULL,
            timings jsonb NOT NULL DEFAULT '{}'::jsonb,
            empty bool NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX ix_retrieval_runs_run ON ai.retrieval_runs (run_id);

        CREATE TABLE ai.retrieved_sources (
            id uuid PRIMARY KEY,
            retrieval_run_id uuid NULL,
            run_id uuid NULL,
            rank int NOT NULL,
            source_type text NOT NULL CHECK (source_type IN ('course', 'upload', 'web')),
            chunk_id uuid NULL,
            document_id uuid NULL,
            url text NULL,
            title text NOT NULL,
            score real NOT NULL,
            vector_rank int NULL,
            keyword_rank int NULL,
            cited bool NOT NULL DEFAULT false
        );
        CREATE INDEX ix_retrieved_sources_run ON ai.retrieved_sources (run_id);
        CREATE INDEX ix_retrieved_sources_retrieval_run ON ai.retrieved_sources (retrieval_run_id);

        CREATE TABLE ai.search_runs (
            id uuid PRIMARY KEY,
            run_id uuid NULL,
            trace_id text NULL,
            query_hash text NOT NULL,
            provider text NOT NULL,
            result_count int NOT NULL,
            urls jsonb NOT NULL DEFAULT '[]'::jsonb,
            latency_ms int NOT NULL,
            cache_hit bool NOT NULL,
            outcome text NOT NULL CHECK (outcome IN ('ok', 'empty', 'failed', 'skipped')),
            error_code text NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX ix_search_runs_run ON ai.search_runs (run_id);
        CREATE INDEX ix_search_runs_created ON ai.search_runs (created_at);

        CREATE TABLE ai.search_cache (
            query_hash text PRIMARY KEY,
            provider text NOT NULL,
            results jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            expires_at timestamptz NOT NULL
        );
        CREATE INDEX ix_search_cache_expires ON ai.search_cache (expires_at);

        CREATE TABLE ai.model_configurations (
            id uuid PRIMARY KEY,
            name text NOT NULL,
            provider text NOT NULL,
            model text NOT NULL,
            params jsonb NOT NULL DEFAULT '{}'::jsonb,
            is_active bool NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE ai.model_runs (
            id uuid PRIMARY KEY,
            run_id uuid NULL,
            trace_id text NULL,
            purpose text NOT NULL CHECK (purpose IN ('tutor', 'query_rewrite', 'quiz_generation', 'grading', 'evaluation')),
            provider text NOT NULL,
            model text NOT NULL,
            prompt_name text NOT NULL,
            prompt_version int NOT NULL,
            prompt_hash text NOT NULL,
            params jsonb NOT NULL DEFAULT '{}'::jsonb,
            input_tokens int NOT NULL DEFAULT 0,
            output_tokens int NOT NULL DEFAULT 0,
            estimated_cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
            ttft_ms int NULL,
            latency_ms int NOT NULL DEFAULT 0,
            retries int NOT NULL DEFAULT 0,
            finish_reason text NOT NULL,
            error_code text NULL,
            fallback_used bool NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX ix_model_runs_run ON ai.model_runs (run_id);
        CREATE INDEX ix_model_runs_created ON ai.model_runs (created_at);

        CREATE TABLE ai.agent_runs (
            id uuid PRIMARY KEY,
            run_id uuid NULL,
            trace_id text NULL,
            status text NOT NULL,
            started_at timestamptz NOT NULL DEFAULT now(),
            finished_at timestamptz NULL,
            metrics jsonb NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE TABLE ai.tool_invocations (
            id uuid PRIMARY KEY,
            agent_run_id uuid NOT NULL REFERENCES ai.agent_runs (id) ON DELETE CASCADE,
            tool_name text NOT NULL,
            arguments_hash text NOT NULL,
            authorized bool NOT NULL,
            outcome text NOT NULL,
            duration_ms int NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE ai.debug_captures (
            id uuid PRIMARY KEY,
            run_id uuid NULL,
            conversation_id uuid NULL,
            user_id_hash text NULL,
            prompt text NOT NULL,
            response text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            expires_at timestamptz NOT NULL
        );
        CREATE INDEX ix_debug_captures_expires ON ai.debug_captures (expires_at);
        CREATE INDEX ix_debug_captures_run ON ai.debug_captures (run_id);

        CREATE TABLE ai.debug_capture_settings (
            conversation_id uuid PRIMARY KEY,
            enabled bool NOT NULL,
            expires_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE ai.evaluation_datasets (
            id uuid PRIMARY KEY,
            name text NOT NULL UNIQUE,
            kind text NOT NULL CHECK (kind IN ('retrieval', 'tutor', 'grading', 'injection')),
            description text NULL,
            case_count int NOT NULL DEFAULT 0,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE ai.evaluation_cases (
            id uuid PRIMARY KEY,
            dataset_id uuid NOT NULL REFERENCES ai.evaluation_datasets (id) ON DELETE CASCADE,
            external_id text NOT NULL,
            input jsonb NOT NULL,
            expected jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_evaluation_cases_dataset_ext UNIQUE (dataset_id, external_id)
        );
        CREATE TABLE ai.evaluation_runs (
            id uuid PRIMARY KEY,
            dataset_id uuid NULL REFERENCES ai.evaluation_datasets (id) ON DELETE SET NULL,
            dataset_name text NOT NULL,
            status text NOT NULL DEFAULT 'running',
            started_at timestamptz NOT NULL DEFAULT now(),
            finished_at timestamptz NULL,
            metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
            git_sha text NULL,
            provider text NULL,
            model text NULL
        );
        CREATE INDEX ix_evaluation_runs_started ON ai.evaluation_runs (started_at DESC);
        CREATE TABLE ai.evaluation_results (
            id uuid PRIMARY KEY,
            run_id uuid NOT NULL REFERENCES ai.evaluation_runs (id) ON DELETE CASCADE,
            case_id uuid NULL REFERENCES ai.evaluation_cases (id) ON DELETE SET NULL,
            passed bool NOT NULL,
            scores jsonb NOT NULL DEFAULT '{}'::jsonb,
            output jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX ix_evaluation_results_run ON ai.evaluation_results (run_id);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP TABLE IF EXISTS ai.evaluation_results;
        DROP TABLE IF EXISTS ai.evaluation_runs;
        DROP TABLE IF EXISTS ai.evaluation_cases;
        DROP TABLE IF EXISTS ai.evaluation_datasets;
        DROP TABLE IF EXISTS ai.debug_capture_settings;
        DROP TABLE IF EXISTS ai.debug_captures;
        DROP TABLE IF EXISTS ai.tool_invocations;
        DROP TABLE IF EXISTS ai.agent_runs;
        DROP TABLE IF EXISTS ai.model_runs;
        DROP TABLE IF EXISTS ai.model_configurations;
        DROP TABLE IF EXISTS ai.search_cache;
        DROP TABLE IF EXISTS ai.search_runs;
        DROP TABLE IF EXISTS ai.retrieved_sources;
        DROP TABLE IF EXISTS ai.retrieval_runs;
        DROP TABLE IF EXISTS ai.chunk_embeddings;
        DROP TABLE IF EXISTS ai.document_chunks;
        """
    )
