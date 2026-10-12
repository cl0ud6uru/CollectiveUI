#!/usr/bin/env bash
set -euo pipefail

# Build a local, source-patched Codex CLI image for disposable no-credential
# verification. Public source/dependencies are prepared on the host; compilation
# and image assembly run with Docker networking disabled. This does not enroll,
# authenticate, publish, or deploy a runtime.
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || {
  echo 'The pinned native fixture currently supports Linux x86_64 only.' >&2
  exit 1
}

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
commit=a6274249d5877030676db098914db686bab7c921
patch_file="$repo_dir/patches/codex/a6274249-protected-masks.patch"
patch_sha=$(sha256sum "$patch_file" | cut -d ' ' -f 1)
expected_patch_sha=7e9aeb06a157421211a7f2d2eb6830659ba6c2c2ce7f06724ad43c70f12bd560
[[ $patch_sha == "$expected_patch_sha" ]] || {
  echo "Unexpected reviewed patch digest: $patch_sha" >&2
  exit 1
}

build_dir=$(mktemp -d /tmp/collectiveui-codex-native-build.XXXXXX)
link_tmp_dir=$(mktemp -d /workspace/.collectiveui-codex-native-tmp.XXXXXX)
trap 'rm -rf "$build_dir" "$link_tmp_dir"' EXIT
target_dir=${PERSONAL_CODEX_TARGET_DIR:-/tmp/collectiveui-codex-native-target-$commit}
mkdir -p "$target_dir"
export DOCKER_CONFIG="$build_dir/docker-config"
mkdir -p "$DOCKER_CONFIG" "$build_dir/home" "$build_dir/cargo-home" "$build_dir/image"

