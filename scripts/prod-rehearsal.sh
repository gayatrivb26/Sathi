#!/usr/bin/env bash
# Production-profile rehearsal (compose.yaml + compose.prod.yaml) under project `sathi-prod`.
#   scripts/prod-rehearsal.sh                  up (app + data)
#   scripts/prod-rehearsal.sh --observability  up incl. observability profile
#   scripts/prod-rehearsal.sh down [-v]        stop (and optionally delete its volumes)
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_docker
ensure_env
compose=(docker compose -p sathi-prod -f compose.yaml -f compose.prod.yaml)
case "${1:-up}" in
  down) shift; "${compose[@]}" --profile observability down --remove-orphans "$@" ;;
  --observability)
    shift
    export OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector:4317"
    "${compose[@]}" --profile observability up -d --build --wait "$@" ;;
  up) shift || true; "${compose[@]}" up -d --build --wait "$@" ;;
  *) "${compose[@]}" up -d --build --wait "$@" ;;
esac
"${compose[@]}" ps
