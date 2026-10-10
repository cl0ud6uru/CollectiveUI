#!/usr/bin/env bash
# Builds the workspace sandbox image (docker/sandbox) and prints its image ID.
#   SANDBOX_IMAGE   tag to build (default ai-portal-sandbox:p5)
#   BASE_IMAGE      override the pinned base (e.g. a registry mirror with the same digest)
set -euo pipefail
bash "$(dirname "$0")/docker-build-preflight.sh" --no-compose
cd "$(dirname "$0")/../docker/sandbox"
tag="${SANDBOX_IMAGE:-ai-portal-sandbox:p5}"
args=(--tag "$tag")
[ -n "${BASE_IMAGE:-}" ] && args+=(--build-arg "BASE_IMAGE=$BASE_IMAGE")
DOCKER_BUILDKIT=1 docker build "${args[@]}" .
docker image inspect "$tag" --format '{{.Id}}'
