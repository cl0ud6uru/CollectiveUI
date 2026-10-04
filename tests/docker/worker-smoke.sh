#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# A unique project owns every resource, including the disposable DB. Never load the operator's .env.
project="collective-worker-smoke-$$"
compose=(docker compose --env-file /dev/null -p "$project" -f tests/docker/compose.yml)
cleanup() {
  local result=$?
  if (( result != 0 )); then "${compose[@]}" logs --no-color || true; fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT
"${compose[@]}" up -d --wait --wait-timeout 90 db mock
# Both the documented npm entry point and the default startup run against the production install.
"${compose[@]}" run --rm --no-deps worker npm run db:migrate
"${compose[@]}" run --rm --no-deps worker npm run db:migrate
"${compose[@]}" up -d worker
"${compose[@]}" run --rm --no-deps check
"${compose[@]}" stop worker
container=$("${compose[@]}" ps -aq worker)
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = 0
"${compose[@]}" logs --no-color worker
