#!/usr/bin/env bash
# Narrative — idempotentní deploy skript
#
# Použití:
#   ./infra/scripts/deploy.sh [staging|prod]
#
# Předpoklady (na target serveru):
#   - Docker + Compose plugin nainstalovaný
#   - .env.prod soubor v infra/ (viz infra/.env.prod.example)
#   - DNS záznam pro DOMAIN směřuje na tento server
#   - ZFS dataset připojený na PG_DATA_PATH (pokud používáte ZFS)
#
# Skript NESMÍ být spouštěn přes SSH z CI — user ho spouští ručně na targetu.
# (M12: harbor push + SSH deploy runner)

set -euo pipefail

ENV="${1:-staging}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${SCRIPT_DIR}/.."
REPO_DIR="${INFRA_DIR}/.."

cd "${INFRA_DIR}"

# ── Barvy pro výstup ───────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}→${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }

# ── Validace env ───────────────────────────────────────────────────────────────
if [[ ! -f ".env.prod" ]]; then
  err "Chybí infra/.env.prod — zkopírujte .env.prod.example a vyplňte hodnoty"
  exit 1
fi

# Načteme env vars z .env.prod (bez exportu do shellu — jen pro compose)
set -a
# shellcheck disable=SC1091
source .env.prod
set +a

if [[ -z "${DOMAIN:-}" ]]; then
  err "DOMAIN není nastaveno v .env.prod"
  exit 1
fi

if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
  err "POSTGRES_PASSWORD není nastaveno v .env.prod"
  exit 1
fi

COMPOSE_FILES="-f docker-compose.yml -f docker-compose.prod.yml"
# Shared-tunnel mode: rely on an external cloudflared running elsewhere on the
# LAN. Caddy gets exposed on host port 80; the bundled cloudflared service is
# profile-gated out via docker-compose.prod.shared-tunnel.yml.
if [[ "${USE_SHARED_TUNNEL:-0}" == "1" ]]; then
  COMPOSE_FILES="${COMPOSE_FILES} -f docker-compose.prod.shared-tunnel.yml"
  log "Shared-tunnel mode aktivní — bundled cloudflared se nespustí, Caddy publikuje 80:80"
fi
COMPOSE="docker compose ${COMPOSE_FILES} --env-file .env.prod"

# The desktop app's update feed (ADR 0015): written over SSH by
# `just desktop-publish` as this user, served read-only by Caddy at /desktop/.
# Created here so it belongs to this user — a bind mount Docker creates would
# be root's, and the publish could not write to it.
mkdir -p "${INFRA_DIR}/../desktop-feed"

# The restore marker's directory (ADR 0017): backup.sh writes the instance's
# restore generation there, the server mounts it read-only
# (docker-compose.prod.yml, the same RESTORE_MARKER_DIR / BACKUP_DIR
# resolution). It must exist before the first `compose run` below: a
# bind-mount source Docker has to create is root's, and backup.sh (cron, as
# this user) could then never write the marker — every nightly backup would
# fail at that step. backups/ is never synced by a deploy, so this is a
# one-time creation on a VM that predates the marker.
MARKER_DIR="${RESTORE_MARKER_DIR:-${BACKUP_DIR:-${INFRA_DIR}/../backups}/marker}"
if mkdir -p "${MARKER_DIR}" 2>/dev/null && [[ -w "${MARKER_DIR}" ]]; then
  log "Restore marker directory: ${MARKER_DIR}"
else
  warn "Cannot create or write ${MARKER_DIR} as $(id -un) — the restore marker"
  warn "will only appear if backup.sh runs as a user that can write it"
  warn "(check: ls -ld '${MARKER_DIR}' and the backup cron's user)"
fi

log "Deploy prostředí: ${ENV}"
log "Doména: ${DOMAIN}"

# ── ZFS snapshot před deployem (prod) ─────────────────────────────────────────
# Princip: snapshot před každým prod deployem (infra.md #7)
if [[ "${ENV}" == "prod" ]]; then
  if command -v zfs &>/dev/null && [[ -n "${ZFS_DATASET:-}" ]]; then
    SNAP_NAME="${ZFS_DATASET}@deploy-$(date -u +%Y%m%dT%H%M%SZ)"
    log "ZFS snapshot: ${SNAP_NAME}"
    zfs snapshot "${SNAP_NAME}" || warn "ZFS snapshot selhal — pokračuji"
  else
    warn "ZFS není dostupný nebo ZFS_DATASET není nastaven — přeskakuji snapshot"
  fi
fi

# ── Pull prebuilt images ─────────────────────────────────────────────────────
# Images are BUILT LOCALLY and pushed to GHCR (infra/scripts/build-push.sh) —
# the VM no longer builds from source. Requires a one-time `docker login ghcr.io`
# on this host (GHCR packages are private). Tag selected via NARRATIVE_TAG.
NARRATIVE_TAG="${NARRATIVE_TAG:-latest}"
export NARRATIVE_TAG
log "Pulling prebuilt app images from GHCR (tag: ${NARRATIVE_TAG})..."
for svc in server video-worker render-worker web; do
  docker pull "ghcr.io/petronijus/narrative-${svc}:${NARRATIVE_TAG}"
