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

# ── Build ──────────────────────────────────────────────────────────────────────
log "Stavíme Docker images..."
${COMPOSE} build --pull

# ── Web static build ───────────────────────────────────────────────────────────
# Web se buildí jako Docker image, ale statické soubory potřebujeme v volume
# který Caddy mountuje. Extrahujeme je z image.
log "Extrakce statických souborů web..."

WEB_IMAGE="narrative-web-static"
# Note: VITE_OIDC_* args removed in 2026-05 cutover to server-driven auth.
docker build \
  --target runtime \
  --build-arg VITE_API_URL="https://${DOMAIN}/api" \
  --build-arg VITE_HOCUSPOCUS_URL="wss://${DOMAIN}/ws" \
  --build-arg VITE_IMGPROXY_URL="${VITE_IMGPROXY_URL:-https://${DOMAIN}/imgproxy}" \
  --tag "${WEB_IMAGE}:latest" \
  --file "${REPO_DIR}/apps/web/Dockerfile" \
  "${REPO_DIR}"

# Vytvoříme tmp container a zkopírujeme /srv/web do web_static volume
WEB_CONTAINER=$(docker create "${WEB_IMAGE}:latest")
# Zajistíme existenci volume
docker volume create narrative_web_static 2>/dev/null || true
# Zkopírujeme přes tar pipe
docker cp "${WEB_CONTAINER}:/srv/web/." - \
  | docker run --rm -i \
      -v narrative_web_static:/srv/web \
      alpine sh -c "cd /srv/web && tar xf -"
docker rm "${WEB_CONTAINER}"

log "Statické soubory zkopírovány do volume web_static"

# ── DB migrace ─────────────────────────────────────────────────────────────────
log "Spouštíme DB migrace..."
${COMPOSE} run --rm \
  --entrypoint "" \
  server \
  node apps/server/dist/apps/server/src/db/migrate.js

log "Migrace hotovy"

# ── Start services ─────────────────────────────────────────────────────────────
log "Startujeme služby..."
${COMPOSE} up -d --remove-orphans

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

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}Deploy dokončen.${NC}"
echo "  Prostředí:  ${ENV}"
echo "  Doména:     https://${DOMAIN}  (via Cloudflare Tunnel)"
echo "  API:        https://${DOMAIN}/api/decks"
echo "  WebSocket:  wss://${DOMAIN}/ws"
echo ""
echo "Logy: docker compose ${COMPOSE_FILES} logs -f"
