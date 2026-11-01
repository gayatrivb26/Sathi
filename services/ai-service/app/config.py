"""Validated service configuration (contracts §2). Startup fails fast on missing/invalid values."""

from __future__ import annotations

import base64
import binascii
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal

from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from pydantic import Field, PrivateAttr, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

Env = Literal["development", "test", "staging", "production"]

# USD per 1M tokens. Cache writes bill 1.25x input, cache reads ~0.1x input.
DEFAULT_PRICING: dict[str, dict[str, float]] = {
    "claude-opus-5-5": {"input": 4.0, "output": 20.0},
    "claude-sonnet-5-5": {"input": 2.0, "output": 10.0},
    "claude-haiku-5-5": {"input": 0.10, "output": 0.50},
    "fake": {"input": 0.0, "output": 0.0},
}

DEFAULT_REPUTABLE_DOMAINS = (
    "wikipedia.org,arxiv.org,python.org,pytorch.org,scikit-learn.org,numpy.org,pandas.pydata.org,"
    "huggingface.co,developer.mozilla.org,learn.microsoft.com,cloud.google.com,aws.amazon.com,"
    "stanford.edu,mit.edu,berkeley.edu,cmu.edu,ox.ac.uk,cam.ac.uk,nature.com,acm.org,ieee.org,"
    "postgresql.org,github.com,khanacademy.org,britannica.com,.edu,.gov,.ac.in,.ac.uk"
)


_KID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
MIN_RSA_BITS = 2048


