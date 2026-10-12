#!/usr/bin/env bash
# Build the reviewed workspace starter images with repository-root COPY context.
# Docker build networking is used only for OS/Python/NuGet restore. Runtime network policy stays `none`.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$repo_root/docker/workspace-templates/manifest.json"
image_prefix="${WORKSPACE_TEMPLATE_IMAGE_PREFIX:-collectiveui/workspace-templates}"
record_image_refs=0
only_profile=""

usage() {
  cat <<'EOF'
Usage: scripts/build-workspace-template-images.sh [--only PROFILE] [--record-image-refs]

Build PROFILE `knowledge-work` or `dotnet-linux`. The build uses Docker's default build network
for the pinned Microsoft Debian feed and declared Debian, PyPI and NuGet sources. It never pushes an image. `--record-image-refs`
updates the selected manifest imageRef(s) to the locally built immutable Docker image IDs.
EOF
}

while (($#)); do
  case "$1" in
    --only)
      (($# >= 2)) || { usage >&2; exit 2; }
      only_profile="$2"
      shift 2
      ;;
    --record-image-refs)
      record_image_refs=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

profiles=(knowledge-work dotnet-linux)
if [[ -n "$only_profile" ]]; then
  case "$only_profile" in
    knowledge-work|dotnet-linux) profiles=("$only_profile") ;;
    *) echo "Unknown workspace template profile: $only_profile" >&2; exit 2 ;;
  esac
fi

declare -A refs=()
for profile in "${profiles[@]}"; do
  dockerfile="$repo_root/docker/workspace-templates/$profile/Dockerfile"
  tag="$image_prefix:$profile-v1"
  echo "Building $profile from $dockerfile"
  DOCKER_BUILDKIT=1 docker build \
    --pull=false \
    --network=default \
    --build-arg SOURCE_DATE_EPOCH=0 \
    --tag "$tag" \
    --file "$dockerfile" \
    "$repo_root"
  refs["$profile"]="$(docker image inspect "$tag" --format '{{.Id}}')"
  printf '%s %s\n' "$profile" "${refs[$profile]}"
done

if ((record_image_refs)); then
  update_args=()
  for profile in "${profiles[@]}"; do update_args+=("$profile=${refs[$profile]}"); done
  node - "$manifest" "${update_args[@]}" <<'NODE'
const fs = require('node:fs');
const manifestPath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
for (const value of process.argv.slice(3)) {
  const separator = value.indexOf('=');
  const key = value.slice(0, separator);
  const imageRef = value.slice(separator + 1);
  const profile = manifest.profiles.find((candidate) => candidate.templateSlug === key);
  if (!profile) throw new Error(`Manifest has no profile ${key}`);
  if (!/^sha256:[a-f0-9]{64}$/.test(imageRef)) throw new Error(`Invalid Docker image ID for ${key}`);
  profile.imageRef = imageRef;
  profile.imageRefStatus = 'recorded';
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
  echo "Recorded image IDs in $manifest; review the diff before committing."
fi
