#!/usr/bin/env bash
# Stop the development stack (including the observability profile).
# Data volumes are kept; pass --volumes (-v) to delete them as well.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_docker
docker compose --profile observability down --remove-orphans "$@"
