#!/usr/bin/env bash
# Build the Narrative images LOCALLY and push them to GHCR (private packages).
# The prod VM then just pulls them (deploy.sh) — it never builds from source.
#
# Prereqs (on your build machine, e.g. the Mac):
#   - Docker running
#   - infra/.env.prod present (decrypt it: ../scripts/secrets-decrypt.sh prod) —
#     used to bake the web app's VITE_* URLs at build time
#   - logged in to GHCR:  echo "$GHCR_PAT" | docker login ghcr.io -u petronijus --password-stdin
#       (PAT needs write:packages; or `gh auth token` if it has the scope)
#
# Usage:
#   infra/scripts/build-push.sh            # tag = git short sha + :latest
#   NARRATIVE_TAG=v0.8.1 infra/scripts/build-push.sh
#   TARGET_PLATFORM=linux/arm64 infra/scripts/build-push.sh   # only if the VM ever moves
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${SCRIPT_DIR}/.."
REPO_DIR="${INFRA_DIR}/.."
REG="ghcr.io/petronijus"
cd "${INFRA_DIR}"

# The prod VM is x86_64. Docker builds for the host's architecture unless told
# otherwise, so building on an Apple Silicon Mac produced arm64 images that the
# VM refused to run — `no matching manifest for linux/amd64 in the manifest
# list entries`, after the tag had already been pushed and `:latest` clobbered
# with it. Pin the target instead of relying on where the build happens to run.
#
# On an arm64 machine this goes through QEMU emulation, which is slower but
# correct; Docker Desktop ships the binfmt handlers for it.
TARGET_PLATFORM="${TARGET_PLATFORM:-linux/amd64}"
export DOCKER_DEFAULT_PLATFORM="${TARGET_PLATFORM}"
HOST_ARCH="$(uname -m)"
case "${HOST_ARCH}:${TARGET_PLATFORM}" in
  arm64:linux/amd64 | aarch64:linux/amd64)
    echo "→ Host is ${HOST_ARCH}, target is ${TARGET_PLATFORM} — building under emulation (slow)"
    ;;
esac

[[ -f .env.prod ]] || { echo "✗ Missing infra/.env.prod — run ../scripts/secrets-decrypt.sh prod" >&2; exit 1; }
set -a; # shellcheck disable=SC1091
source .env.prod; set +a
: "${DOMAIN:?DOMAIN not set in .env.prod}"

NARRATIVE_TAG="${NARRATIVE_TAG:-$(git -C "$REPO_DIR" rev-parse --short HEAD)}"
export NARRATIVE_TAG
echo "→ Building Narrative images locally, tag: ${NARRATIVE_TAG} (+ latest)"

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod"

# 1) server + video-worker — built + tagged via compose (image: refs)
$COMPOSE build server video-worker
$COMPOSE push server video-worker

# 2) web — built with prod VITE_* baked in, pushed as narrative-web
docker build \
  --target runtime \
  --build-arg VITE_BUILD_VERSION="${NARRATIVE_TAG}+$(git -C "$REPO_DIR" rev-parse --short=7 HEAD)" \
  --build-arg VITE_API_URL="https://${DOMAIN}/api" \
  --build-arg VITE_HOCUSPOCUS_URL="wss://${DOMAIN}/ws" \
  --build-arg VITE_IMGPROXY_URL="${VITE_IMGPROXY_URL:-https://${DOMAIN}/imgproxy}" \
  --tag "${REG}/narrative-web:${NARRATIVE_TAG}" \
  --tag "${REG}/narrative-web:latest" \
  --file "${REPO_DIR}/apps/web/Dockerfile" \
  "${REPO_DIR}"
docker push "${REG}/narrative-web:${NARRATIVE_TAG}"
docker push "${REG}/narrative-web:latest"

# 3) also tag+push server/video-worker as :latest
for svc in server video-worker; do
  docker tag "${REG}/narrative-${svc}:${NARRATIVE_TAG}" "${REG}/narrative-${svc}:latest"
  docker push "${REG}/narrative-${svc}:latest"
done

# 4) the images are in GHCR now; the local copies of older releases are just
#    disk. Keep this tag and two back, drop the rest. The build cache stays —
#    it is what makes the next build take minutes instead of tens of them.
echo "→ Pruning local release images older than ${NARRATIVE_TAG} + 2 previous"
"${SCRIPT_DIR}/prune-images.sh" --current "${NARRATIVE_TAG}" --keep 2 \
  || echo "! Local image prune did not complete — 'docker system df' to see what is left" >&2

echo "✓ Pushed ${REG}/narrative-{server,video-worker,web}:{${NARRATIVE_TAG},latest}"
echo "  Deploy on the VM:  NARRATIVE_TAG=${NARRATIVE_TAG} ./infra/scripts/deploy.sh prod"
