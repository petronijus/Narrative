# Deploy guide

Step-by-step instructions for deploying Narrative to production. Covers
both Linux (Ubuntu desktop) and macOS workstations as the deploy client.

## Production topology

```
┌─────────────────────────────────────────────────────┐
│  Cloudflare Edge (TLS termination)                  │
│  narrative.example.com                               │
└──────────────┬──────────────────────────────────────┘
               │  Cloudflare Tunnel (outbound-only)
               ▼
┌──────────────────────────────────┐
│  Docker VM (192.0.2.101)      │
│  cloudflared container           │
│  routes → http://192.0.2.147  │
└──────────────┬───────────────────┘
               │  HTTP :80
               ▼
┌──────────────────────────────────────────────────┐
│  VM 103 — narrative (192.0.2.147)             │
│  Ubuntu 24.04, 4 vCPU / 4 GB RAM / 40 GB disk   │
│                                                  │
│  Docker Compose stack:                           │
│  ┌──────────┐  ┌────────┐  ┌─────────┐          │
│  │  Caddy   │→ │ server │  │  minio  │          │
│  │  :80     │  │ :3001  │  │  :9000  │          │
│  │          │  │ :3002  │  │         │          │
│  └──────────┘  └────────┘  └─────────┘          │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐ │
│  │ postgres │  │ imgproxy   │  │ video-worker │ │
│  │  :5432   │  │  :8080     │  │ (ffmpeg)     │ │
│  └──────────┘  └────────────┘  └──────────────┘ │
│  ┌──────────────┐                                │
│  │ media-redis   │                               │
│  │  :6379        │                               │
│  └──────────────┘                                │
└──────────────────────────────────────────────────┘
```

- **Ingress**: Cloudflare Tunnel terminates TLS at the edge. An external
  `cloudflared` on VM `192.0.2.101` routes `narrative.example.com` to
  `http://192.0.2.147:80`. Caddy then reverse-proxies to internal services.
- **Auth**: Google OIDC with server-side code exchange. `OIDC_CLIENT_SECRET`
  stays server-only. Gated by `OIDC_ALLOWED_EMAILS`.
- **No git on the server** — code is rsynced from the local checkout.

## Prerequisites (deploy client)

### Linux (Ubuntu)

```bash
# SSH access to VM 103
ssh petr@192.0.2.147       # direct (from LAN)
ssh -J root@192.0.2.100 petr@192.0.2.147  # via jump host (outside LAN)

# Required tools
rsync --version   # pre-installed on Ubuntu
ssh -V            # pre-installed
```

### macOS

```bash
# Install rsync if missing (macOS ships an older version, but it works)
brew install rsync   # optional, for a newer version

# SSH access — same as Linux
ssh petr@192.0.2.147       # direct (from LAN)
ssh -J root@192.0.2.100 petr@192.0.2.147  # via jump host (outside LAN)
```

Both platforms need the ed25519 SSH key that VM 103 trusts. The key is
already set up on both machines.

## Quick deploy (copy-paste)

From the project root (`~/Documents/Dev/Narrative`):

```bash
# 1. Sync files to production VM
rsync -avz --delete \
  --exclude .git --exclude node_modules --exclude dist \
  --exclude .env --exclude infra/.env.prod \
  --exclude .claude --exclude test-results --exclude playwright-report \
  --exclude '*.tsbuildinfo' --exclude 'proxmox_mcp.log' \
  ./ petr@192.0.2.147:/opt/narrative/

# 2. Build + deploy on the VM
ssh petr@192.0.2.147 'chmod +x /opt/narrative/infra/scripts/*.sh &&
  cd /opt/narrative && USE_SHARED_TUNNEL=1 ./infra/scripts/deploy.sh prod'
```

That's it. The script builds Docker images, extracts the SPA static files,
runs DB migrations, starts all services, and runs healthchecks.

Expected output at the end:

```
→ API healthcheck OK (via docker exec)
→ Caddy healthcheck OK
→ Skipping cloudflared healthcheck — using external tunnel

Deploy dokončen.
  Prostředí:  prod
  Doména:     https://narrative.example.com  (via Cloudflare Tunnel)
  API:        https://narrative.example.com/api/decks
  WebSocket:  wss://narrative.example.com/ws
```

## What the deploy script does

1. Validates `infra/.env.prod` exists (with `DOMAIN` and `POSTGRES_PASSWORD`)
2. Takes a ZFS snapshot before prod deploys (skipped if ZFS unavailable)
3. Builds Docker images (`docker compose build --pull`)
4. Builds the web SPA with prod `VITE_*` args, extracts static files into
   the `narrative_web_static` Docker volume
5. Runs Drizzle DB migrations
6. `docker compose up -d --remove-orphans`
7. Waits 15s, then runs healthchecks (API, Caddy, optionally cloudflared)

## Verifying the deploy