done

# Everything else in the stack (postgres, minio, caddy, imgproxy, redis, nginx)
# is pinned to an immutable third-party tag, so a refresh cannot change what
# runs — it only makes the release depend on Docker Hub being reachable
# anonymously. It stopped being: on 2026-09-18 `${COMPOSE} pull` died with
# "pull access denied for minio/minio, repository does not exist or may require
# 'docker login'" and took the whole deploy with it, although every one of those
# images was already on the host. Refresh them best-effort instead; a genuinely
# missing image still fails loudly at `compose up`, with a better message.
# MinIO itself has since moved to a digest-pinned mirror in this host's GHCR
# account (docs/storage.md → MinIO image), pulled here with the same login as
# the app images; the cached minio/minio stays on the host, unused.
log "Refreshing third-party images (best effort)..."
${COMPOSE} pull --ignore-pull-failures || warn "Third-party image refresh incomplete — using the copies already on this host"

# ── Web static build ───────────────────────────────────────────────────────────
# Web se buildí jako Docker image, ale statické soubory potřebujeme v volume
# který Caddy mountuje. Extrahujeme je z image.
log "Extrakce statických souborů web..."

# The web image is prebuilt locally with the prod VITE_* args baked in
# (build-push.sh reads them from .env.prod) and pushed to GHCR — just pull it.
WEB_IMAGE="ghcr.io/petronijus/narrative-web:${NARRATIVE_TAG}"
docker pull "${WEB_IMAGE}"

# Vytvoříme tmp container a zkopírujeme /srv/web do web_static volume
WEB_CONTAINER=$(docker create "${WEB_IMAGE}")
# Zajistíme existenci volume
docker volume create narrative_web_static 2>/dev/null || true
# Zkopírujeme přes tar pipe. The volume keeps earlier releases' hashed
# assets (a tab on an old version still lazy-loads its chunks), and with them
# the source maps images before 2026-10-20 carried, served to anyone who
# guessed a chunk's name + `.map`: the images have none now (performance plan
# D2), and the ones already in the volume go here — nothing references them.
docker cp "${WEB_CONTAINER}:/srv/web/." - \
  | docker run --rm -i \
      -v narrative_web_static:/srv/web \
      alpine sh -c "cd /srv/web && tar xf - && find /srv/web -type f \( -name '*.map' -o -name '*.map.br' -o -name '*.map.gz' \) -delete"
docker rm "${WEB_CONTAINER}"

log "Statické soubory zkopírovány do volume web_static"

# ── DB migrace ─────────────────────────────────────────────────────────────────
log "Spouštíme DB migrace..."
${COMPOSE} run --rm \
  --entrypoint "" \
  server \
  node apps/server/dist/apps/server/src/db/migrate.js

log "Migrace hotovy"

# ── Restore marker ─────────────────────────────────────────────────────────────
# The first deploy with migration 0042 has no marker yet (backup.sh writes it
# after each dump, at 03:00). Write it now, so the server's boot check has a
# marker from this release on, not from the next backup. --if-missing: an existing
# marker is left alone (it only ever moves forward, with the backups). Not
# fatal: without a marker the server runs normally and logs "no restore
# marker"; the next backup writes it.
bash "${SCRIPT_DIR}/restore-marker.sh" --if-missing .env.prod \
  || warn "The restore marker could not be written — the next backup.sh run writes it (docs/deploy.md → Backups)"

# ── Keep the outgoing server's logs ───────────────────────────────────────────
# `up -d` recreates the server, and its logs go with the old container: the
# client session reports (docs/ops.md → Client session metrics, until a
# scraper keeps them) and the shutdown lines infra/scripts/boot-timing.py
# reads with --previous to time the restart (plan D3). Follow them into
# backups/logs/ (never synced by a deploy) until that container is gone, so
# its last lines — SIGTERM, the documents stored — are in the file too. The
# newest 20 files are kept.
LOGS_DIR="${BACKUP_DIR:-${INFRA_DIR}/../backups}/logs"
LOG_FOLLOWER=""
OLD_LOG=""
if docker inspect narrative-server > /dev/null 2>&1 && mkdir -p "${LOGS_DIR}" 2> /dev/null; then
  old_image="$(docker inspect -f '{{.Config.Image}}' narrative-server)"
  OLD_LOG="${LOGS_DIR}/server-${old_image##*:}-$(date -u +%Y%m%dT%H%M%SZ).log"
  docker logs --timestamps --follow narrative-server > "${OLD_LOG}" 2>&1 &
  LOG_FOLLOWER=$!
fi

# ── Start services ─────────────────────────────────────────────────────────────
log "Startujeme služby..."
${COMPOSE} up -d --remove-orphans

