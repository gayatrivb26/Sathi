#!/usr/bin/env bash
# Build and start the development stack (compose.yaml + compose.override.yaml).
# Extra arguments are passed to `docker compose up`, e.g.  scripts/dev-up.sh web api
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_docker
ensure_env
docker compose up -d --build --wait "$@"
echo
echo "Sathi:   http://localhost:8080"
echo "Mailpit: http://localhost:8025   MinIO console: http://localhost:9001"
echo "Logs:    scripts/logs.sh [service]     Stop: scripts/dev-down.sh"
