#!/usr/bin/env bash
set -euo pipefail
# Public pinned inputs only; offline Docker build. No publication/enrollment/host changes.
[[ $(uname -m) == x86_64 ]] || { echo 'The stock image is pinned for Linux amd64.' >&2; exit 1; }
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
docker_path=${PERSONAL_CODEX_DOCKER_EXECUTABLE:-/usr/local/bin/docker}
[[ "$docker_path" == /usr/local/bin/docker || "$docker_path" == /usr/bin/docker ]] || exit 1
mkdir -p "$build_dir/debs" "$build_dir/docker-config"
node --input-type=module - "$repo_dir/docker/personal-codex/stock-inputs.lock.json" > "$build_dir/downloads" <<'NODE'
import { readFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const [prefix, items] of [['', lock.artifacts], ['debs/', lock.debianPackages]]) {
  for (const item of items) {
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || !/^[a-zA-Z0-9.+_~-]+$/.test(item.file)
      || !/^https:\/\/(registry\.npmjs\.org|deb\.debian\.org)\/[^\s]+$/.test(item.url)) throw new Error('Invalid pinned input.');
    console.log(`${item.sha256} ${item.url} ${prefix}${item.file}`);
  }
}
NODE
while read -r digest url file; do
  curl --fail --location --silent --show-error --retry 1 "$url" -o "$build_dir/$file"
  printf '%s  %s\n' "$digest" "$file" >> "$build_dir/inputs.sha256"
done < "$build_dir/downloads"
(cd "$build_dir" && sha256sum --check --strict inputs.sha256)
cp "$repo_dir"/docker/personal-codex/{Dockerfile,requirements.toml,server.mjs,bridge.mjs,prepare-workspace.mjs,stock-inputs.lock.json} "$build_dir/"
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent DOCKER_CONFIG="$build_dir/docker-config" \
  "$docker_path" build --platform=linux/amd64 --network=none --provenance=false \
  -t collectiveui/personal-codex:stock-runtime "$build_dir"
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent DOCKER_CONFIG="$build_dir/docker-config" \
  "$docker_path" image inspect collectiveui/personal-codex:stock-runtime --format '{{.Id}}'