def parse_public_keys(raw: str) -> dict[str | None, RSAPublicKey]:
    """Parse ``SERVICE_TOKEN_PUBLIC_KEYS``: ``kid:base64(SPKI PEM)[,kid:...]`` or one kid-less ``base64(PEM)``.

    Every key must be an RSA public key of at least 2048 bits; kids must be unique. A kid-less entry is only
    allowed on its own (it then verifies tokens whatever their ``kid``).
    """
    entries = [e.strip() for e in raw.split(",") if e.strip()]
    if not entries:
        raise ValueError("SERVICE_TOKEN_PUBLIC_KEYS must contain at least one key")
    keys: dict[str | None, RSAPublicKey] = {}
    for entry in entries:
        kid: str | None
        kid, sep, b64 = entry.partition(":")
        if not sep:  # base64 never contains ':', so no separator means a kid-less entry
            kid, b64 = None, entry
        elif not _KID.match(kid):
            raise ValueError(f"SERVICE_TOKEN_PUBLIC_KEYS: invalid key id {kid!r}")
        if kid in keys:
            raise ValueError(f"SERVICE_TOKEN_PUBLIC_KEYS: duplicate key id {kid!r}")
        try:
            pem = base64.b64decode(b64.strip(), validate=True)
            key = load_pem_public_key(pem)
        except (binascii.Error, ValueError, TypeError, UnsupportedAlgorithm) as exc:
            raise ValueError(
                f"SERVICE_TOKEN_PUBLIC_KEYS: entry {kid or '(no kid)'} is not base64 of an SPKI PEM public key"
            ) from exc
        if not isinstance(key, RSAPublicKey):
            raise ValueError(f"SERVICE_TOKEN_PUBLIC_KEYS: entry {kid or '(no kid)'} is not an RSA key")
        if key.key_size < MIN_RSA_BITS:
            raise ValueError(
                f"SERVICE_TOKEN_PUBLIC_KEYS: entry {kid or '(no kid)'} is shorter than {MIN_RSA_BITS} bits"
            )
        keys[kid] = key
    if None in keys and len(keys) > 1:
        raise ValueError("SERVICE_TOKEN_PUBLIC_KEYS: a key without 'kid:' is only allowed as the single entry")
    return keys


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore", case_sensitive=False)

    # --- shared ---
    sathi_env: Env = "development"
    sathi_version: str = "0.1.0"
    ai_instance_role: Literal["all", "ingest"] = "all"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_hash_salt: SecretStr
    # Comma-separated ``kid:base64(SPKI PEM)`` entries (contracts §11.7); a single entry may omit ``kid:``.
    service_token_public_keys: str
    service_token_leeway_seconds: int = 30
    _token_public_keys: dict[str | None, RSAPublicKey] = PrivateAttr(default_factory=dict)

    # --- database / storage ---
    database_url: str
    db_pool_size: int = 10
    db_max_overflow: int = 5
    db_slow_query_ms: int = 500
    storage_endpoint: str
    storage_access_key: SecretStr
    storage_secret_key: SecretStr
    storage_bucket: str = "sathi-documents"
    storage_region: str = "us-east-1"

    # --- prompts / evaluation ---
    prompts_dir: Path = Path("/app/prompts")
    prompt_versions: Annotated[dict[str, int], NoDecode] = Field(default_factory=dict)
    eval_datasets_dir: Path = Path("/app/eval-datasets")

    # --- LLM ---
    anthropic_api_key: SecretStr = SecretStr("")
    llm_provider: Literal["anthropic", "fake"] | None = None
    llm_model: str = "claude-opus-5-5"
    llm_fallback_model: str = "claude-sonnet-5-5"
    llm_server_fallbacks: bool = True
    llm_daily_spend_cap_usd: float = 5.0
    llm_timeout_seconds: float = 90.0
    llm_max_retries: int = 2
    llm_tutor_max_tokens: int = 4096
    llm_tutor_effort: Literal["low", "medium", "high"] = "low"
    llm_structured_effort: Literal["low", "medium", "high"] = "medium"
    llm_structured_max_tokens: int = 8192
    llm_pricing: Annotated[dict[str, dict[str, float]], NoDecode] = Field(default_factory=lambda: dict(DEFAULT_PRICING))
    llm_record_mode: Literal["off", "record", "replay"] = "off"
    llm_recordings_dir: Path = Path("tests/recordings")
    ai_kill_switch: bool = False

    # --- embeddings ---
    embedding_provider: Literal["fastembed", "fake"] = "fastembed"
    embedding_model: str = "BAAI/bge-small-en-v1.5"
    embedding_dim: int = 384
    fastembed_cache_path: Path | None = None
    fastembed_offline: bool = False

    # --- retrieval ---
    rag_vector_k: int = 20
    rag_keyword_k: int = 20
    rag_rrf_k: int = 60
    rag_top_k: int = 6
    rag_min_vector_similarity: float = 0.5
    rag_hnsw_ef_search: int = 100

    # --- ingestion ---
    ingest_concurrency: int = 2
    ingest_chunk_tokens: int = 350
    ingest_chunk_overlap: float = 0.15
    ingest_max_parsed_chars: int = 5_000_000

    # --- web search ---
    search_provider: Literal["tavily", "brave", "fake", "none"] | None = None
    tavily_api_key: SecretStr = SecretStr("")
    brave_api_key: SecretStr = SecretStr("")
    web_search_daily_spend_cap_usd: float = 1.0
    web_search_cost_per_query_usd: float = 0.008
    web_search_timeout_seconds: float = 6.0
    web_search_max_results: int = 5
    web_fetch_pages: int = 3
    web_fetch_timeout_seconds: float = 5.0
    web_fetch_max_bytes: int = 1_572_864  # 1.5 MB
    web_fetch_max_redirects: int = 3
    web_fetch_allowed_ports: Annotated[list[int], NoDecode] = Field(default_factory=lambda: [80, 443])
    web_passages_max: int = 4
    web_cache_hours: int = 24
    web_reputable_domains: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: [d.strip() for d in DEFAULT_REPUTABLE_DOMAINS.split(",")]
    )
    search_query_rewrite: Literal["rules", "llm"] = "rules"

    # --- observability ---
    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str | None = None

    # --- debug capture ---
    debug_capture_retention_hours: int = 72

    # ------------------------------------------------------------------ validators
    @field_validator("prompt_versions", "llm_pricing", mode="before")
    @classmethod
    def _parse_json_dict(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.strip()
            if not v:
                return {}
            return json.loads(v)
        return v

    @field_validator("web_reputable_domains", mode="before")
    @classmethod
    def _parse_csv(cls, v: Any) -> Any:
        if isinstance(v, str):
            return [d.strip().lower() for d in v.split(",") if d.strip()]
        return v

    @field_validator("web_fetch_allowed_ports", mode="before")
    @classmethod
    def _parse_ports(cls, v: Any) -> Any:
        if isinstance(v, str):
            return [int(p) for p in v.split(",") if p.strip()]
        return v

    @field_validator("database_url")
    @classmethod
    def _db_url(cls, v: str) -> str:
        if not v.startswith(("postgresql+psycopg://", "postgresql://", "postgres://")):
            raise ValueError("DATABASE_URL must be a postgresql+psycopg:// URL")
        if v.startswith("postgres://"):
            v = "postgresql://" + v[len("postgres://") :]
        if v.startswith("postgresql://"):
            v = "postgresql+psycopg://" + v[len("postgresql://") :]
        return v

    @field_validator("service_token_public_keys")
    @classmethod
    def _public_keys(cls, v: str) -> str:
        parse_public_keys(v)  # fail fast; the parsed keys are attached in _derive
        return v.strip()

    @field_validator("log_hash_salt")
    @classmethod
    def _salt(cls, v: SecretStr) -> SecretStr:
        if not v.get_secret_value():
            raise ValueError("LOG_HASH_SALT must not be empty")
        return v

    @field_validator("ingest_chunk_overlap")
    @classmethod
    def _overlap(cls, v: float) -> float:
        if not 0 <= v < 0.5:
            raise ValueError("INGEST_CHUNK_OVERLAP must be in [0, 0.5)")
        return v

    @model_validator(mode="after")
    def _derive(self) -> Settings:
        self._token_public_keys = parse_public_keys(self.service_token_public_keys)
        has_key = bool(self.anthropic_api_key.get_secret_value().strip())
        if self.llm_provider is None:
            self.llm_provider = "anthropic" if has_key else "fake"
        if self.llm_provider == "anthropic" and not has_key:
            raise ValueError("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY")
        if self.search_provider is None:
            if self.tavily_api_key.get_secret_value():
                self.search_provider = "tavily"
            elif self.brave_api_key.get_secret_value():
                self.search_provider = "brave"
            else:
                self.search_provider = "fake" if self.sathi_env in ("development", "test") else "none"
        if self.search_provider == "tavily" and not self.tavily_api_key.get_secret_value():
            raise ValueError("SEARCH_PROVIDER=tavily requires TAVILY_API_KEY")
        if self.search_provider == "brave" and not self.brave_api_key.get_secret_value():
            raise ValueError("SEARCH_PROVIDER=brave requires BRAVE_API_KEY")
        if self.embedding_dim != 384:
            raise ValueError("EMBEDDING_DIM must be 384 (ai.chunk_embeddings is vector(384))")
        for model in {self.llm_model, self.llm_fallback_model}:
            if self.llm_provider == "anthropic" and model not in self.llm_pricing:
                raise ValueError(f"LLM_PRICING has no entry for model {model!r}")
        return self

    # ------------------------------------------------------------------ helpers
    @property
    def service_name(self) -> str:
        if self.otel_service_name:
            return self.otel_service_name
        return "ai-ingest" if self.ai_instance_role == "ingest" else "ai-service"

    @property
    def token_public_keys(self) -> dict[str | None, RSAPublicKey]:
        """Service-token verification keys by ``kid`` (``None`` = the single kid-less key)."""
        return self._token_public_keys

    @property
    def is_production(self) -> bool:
        return self.sathi_env == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
