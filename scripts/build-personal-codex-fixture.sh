#!/usr/bin/env bash
set -euo pipefail
# Development only: downloads public pinned artifacts on the executor, then builds with network=none.
# No registry publication, live runtime enrollment, credentials, or host policy changes.
[[ $(uname -m) == x86_64 ]] || { echo 'This fixture builder currently supports Linux x64 only.' >&2; exit 1; }
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
: > "$fixture_dir/npmrc"
npm --userconfig "$fixture_dir/npmrc" --cache "$fixture_dir/npm-cache" \
  pack @openai/codex@0.163.0-alpha.2-linux-x64 --pack-destination "$fixture_dir"
tar -xzf "$fixture_dir/openai-codex-0.163.0-alpha.2-linux-x64.tgz" -C "$fixture_dir"
mv "$fixture_dir/package/vendor/x86_64-unknown-linux-musl" "$fixture_dir/vendor"
cp "$repo_dir"/docker/personal-codex/{requirements.toml,server.mjs,bridge.mjs} "$fixture_dir/"
mkdir "$fixture_dir/node_modules"
cp -R "$repo_dir/node_modules/ws" "$fixture_dir/node_modules/ws"
cp "$repo_dir/tests/fixtures/personal-codex/Dockerfile" "$fixture_dir/Dockerfile"
mkdir "$fixture_dir/docker-config"
DOCKER_CONFIG="$fixture_dir/docker-config" docker build --network=none -t collectiveui/personal-codex:protocol-fixture "$fixture_dir"
