#!/usr/bin/env bash
# Narrative — advance the instance's restore generation and write the restore
# marker (ADR 0017, migration 0042).
#
# Usage:
#   ./infra/scripts/restore-marker.sh [--if-missing] [ENV_FILE]   (default ENV_FILE: .env.prod)
#
#   backup.sh runs it after every dump; deploy.sh runs it with --if-missing
#   after the migrations, so a VM gets its first marker on the deploy that
#   introduces it instead of at the next nightly backup.
#
# What it does: `generation = max(generation + 1, now)` in Postgres (never the
# floor), then writes the new value to <marker dir>/generation, which the
# server reads at boot through INSTANCE_MARKER_PATH (docker-compose.prod.yml).
# A dump taken before this run holds a lower generation than the marker, so a
# server that boots on a restore of it sees the database below the marker and
# refuses every local document copy browsers took since
# (apps/server/src/hocuspocus/instanceGeneration.ts).
#
# Marker dir: RESTORE_MARKER_DIR, else <BACKUP_DIR>/marker, else
# ../backups/marker relative to infra/ — the same resolution as the server's
# volume in docker-compose.prod.yml, so the file written here is the file the
# server reads.
#
# Concurrency: the cron's backup and a deploy may run at once. The advance and
# the write happen under one lock, and the file only ever moves up, so the
# marker never falls behind a generation the database already holds.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${INFRA_DIR}"

IF_MISSING=0
ENV_FILE=".env.prod"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --if-missing) IF_MISSING=1; shift ;;
    -h|--help) sed -n '2,27p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "restore-marker.sh: unknown option: $1" >&2; exit 2 ;;
    *) ENV_FILE="$1"; shift ;;
  esac
done

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
log() { echo -e "${GREEN}→${NC} $*"; }
err() { echo -e "${RED}✗${NC} $*" >&2; }

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi
POSTGRES_USER="${POSTGRES_USER:-narrative}"
POSTGRES_DB="${POSTGRES_DB:-narrative}"
MARKER_DIR="${RESTORE_MARKER_DIR:-${BACKUP_DIR:-${INFRA_DIR}/../backups}/marker}"
MARKER="${MARKER_DIR}/generation"

COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.prod.yml)
if [[ "${USE_SHARED_TUNNEL:-0}" == "1" ]]; then
  COMPOSE_FILES+=(-f docker-compose.prod.shared-tunnel.yml)
fi

mkdir -p "${MARKER_DIR}"
if [[ ! -w "${MARKER_DIR}" ]]; then
  # Typically a directory Docker created for the bind mount before anything
  # else did: root's. Nothing here may sudo; say what fixes it.
  err "${MARKER_DIR} is not writable by $(id -un) (owner: $(stat -c '%U' "${MARKER_DIR}" 2>/dev/null || echo '?'))"
  err "fix: sudo chown $(id -un): '${MARKER_DIR}'"
  exit 1
fi

# The marker's current value, or 0 when there is none (or it is unreadable).
current_marker() {
  local raw
  raw="$(cat "${MARKER}" 2>/dev/null || true)"
  raw="${raw//[[:space:]]/}"
  if [[ "${raw}" =~ ^[1-9][0-9]*$ ]]; then printf '%s' "${raw}"; else printf '0'; fi
}

# The lock is the directory itself (read-only fd): a lock file would belong to
# whoever ran first — root's cron, say — and a later run as another user
# could not open it for writing.
exec 9<"${MARKER_DIR}"
if command -v flock >/dev/null; then
  flock -w 300 9 || { err "Another run holds the lock on ${MARKER_DIR} after 5 min"; exit 1; }
fi

if [[ "${IF_MISSING}" == "1" && "$(current_marker)" != "0" ]]; then
  log "Restore marker present (generation $(current_marker)) — left as it is"
  exit 0
fi

GENERATION=$(docker compose "${COMPOSE_FILES[@]}" --env-file "${ENV_FILE}" \
  exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 -tAq -c \
  "UPDATE instance_generation SET generation = GREATEST(generation + 1, extract(epoch from now())::bigint) WHERE id = 1 RETURNING generation")
GENERATION="${GENERATION//[[:space:]]/}"
if ! [[ "${GENERATION}" =~ ^[1-9][0-9]*$ ]]; then
  err "Restore generation could not be advanced (got: '${GENERATION}') — is migration 0042 applied?"
  exit 1
fi

# Only ever up: a concurrent run that advanced further has already written a
# higher value, and that one must stay.
if (( GENERATION <= $(current_marker) )); then
  log "Restore marker already at $(current_marker) (advanced to ${GENERATION} here)"
  exit 0
fi
tmp="$(mktemp "${MARKER_DIR}/generation.XXXXXX")"
trap 'rm -f "${tmp}"' EXIT
printf '%s\n' "${GENERATION}" > "${tmp}"
# Readable by the server's user inside the container (mounted read-only).
chmod 0644 "${tmp}"
mv -f "${tmp}" "${MARKER}"
log "Restore marker: generation ${GENERATION} (${MARKER})"