if [[ -n "${LOG_FOLLOWER}" ]]; then
  # The follower ends by itself once the old container stopped; when `up -d`
  # left the server running (nothing about it changed) it is stopped here.
  sleep 1
  kill "${LOG_FOLLOWER}" 2> /dev/null || true
  wait "${LOG_FOLLOWER}" 2> /dev/null || true
  if gzip -f "${OLD_LOG}" 2> /dev/null; then
    log "The previous server's logs: ${OLD_LOG}.gz"
  fi
  # shellcheck disable=SC2012  # names without spaces, written above
  ls -1t "${LOGS_DIR}"/server-*.log.gz 2> /dev/null | tail -n +21 | xargs rm -f 2> /dev/null || true
fi

# ── Caddy config ───────────────────────────────────────────────────────────────
# `up -d` recreates Caddy only when its image or compose definition changes; a
# changed Caddyfile (synced into ./caddy, which is mounted as a directory —
# docs/deploy.md "Config-only changes") takes effect only on a reload, and
# nothing else reloads it. Validate first: a broken file fails the deploy and
# the running Caddy keeps its previous config.
log "Reloading the Caddy config..."
if ! docker exec narrative-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null 2>&1; then
  err "The Caddyfile does not validate; Caddy keeps its previous config"
  docker exec narrative-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -n 5
  exit 1
fi
docker exec narrative-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
log "Caddy config reloaded"

# ── Healthcheck ────────────────────────────────────────────────────────────────
log "Čekám na start (15s)..."
sleep 15

log "Healthcheck API..."
# In shared-tunnel mode the server's host port is NOT published (avoids
# Docker 29.4 port-bind bug). Probe via Caddy's internal `caddy` alias on
# the narrative_default network, or via `docker exec` inside server.
if [[ "${USE_SHARED_TUNNEL:-0}" == "1" ]]; then
  # BusyBox wget inside the alpine image resolves `localhost` to ::1 first,
  # but Fastify only binds IPv4 → wget exits with EAI_AGAIN even though the
  # server is healthy. Use 127.0.0.1 explicitly (matches the compose
  # healthcheck override in docker-compose.prod.shared-tunnel.yml).
  if docker exec narrative-server wget -qO- --timeout=10 http://127.0.0.1:3001/health > /dev/null 2>&1; then
    log "API healthcheck OK (via docker exec)"
  else
    err "API neodpovídá na /health (uvnitř kontejneru)"
    ${COMPOSE} logs --tail=50 server
    exit 1
  fi
else
  if curl -fsS --max-time 10 "http://127.0.0.1:${API_PORT:-3001}/health" > /dev/null; then
    log "API healthcheck OK"
  else
    err "API neodpovídá na /health"
    ${COMPOSE} logs --tail=50 server
    exit 1
  fi
fi

log "Healthcheck Caddy (internal Docker network)..."
# Caddy is not exposed on the host — Cloudflare Tunnel reaches it via the
# `caddy` Docker network alias. Probe through a one-shot container on that
# network so we don't depend on host port binding.
if docker run --rm --network "narrative_default" curlimages/curl:8.10.1 \
    -fsS --max-time 10 http://caddy/health > /dev/null 2>&1; then
  log "Caddy healthcheck OK"
else
  warn "Caddy /health did not respond on the internal network — check 'docker logs narrative-caddy'"
fi

if [[ "${USE_SHARED_TUNNEL:-0}" == "1" ]]; then
  log "Skipping cloudflared healthcheck — using external tunnel"
else
  log "Healthcheck cloudflared tunnel..."
  if docker logs narrative-cloudflared 2>&1 | tail -50 | grep -q "Registered tunnel connection"; then
    log "cloudflared connected to Cloudflare edge"
  else
    warn "cloudflared has no registered tunnel connection yet — check 'docker logs narrative-cloudflared'"
  fi
fi

# ── Clean up ───────────────────────────────────────────────────────────────────
# Every release adds ~2 GB of images that nothing removes; the disk filled up
# on 2026-09-21 and a deploy died mid-extract. Keep the deployed tag and two
# releases back for a rollback, drop the rest (GHCR has them all) and the
# build cache — this host pulls, it never builds.
log "Pruning old release images (keeping ${NARRATIVE_TAG} + 2 previous)..."
"${SCRIPT_DIR}/prune-images.sh" --current "${NARRATIVE_TAG}" --keep 2 --builder-cache \
  || warn "Image prune did not complete — check disk space with 'docker system df'"

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}Deploy dokončen.${NC}"
echo "  Prostředí:  ${ENV}"
echo "  Doména:     https://${DOMAIN}  (via Cloudflare Tunnel)"
echo "  API:        https://${DOMAIN}/api/decks"
echo "  WebSocket:  wss://${DOMAIN}/ws"
echo ""
echo "Logy: docker compose ${COMPOSE_FILES} logs -f"
