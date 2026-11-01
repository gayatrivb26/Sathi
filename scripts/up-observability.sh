#!/usr/bin/env bash
# Start the stack with the observability profile (OTel Collector, Loki, Tempo, Prometheus,
# Grafana) and point every service's OpenTelemetry exporter at the collector.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_docker
ensure_env
export OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector:4317"
docker compose --profile observability up -d --build --wait "$@"
echo
echo "Grafana:    http://localhost:3000   (dashboards in folder 'Sathi')"
echo "Prometheus: http://localhost:9090/alerts"
