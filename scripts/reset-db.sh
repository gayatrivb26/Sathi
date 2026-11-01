#!/usr/bin/env bash
# DESTROYS the local Postgres volume, re-runs the init script and both migrators
# (EF Core for `app`, Alembic for `ai`) and re-seeds content and demo users.
# Usage: scripts/reset-db.sh [--yes]
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_docker
if [[ "${1:-}" != "--yes" ]]; then
  read -r -p "Delete ALL local Sathi database data (volume ${SATHI_PROJECT}_postgres-data)? [y/N] " answer
  [[ "${answer}" =~ ^[Yy]$ ]] || { echo "aborted"; exit 1; }
fi
docker compose stop web api jobs ai-service ai-ingest >/dev/null 2>&1 || true
docker compose rm -sf postgres migrator-app migrator-ai
docker volume rm "${SATHI_PROJECT}_postgres-data" 2>/dev/null || true
docker compose up -d --wait
echo "Database recreated and seeded."
