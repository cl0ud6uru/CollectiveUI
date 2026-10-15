#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Disposable CI fixture only. Never start it, attach owner storage, change a
# host profile/network, or load an operator .env. No Docker socket enters tests.
scratch=$(mktemp -d)
mkdir "$scratch/context"
fixture="cui-codex-env-fixture-$$"
container="cui-codex-env-inspect-$$"
docker_cmd=(env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent DOCKER_CONFIG=/nonexistent LANG=C.UTF-8 NODE_ENV=production docker)
cleanup() {
  "${docker_cmd[@]}" rm "$container" >/dev/null 2>&1 || true
  "${docker_cmd[@]}" image rm "$fixture" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

# Derive only the exact stock Node base and PATH; installing Codex is unnecessary
# for Docker's Config.Env semantics. Every image input remains digest-pinned.
base=$(awk '$1 == "FROM" { print $2; exit }' docker/personal-codex/Dockerfile)
[[ "$base" =~ ^node:22-slim@sha256:[a-f0-9]{64}$ ]]
printf 'FROM %s\nENV PATH=/usr/local/bin:/usr/bin:/bin\nENTRYPOINT []\n' "$base" > "$scratch/context/Dockerfile"
# Buildx needs a writable private configuration/cache, separate from the clean
# provisioner environment used for create/inspect below.
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$scratch" DOCKER_CONFIG="$scratch/docker-config" \
  docker build --tag "$fixture" "$scratch/context"
image=$("${docker_cmd[@]}" image inspect --format '{{.Id}}' "$fixture")
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]]
"${docker_cmd[@]}" version --format 'Docker server: {{.Server.Version}}'
"${docker_cmd[@]}" create --name "$container" --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --user 10001:10001 --workdir /home/agent/workspace \
  --env NODE_VERSION --env YARN_VERSION --env HOME=/codex-home --env CODEX_HOME=/codex-home \
  --env HTTP_PROXY=http://codex-egress:3128 --env HTTPS_PROXY=http://codex-egress:3128 \
  --env NO_PROXY=127.0.0.1,localhost "$image" node --version
"${docker_cmd[@]}" inspect --format '{{json .Config.Env}}' "$container" > "$scratch/Config.Env.json"
chmod 0644 "$scratch/Config.Env.json"

# Replay the daemon's actual environment through the real driver validator.
# All other inspection resources remain synthetic in this focused unit test.
"${docker_cmd[@]}" run --rm --init --network none \
  --mount "type=bind,src=$scratch/Config.Env.json,dst=/tmp/codex-inspect-env.json,readonly" \
  --env PERSONAL_CODEX_INSPECT_ENV_FIXTURE=/tmp/codex-inspect-env.json \
  collectiveui-test:ci npm test -- --configLoader runner --project unit \
  tests/unit/personal-codex-docker.test.ts -t 'validates a real Docker create inspection environment'
test "$("${docker_cmd[@]}" inspect --format '{{.State.Status}}' "$container")" = created
