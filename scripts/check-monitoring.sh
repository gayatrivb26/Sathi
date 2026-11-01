#!/usr/bin/env bash
# Static checks for infrastructure config (also run in CI):
# compose files, Prometheus rules + unit tests, Prometheus config, OTel Collector config, nginx.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_docker
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: keep container paths as-is
here="$(pwd -W 2>/dev/null || pwd)"
envfile=".env"; [[ -f "${envfile}" ]] || envfile=".env.example"

echo "== docker compose config"
for files in "-f compose.yaml" "-f compose.yaml -f compose.override.yaml" "-f compose.yaml -f compose.test.yaml" "-f compose.yaml -f compose.prod.yaml"; do
  for profile in "" "--profile observability"; do
    # shellcheck disable=SC2086
    docker compose --env-file "${envfile}" ${files} ${profile} config -q && echo "ok: ${files} ${profile}"
  done
done

echo "== promtool"
docker run --rm -v "${here}/infrastructure/monitoring/prometheus:/w" -w /w --entrypoint promtool prom/prometheus:v3.2.1 check rules alerts.yml
docker run --rm -v "${here}/infrastructure/monitoring/prometheus:/w" -w /w --entrypoint promtool prom/prometheus:v3.2.1 test rules alerts.test.yml
docker run --rm -v "${here}/infrastructure/monitoring/prometheus:/etc/prometheus" --entrypoint promtool prom/prometheus:v3.2.1 check config /etc/prometheus/prometheus.yml

echo "== otelcol validate"
docker run --rm -v "${here}/infrastructure/monitoring/otel-collector/config.yaml:/etc/otelcol/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:0.120.0 validate --config=/etc/otelcol/config.yaml && echo "ok: otel-collector"

echo "== nginx -t"
docker run --rm -v "${here}/infrastructure/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginxinc/nginx-unprivileged:1.27-alpine nginx -t
