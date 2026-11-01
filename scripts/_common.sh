#!/usr/bin/env bash
# Shared helpers for the scripts in this directory (sourced, not executed).
set -Eeuo pipefail

SATHI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${SATHI_ROOT}"

# Project name comes from `name:` in compose.yaml unless COMPOSE_PROJECT_NAME is set.
SATHI_PROJECT="${COMPOSE_PROJECT_NAME:-sathi}"
export SATHI_ROOT SATHI_PROJECT

require_docker() {
  command -v docker >/dev/null 2>&1 || { echo "docker not found on PATH" >&2; exit 1; }
  docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required (docker compose ...)" >&2; exit 1; }
}

ensure_env() {
  if [[ ! -f "${SATHI_ROOT}/.env" ]]; then
    echo ".env not found - generating one from .env.example"
    "${SATHI_ROOT}/scripts/generate-secrets.sh"
  fi
}
