#!/usr/bin/env bash
# Build the Narrative images and push them to GHCR (private packages). The
# prod VM then only pulls them (deploy.sh) — it never builds from source.
#
# `just deploy` runs this on the build host (infra/release.env →
# NARRATIVE_BUILDER) through infra/scripts/remote-release.sh; it also runs on
# any machine with Docker for a one-off build.
#
# Needs no secrets and no domain: the images carry no configuration. The web
# app reaches the API and the sync server at /api and /ws on whatever origin
# serves it (apps/web/src/lib/endpoints.ts), so the image names no domain.
# The server and the
# video worker are built with plain `docker build`, not `docker compose
# build`: compose interpolates the whole prod file first and so demanded every
# runtime secret of infra/.env.prod on the build machine (a stale copy there
# stopped the 0.10.18 deploy on 2026-10-07).
#
# Prereqs on the build machine:
#   - Docker with buildx
#   - logged in to GHCR with a write:packages token:
#       docker login ghcr.io -u petronijus
#
# Usage:
#   NARRATIVE_TAG=v0.10.18 infra/scripts/build-push.sh --src <tree at v0.10.18>
#   infra/scripts/build-push.sh                     # this checkout, tag = short sha
#   TARGET_PLATFORM=linux/arm64 infra/scripts/build-push.sh   # only if the VM ever moves
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLING_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REG="ghcr.io/petronijus"

SRC_DIR="${TOOLING_DIR}"
while (($# > 0)); do
  case "$1" in
    --src)
      SRC_DIR="$(cd "${2:?--src needs a directory}" && pwd)"
      shift 2
      ;;
    *)
      echo "usage: $0 [--src DIR]" >&2
      exit 64
      ;;
  esac
done

# The prod VM is x86_64. Docker builds for the host's architecture unless told
# otherwise, so building on an Apple Silicon Mac produced arm64 images that the
# VM refused to run — `no matching manifest for linux/amd64 in the manifest
# list entries`, after the tag had already been pushed and `:latest` clobbered
# with it. Pin the target instead of relying on where the build happens to run.
TARGET_PLATFORM="${TARGET_PLATFORM:-linux/amd64}"
HOST_ARCH="$(uname -m)"
case "${HOST_ARCH}:${TARGET_PLATFORM}" in
  arm64:linux/amd64 | aarch64:linux/amd64)
    echo "→ Host is ${HOST_ARCH}, target is ${TARGET_PLATFORM} — building under emulation (slow)"
    ;;
esac

SRC_SHA="$(git -C "$SRC_DIR" rev-parse --short=7 HEAD)"
NARRATIVE_TAG="${NARRATIVE_TAG:-${SRC_SHA}}"
# A release tag names exactly one commit: never push it built from another.
if [[ "$NARRATIVE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  tagged="$(git -C "$SRC_DIR" rev-parse "refs/tags/${NARRATIVE_TAG}^{commit}" 2>/dev/null)" ||
    { echo "✗ ${NARRATIVE_TAG} is not a tag in ${SRC_DIR}" >&2; exit 1; }
  [[ "$tagged" == "$(git -C "$SRC_DIR" rev-parse HEAD)" ]] ||
    { echo "✗ ${SRC_DIR} is not at ${NARRATIVE_TAG} (HEAD ${SRC_SHA})" >&2; exit 1; }
fi
[[ -z "$(git -C "$SRC_DIR" status --porcelain --untracked-files=no)" ]] ||
  { echo "✗ ${SRC_DIR} has uncommitted changes; the images would not match ${NARRATIVE_TAG}" >&2; exit 1; }

echo "→ Building Narrative ${NARRATIVE_TAG} (${SRC_SHA}) for ${TARGET_PLATFORM} on $(hostname)"

# A push over a flaky link fails mid-blob ("timeout awaiting response
# headers"); the registry keeps every finished blob, so trying again resumes.
push() {
  local ref="$1" attempt=1 delay=10
  until docker push --quiet "$ref"; do
    if ((attempt >= 5)); then
      echo "✗ docker push ${ref} failed ${attempt} times" >&2
      return 1
    fi
    echo "! docker push ${ref} failed (attempt ${attempt}/5); again in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

build() {
  local app="$1"
  shift
  docker build \
    --platform "$TARGET_PLATFORM" \
    --tag "${REG}/narrative-${app}:${NARRATIVE_TAG}" \
    --tag "${REG}/narrative-${app}:latest" \
    --file "${SRC_DIR}/apps/${app}/Dockerfile" \
    "$@" \
    "$SRC_DIR"
}

# The app images, in the order they build (each its apps/<name>/Dockerfile).
APPS=(server video-worker render-worker web)

build server
build video-worker
build render-worker
build web \
  --target runtime \
  --build-arg VITE_BUILD_VERSION="${NARRATIVE_TAG}+${SRC_SHA}" \
  --build-arg VITE_API_URL=/api \
  --build-arg VITE_HOCUSPOCUS_URL=/ws

for app in "${APPS[@]}"; do
  push "${REG}/narrative-${app}:${NARRATIVE_TAG}"
  push "${REG}/narrative-${app}:latest"
done

# What the VM will pull is what was built: the registry's image for the tag
# has the target platform (a pushed tag is checked, not assumed).
want_os="${TARGET_PLATFORM%%/*}" want_arch="${TARGET_PLATFORM#*/}"
for app in "${APPS[@]}"; do
  ref="${REG}/narrative-${app}:${NARRATIVE_TAG}"
  got="$(docker buildx imagetools inspect "$ref" --format '{{json .Image}}' |
    python3 -c 'import json, sys; d = json.load(sys.stdin); print(d.get("os", "?") + "/" + d.get("architecture", "?"))')"
  [[ "$got" == "${want_os}/${want_arch}" ]] ||
    { echo "✗ ${ref} in the registry is ${got}, not ${TARGET_PLATFORM}" >&2; exit 1; }
done

# The images are in GHCR now; the local copies of older releases are just
# disk. Keep this tag and two back, drop the rest. The build cache stays —
# it is what makes the next build take minutes instead of tens of them.
echo "→ Pruning local release images older than ${NARRATIVE_TAG} + 2 previous"
"${SCRIPT_DIR}/prune-images.sh" --current "${NARRATIVE_TAG}" --keep 2 ||
  echo "! Local image prune did not complete — 'docker system df' to see what is left" >&2

echo "✓ Pushed ${REG}/narrative-{server,video-worker,render-worker,web}:{${NARRATIVE_TAG},latest} (${TARGET_PLATFORM})"
