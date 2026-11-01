#!/usr/bin/env bash
# Follow container logs.
#   scripts/logs.sh                  all services
#   scripts/logs.sh api ai-service   selected services
#   scripts/logs.sh --errors api     only warning/error JSON lines
#   scripts/logs.sh --trace 7F3A91C2 lines whose trace_id starts with a reference ID
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_docker
filter=""
case "${1:-}" in
  --errors) filter='"level":"(warn|warning|error|fatal|critical)"'; shift ;;
  --trace)  ref="$(printf '%s' "${2:?reference or trace id}" | tr -d '-' | tr 'A-F' 'a-f')"
            filter="\"trace_id\":\"${ref}"; shift 2 ;;
esac
if [[ -n "${filter}" ]]; then
  docker compose --profile observability logs --no-log-prefix --tail=2000 "$@" | grep -iE "${filter}" || true
else
  docker compose --profile observability logs -f --tail=200 "$@"
fi