source_url=${CODEX_SOURCE_URL:-https://github.com/openai/codex.git}
source_dir="$build_dir/codex"
if [[ -n ${PERSONAL_CODEX_SOURCE_DIR:-} ]]; then
  [[ $(git -C "$PERSONAL_CODEX_SOURCE_DIR" rev-parse HEAD) == "$commit" ]] || {
    echo "Local Codex source must be at $commit." >&2
    exit 1
  }
  mkdir "$source_dir"
  # Export only Git-tracked files; ignored local credentials/config in a developer
  # checkout never enter the mounted source tree.
  tracked_files="$build_dir/tracked-files"
  while IFS= read -r -d '' tracked_path; do
    if [[ -e "$PERSONAL_CODEX_SOURCE_DIR/$tracked_path" || -L "$PERSONAL_CODEX_SOURCE_DIR/$tracked_path" ]]; then
      printf '%s\0' "$tracked_path"
    fi
  done < <(git -C "$PERSONAL_CODEX_SOURCE_DIR" ls-files -z) > "$tracked_files"
  tar -C "$PERSONAL_CODEX_SOURCE_DIR" --null --files-from="$tracked_files" -cf - \
    | tar -C "$source_dir" -xf -
  source_diff_sha=$(git -C "$PERSONAL_CODEX_SOURCE_DIR" diff --binary --unified=1 HEAD -- \
    | sha256sum | cut -d ' ' -f 1)
  if [[ $source_diff_sha == "$patch_sha" ]]; then
    : # This exact reviewed patch is already applied in the local source tree.
  elif [[ $source_diff_sha == e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 ]]; then
    git -C "$source_dir" apply --check "$patch_file"
    git -C "$source_dir" apply "$patch_file"
  else
    echo 'Local Codex source has changes other than the exact reviewed patch.' >&2
    exit 1
  fi
else
  git -C "$build_dir" init --quiet "$source_dir"
  env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
    git -C "$source_dir" remote add origin "$source_url"
  env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
    git -c credential.helper= -c http.extraHeader= -C "$source_dir" fetch --quiet --depth=1 origin "$commit"
  git -C "$source_dir" checkout --quiet --detach FETCH_HEAD
  [[ $(git -C "$source_dir" rev-parse HEAD) == "$commit" ]] || {
    echo "Fetched Codex source does not match $commit." >&2
    exit 1
  }
  git -C "$source_dir" apply --check "$patch_file"
  git -C "$source_dir" apply "$patch_file"
fi

# npm pack and Cargo dependency preparation happen outside containers using
# public pinned inputs. Reuse the exact pinned fixture image so repeat builds do
# not retain duplicate 428 MB Docker build-context cache records.
expected_fixture_id=sha256:7dfe46d2ad8ccd633b8b2cf2eff71cbf1daea7802150213b6e4809f815b2c58a
fixture_before=$(docker image inspect collectiveui/personal-codex:protocol-fixture --format '{{.Id}}' 2>/dev/null || true)
if [[ $fixture_before != "$expected_fixture_id" ]]; then
  "$repo_dir/scripts/build-personal-codex-fixture.sh"
fi

# No host Cargo credentials/config are mounted in the build container.
rust_image=rust@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1
cargo_home=${CARGO_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/cargo}
archive_cache_dir=${CARGO_ARCHIVE_CACHE_DIR:-$cargo_home/registry/cache}
[[ -d "$cargo_home/registry/src" && -d "$cargo_home/registry/index" \
  && -d "$archive_cache_dir" && -d "$cargo_home/git" ]] || {
  echo "Cargo registry/git cache not found at $cargo_home; set CARGO_HOME to the public dependency cache." >&2
  exit 1
}

fixture_id=$(docker image inspect collectiveui/personal-codex:protocol-fixture --format '{{.Id}}')
bwrap_sha=$(docker run --rm --network none --read-only --cap-drop ALL --entrypoint sha256sum \
  collectiveui/personal-codex:protocol-fixture /opt/codex/codex-resources/bwrap | cut -d ' ' -f 1)
[[ $fixture_id == "$expected_fixture_id" ]] || {
  echo "Unexpected pinned fixture base image: $fixture_id" >&2
  exit 1
}

# The source and public crate caches are read-only. Only the task-local target
# and Cargo home are writable. In particular, no Docker socket or host secrets
# are mounted inside this builder container.
uid=$(id -u); gid=$(id -g)
docker run --rm --network none --read-only --cap-drop ALL --user "$uid:$gid" \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
  --mount "type=bind,src=$source_dir,dst=/src,readonly" \
  --mount "type=bind,src=$cargo_home/registry/src,dst=/cache/registry/src,readonly" \
  --mount "type=bind,src=$cargo_home/registry/index,dst=/cache/registry/index,readonly" \
  --mount "type=bind,src=$archive_cache_dir,dst=/cache/registry/cache,readonly" \
  --mount "type=bind,src=$cargo_home/git,dst=/cache/git,readonly" \
  --mount "type=bind,src=$build_dir/home,dst=/build/home" \
  --mount "type=bind,src=$build_dir/cargo-home,dst=/build/cargo-home" \
  --mount "type=bind,src=$link_tmp_dir,dst=/build/link-tmp" \
  --mount "type=bind,src=$target_dir,dst=/target" \
  --env HOME=/build/home --env CARGO_HOME=/build/cargo-home \
  --env TMPDIR=/build/link-tmp --env TMP=/build/link-tmp --env TEMP=/build/link-tmp \
  --env CARGO_TARGET_DIR=/target --env CARGO_NET_OFFLINE=true \
  --env RUSTUP_TOOLCHAIN=1.95.0-x86_64-unknown-linux-gnu \
  --env STABLE_GIT_COMMIT="$commit" --env CODEX_BWRAP_SHA256="$bwrap_sha" \
  --env CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}" --workdir /src/codex-rs \
  "$rust_image" sh -eu -c '
    ln -s /cache/registry "$CARGO_HOME/registry"
    ln -s /cache/git "$CARGO_HOME/git"
    # Keep the upstream optimized release settings, but disable whole-program
    # LTO for the final CLI binary. On the small disposable builder this avoids
    # emitting more than 1 GiB of temporary cross-crate LTO objects.
    cargo rustc --offline --locked --release --package codex-cli --bin codex -- -C lto=off
  '

test -x "$target_dir/release/codex"
binary_sha=$(sha256sum "$target_dir/release/codex" | cut -d ' ' -f 1)
cp "$target_dir/release/codex" "$build_dir/image/codex"
cp "$repo_dir/docker/personal-codex/Dockerfile.native" "$build_dir/image/Dockerfile"

image_tag=${PERSONAL_CODEX_NATIVE_IMAGE_TAG:-collectiveui/personal-codex:native-a6274249}
docker build --network=none --file "$build_dir/image/Dockerfile" \
  --build-arg CODEX_BASE_IMAGE=collectiveui/personal-codex:protocol-fixture \
  --build-arg CODEX_COMMIT="$commit" --build-arg CODEX_PATCH_SHA256="$patch_sha" \
  --build-arg CODEX_BWRAP_SHA256="$bwrap_sha" --build-arg CODEX_FIXTURE_IMAGE_ID="$fixture_id" \
  --tag "$image_tag" "$build_dir/image"
printf 'image=%s\n' "$image_tag"
printf 'image_id=%s\n' "$(docker image inspect "$image_tag" --format '{{.Id}}')"
printf 'source_commit=%s\npatch_sha256=%s\nbwrap_sha256=%s\nfixture_base_image_id=%s\n' \
  "$commit" "$patch_sha" "$bwrap_sha" "$fixture_id"
printf 'codex_binary_sha256=%s\n' "$binary_sha"
printf 'codex_cli_lto=off\n'
printf 'persistent_build_target=%s\n' "$target_dir"
docker image inspect "$image_tag" --format '{{json .Config.Labels}}'