```bash
# From your workstation — public endpoint
curl -sI https://narrative.example.com | head -5
# HTTP/2 200

# API health
curl https://narrative.example.com/api/health
# {"status":"ok"}

# On the VM — container status
ssh petr@192.0.2.147 'docker ps --format "table {{.Names}}\t{{.Status}}"'
```

All containers should show `Up` + `(healthy)`.

## Checking logs

```bash
# All services
ssh petr@192.0.2.147 'cd /opt/narrative/infra && \
  docker compose -f docker-compose.yml \
    -f docker-compose.prod.yml \
    -f docker-compose.prod.shared-tunnel.yml \
    logs -f --tail=50'

# Single service
ssh petr@192.0.2.147 'docker logs narrative-server --tail=100 -f'
ssh petr@192.0.2.147 'docker logs narrative-caddy --tail=100 -f'
```

## Rollback

The server is stateless (code + Docker images). To rollback:

```bash
# On your workstation — check out the previous commit
git checkout HEAD~1

# Re-deploy
rsync -avz --delete \
  --exclude .git --exclude node_modules --exclude dist \
  --exclude .env --exclude infra/.env.prod \
  --exclude .claude --exclude test-results --exclude playwright-report \
  --exclude '*.tsbuildinfo' --exclude 'proxmox_mcp.log' \
  ./ petr@192.0.2.147:/opt/narrative/

ssh petr@192.0.2.147 'cd /opt/narrative && \
  USE_SHARED_TUNNEL=1 ./infra/scripts/deploy.sh prod'

# Return to the branch you were on
git checkout -
```

DB migrations are forward-only (Drizzle). If a migration broke something,
write a new migration to undo it — don't manually drop tables.

## Environment secrets

`infra/.env.prod` lives only on the VM at `/opt/narrative/infra/.env.prod`
(chmod 600, gitignored). It is **never rsynced** (excluded in the rsync
command). If you need to edit it:

```bash
ssh petr@192.0.2.147 'nano /opt/narrative/infra/.env.prod'
```

Key secrets and where they come from:

| Variable                | Source                                            |
| ----------------------- | ------------------------------------------------- |
| `POSTGRES_PASSWORD`     | `openssl rand -hex 32` (generated at setup)       |
| `OIDC_CLIENT_ID`        | Google Cloud → petr-apps → OAuth credentials      |
| `OIDC_CLIENT_SECRET`    | Same (1Password: `google petr-apps OAuth client`) |
| `SESSION_COOKIE_SECRET` | `openssl rand -hex 32` (generated at setup)       |
| `MINIO_ROOT_USER/PASS`  | Chosen at setup                                   |
| `IMGPROXY_KEY/SALT`     | `openssl rand -hex 32` each (generated at setup)  |
| `RESEND_API_KEY`        | Resend dashboard                                  |

If `.env.prod` is lost, regenerate all secrets, update the Postgres
password via `psql`, and redeploy.

## Adding a new allowed user

```bash
ssh petr@192.0.2.147 "sudo sed -i \
  's/OIDC_ALLOWED_EMAILS=.*/OIDC_ALLOWED_EMAILS=petr@example.com,friend@gmail.com/' \
  /opt/narrative/infra/.env.prod"

# Recreate server container (no rebuild needed)
ssh petr@192.0.2.147 'cd /opt/narrative/infra && \
  docker compose -f docker-compose.yml \
    -f docker-compose.prod.yml \
    -f docker-compose.prod.shared-tunnel.yml \
    --env-file .env.prod up -d --force-recreate server'
```

## Backups

Automated daily pg_dump via cron (already set up on the VM):

```
0 3 * * * /opt/narrative/infra/scripts/backup.sh /opt/narrative/infra/.env.prod
```

Manual backup:

```bash
ssh petr@192.0.2.147 '/opt/narrative/infra/scripts/backup.sh \
  /opt/narrative/infra/.env.prod'
```

## Troubleshooting

### Deploy fails at "Stavíme Docker images..."

Docker build ran out of disk space. Clean up:

```bash
ssh petr@192.0.2.147 'docker system prune -af --volumes'
```

### API healthcheck fails

```bash
ssh petr@192.0.2.147 'docker logs narrative-server --tail=50'
```

Common causes:

- `.env.prod` missing a required variable (the error log names it)
- Postgres not ready yet (the compose healthcheck should handle this)

### Site unreachable but healthchecks pass on the VM

The Cloudflare Tunnel on `192.0.2.101` might be down:

```bash
ssh root@192.0.2.101 'docker ps | grep cloudflared'
ssh root@192.0.2.101 'docker logs cloudflared --tail=20'
```

### macOS: rsync version warnings

macOS ships rsync 2.x which lacks some flags. If you see warnings:

```bash
brew install rsync
# Then use /opt/homebrew/bin/rsync instead of /usr/bin/rsync
```

The deploy rsync command works with both versions — the flags used are
compatible.

### "Permission denied" on deploy script

```bash
ssh petr@192.0.2.147 'chmod +x /opt/narrative/infra/scripts/*.sh'
```

This is already included in the deploy command, but if you run `deploy.sh`
directly on the VM, you may need it.
