"""OpenTelemetry setup.

A TracerProvider is always installed so incoming W3C ``traceparent`` headers are continued and every log
line gets ``trace_id``/``span_id``. Spans, metrics and logs are exported over OTLP only when
``OTEL_EXPORTER_OTLP_ENDPOINT`` is set.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from opentelemetry import metrics, trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider

from app.logging import get_logger, json_formatter

if TYPE_CHECKING:
    from fastapi import FastAPI
    from sqlalchemy.ext.asyncio import AsyncEngine

    from app.config import Settings

log = get_logger(__name__)
_state: dict[str, Any] = {"configured": False, "httpx": False}


def setup_telemetry(settings: Settings) -> None:
    if _state["configured"]:
        return
    resource = Resource.create(
        {
            "service.name": settings.service_name,
            "service.version": settings.sathi_version,
            "deployment.environment": settings.sathi_env,
        }
    )
    provider = TracerProvider(resource=resource)
    endpoint = settings.otel_exporter_otlp_endpoint.strip()
    if endpoint:
        from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
        from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        insecure = endpoint.startswith("http://")
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint, insecure=insecure)))
        reader = PeriodicExportingMetricReader(
            OTLPMetricExporter(endpoint=endpoint, insecure=insecure), export_interval_millis=15000
        )
        metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[reader]))

        logger_provider = LoggerProvider(resource=resource)
        logger_provider.add_log_record_processor(
            BatchLogRecordProcessor(OTLPLogExporter(endpoint=endpoint, insecure=insecure))
        )
        handler = LoggingHandler(level=logging.DEBUG, logger_provider=logger_provider)
        handler.setFormatter(json_formatter())
        logging.getLogger().addHandler(handler)
        log.info("telemetry.configured", message="OTLP export enabled", otlp_endpoint=endpoint)
    trace.set_tracer_provider(provider)

    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().instrument()
        _state["httpx"] = True
    except Exception as exc:  # pragma: no cover - optional instrumentation
        log.warning("telemetry.instrumentation_failed", component="httpx", exception_type=type(exc).__name__)
    _state["configured"] = True


def instrument_app(app: FastAPI) -> None:
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    FastAPIInstrumentor.instrument_app(app, excluded_urls="health/live,health/ready")


def instrument_engine(engine: AsyncEngine) -> None:
    try:
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

        SQLAlchemyInstrumentor().instrument(engine=engine.sync_engine)
    except Exception as exc:  # pragma: no cover
        log.warning("telemetry.instrumentation_failed", component="sqlalchemy", exception_type=type(exc).__name__)


def tracer() -> trace.Tracer:
    return trace.get_tracer("sathi.ai")


class Metrics:
    """AI metrics, exported only when OTLP is configured. Units are "{ms}" or none so the Prometheus exporter
    keeps the names: sathi_llm_calls_total{outcome}, sathi_llm_latency_ms, sathi_retrieval_latency_ms,
    sathi_web_search_total{outcome}."""

    def __init__(self) -> None:
        meter = metrics.get_meter("sathi.ai")
        self.llm_calls = meter.create_counter("sathi_llm_calls", description="LLM calls by outcome")
        self.llm_tokens = meter.create_counter("sathi_llm_tokens", description="LLM tokens by direction")
        self.llm_cost = meter.create_counter("sathi_llm_cost_usd", description="Estimated LLM cost in USD")
        self.llm_latency = meter.create_histogram("sathi_llm_latency_ms", unit="{ms}")
        self.llm_ttft = meter.create_histogram("sathi_llm_ttft_ms", unit="{ms}")
        self.retrievals = meter.create_counter("sathi_retrieval", description="Retrievals by method")
        self.retrieval_latency = meter.create_histogram("sathi_retrieval_latency_ms", unit="{ms}")
        self.web_searches = meter.create_counter("sathi_web_search", description="Web searches by outcome")
        self.citations = meter.create_counter("sathi_citations")
        self.ingest_steps = meter.create_counter("sathi_ingest_steps")


_metrics: Metrics | None = None


def get_metrics() -> Metrics:
    global _metrics
    if _metrics is None:
        _metrics = Metrics()
    return _metrics
