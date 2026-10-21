#!/usr/bin/env bash
# Narrative — zálohovací skript (M4 baseline)
#
# Zálohy v M4: pg_dump do souboru
# M29: rozšíření o MinIO mc mirror + ZFS snapshots do offsite
#
# Použití:
#   ./infra/scripts/backup.sh [staging|prod]
#   Volat z cronu: 0 3 * * * /opt/narrative/infra/scripts/backup.sh prod
#
# Předpoklady:
#   - Spouštět z infra/ adresáře nebo jako CRON s abs. cestou
#   - Docker compose running
#   - backups/ adresář musí existovat (nebo nastavte BACKUP_DIR)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${SCRIPT_DIR}/.."

cd "${INFRA_DIR}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}→${NC} $*"; }
err() { echo -e "${RED}✗${NC} $*" >&2; }

# Config
BACKUP_DIR="${BACKUP_DIR:-${INFRA_DIR}/../backups}"
POSTGRES_USER="${POSTGRES_USER:-narrative}"
POSTGRES_DB="${POSTGRES_DB:-narrative}"
RETAIN_DAYS="${RETAIN_DAYS:-7}"

# Env soubor
ENV_FILE="${1:-.env.prod}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

# Vytvoř backup adresář pokud neexistuje
mkdir -p "${BACKUP_DIR}"

TS=$(date -u +"%Y%m%dT%H%M%SZ")
BACKUP_FILE="${BACKUP_DIR}/narrative-${TS}.sql.gz"

log "Zahajuji zálohu DB → ${BACKUP_FILE}"

docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file "${ENV_FILE}" \
  exec -T postgres \
  pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" \
  | gzip > "${BACKUP_FILE}"

SIZE=$(du -sh "${BACKUP_FILE}" | cut -f1)
log "Záloha hotova: ${BACKUP_FILE} (${SIZE})"

# Restore marker (ADR 0017): advance the instance's restore generation AFTER
# the dump, and write it outside Postgres. The dump just taken holds a lower
# generation, so a server that boots on a restore of it sees the database
# below the marker and refuses every local document copy browsers took
# before (apps/server/src/hocuspocus/instanceGeneration.ts). A failure here
# fails the backup: a marker behind the database cannot detect a restore.
MARKER_DIR="${BACKUP_DIR}/marker"
mkdir -p "${MARKER_DIR}"
GENERATION=$(docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file "${ENV_FILE}" \
  exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 -tAq -c \
  "UPDATE instance_generation SET generation = GREATEST(generation + 1, extract(epoch from now())::bigint) WHERE id = 1 RETURNING generation")
if ! [[ "${GENERATION}" =~ ^[1-9][0-9]*$ ]]; then
  err "Restore generation could not be advanced (got: '${GENERATION}')"
  exit 1
fi
printf '%s\n' "${GENERATION}" > "${MARKER_DIR}/generation.tmp"
mv -f "${MARKER_DIR}/generation.tmp" "${MARKER_DIR}/generation"
log "Restore marker: generation ${GENERATION}"

# Smazání starých záloh (starší než RETAIN_DAYS dní)
log "Mazání záloh starších než ${RETAIN_DAYS} dní..."
find "${BACKUP_DIR}" -name "narrative-*.sql.gz" -mtime "+${RETAIN_DAYS}" -delete

log "Záloha dokončena."
