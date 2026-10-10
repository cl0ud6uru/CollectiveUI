#!/usr/bin/env bash
# Build production Compose images after preflight; arguments are docker compose build arguments/service names.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/docker-build-preflight.sh
# Quiet validation avoids printing interpolated secrets from .env or overrides.
docker compose config --quiet
DOCKER_BUILDKIT=1 docker compose build "$@"
