#!/usr/bin/env bash
# Narrative — keep the Docker image store from filling the disk.
#
# Every release leaves three images behind (server 0.5 GB, video-worker
# 1.3 GB, web 0.1 GB) and nobody deletes them: on 2026-09-21 the prod VM hit
# 99% with sixteen releases' worth of images plus 14 GB of build cache from
# the days it still built from source, and a deploy failed mid-extract with
# "no space left on device". Every image is also in GHCR, so keeping more
# than a rollback's worth here buys nothing.
#
# Removes, per app image (narrative-server / -video-worker / -render-worker / -web):
#   every tag except the current one, `latest`, the KEEP most recent others,
#   and anything a running container uses.
# Then drops dangling layers, and — with --builder-cache — the build cache
# (only for hosts that never build; a build machine wants its cache).
#
# Usage:
#   prune-images.sh --current v0.9.15 [--keep 2] [--builder-cache]
#
# Called by deploy.sh after a successful deploy (with --builder-cache) and by
# build-push.sh after a successful push. Safe to run by hand any time.
set -euo pipefail

REG="ghcr.io/petronijus"
SERVICES=(server video-worker render-worker web)
CURRENT=""
KEEP=2
BUILDER_CACHE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --current) CURRENT="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --builder-cache) BUILDER_CACHE=1; shift ;;
    *) echo "prune-images.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$CURRENT" ]] || { echo "prune-images.sh: --current <tag> is required" >&2; exit 2; }

# Images a running container is built from must never go, whatever their tag.
# Read with a while-loop rather than `mapfile`: that is bash 4+, and macOS
# still ships bash 3.2, where the whole prune died with `mapfile: command not
# found` — silently, because the caller tolerates a failed prune. The VM runs
# bash 5 and was fine; the Mac build machine had never been pruning at all.
IN_USE=()
while IFS= read -r line; do
  [[ -n "$line" ]] && IN_USE+=("$line")
done < <(docker ps --format '{{.Image}}' | sort -u)
in_use() {
  local ref="$1"
  local used
  for used in "${IN_USE[@]:-}"; do
    [[ "$used" == "$ref" ]] && return 0
  done
  return 1
}

before=$(docker system df --format '{{.Size}}' 2>/dev/null | head -1 || true)
removed=0
for svc in "${SERVICES[@]}"; do
  repo="${REG}/narrative-${svc}"
  # Newest first; `latest` and the current tag are pinned, the next KEEP are
  # the rollback window, everything after that is history GHCR already holds.
  kept=0
  while IFS=$'\t' read -r ref created; do
    [[ -n "$ref" ]] || continue
    tag="${ref##*:}"
    if [[ "$tag" == "latest" || "$tag" == "$CURRENT" ]] || in_use "$ref"; then
      continue
    fi
    if (( kept < KEEP )); then
      kept=$((kept + 1))
      continue
    fi
    if docker rmi "$ref" > /dev/null 2>&1; then
      echo "  removed ${ref} (${created})"
      removed=$((removed + 1))
    else
      echo "  kept ${ref} — still referenced" >&2
    fi
  done < <(docker images "$repo" --format '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}' \
    | grep -v '<none>' | sort -t $'\t' -k2 -r)
done

# Layers no tag points at any more, including those the removals above freed.
docker image prune -f > /dev/null
if [[ "$BUILDER_CACHE" == "1" ]]; then
  docker builder prune -af > /dev/null
fi

after=$(docker system df --format '{{.Size}}' 2>/dev/null | head -1 || true)
echo "Image store: ${before:-?} → ${after:-?} (${removed} release image(s) removed, keeping ${CURRENT} + ${KEEP} previous)"
