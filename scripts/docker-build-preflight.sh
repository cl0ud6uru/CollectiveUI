#!/usr/bin/env bash
# Read-only prerequisite checks. Does not install plugins, bootstrap builders or start services.
set -euo pipefail
compose=true
if [[ "${1:-}" == --no-compose && $# == 1 ]]; then
  compose=false
elif [[ $# != 0 ]]; then
  echo 'Usage: docker-build-preflight.sh [--no-compose]' >&2
  exit 2
fi
fail() { echo "Docker build prerequisite: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || fail 'Docker CLI is missing. Install Docker Engine, Compose v2 and Buildx; see docs/operations.md#docker-build-prerequisites.'
[[ "${DOCKER_BUILDKIT:-1}" != 0 ]] || fail 'DOCKER_BUILDKIT=0 selects the unsupported legacy builder. Unset it or set DOCKER_BUILDKIT=1.'
docker info >/dev/null 2>&1 || fail 'Cannot access the Docker daemon. Check docker info using the same operator account/context; do not change socket permissions to bypass access controls.'
if $compose; then
  docker compose version >/dev/null 2>&1 || fail 'Compose v2 is missing. Ubuntu docker.io uses docker-compose-v2; Docker official packages use docker-compose-plugin. See docs/operations.md#docker-build-prerequisites.'
fi
docker buildx version >/dev/null 2>&1 || fail 'Buildx is missing. Ubuntu docker.io needs docker-buildx; Docker official packages need docker-buildx-plugin. Do not mix package sources. See docs/operations.md#docker-build-prerequisites.'
builder_info=$(docker buildx inspect 2>/dev/null) || fail 'Cannot inspect the selected BuildKit builder. Check docker buildx ls and docker buildx inspect with the same account/context.'
[[ ! "$builder_info" =~ Status:[[:space:]]+error ]] || fail 'The selected BuildKit builder has an unavailable node. Check docker buildx inspect and its endpoint before building.'
echo 'Docker daemon, Buildx and selected builder prerequisites passed.'
