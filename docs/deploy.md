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
- **No git on the server** — `/opt/narrative` is an **rsync of a working
  tree**, not a checkout. `git log` there means nothing, and there is no
  `git pull`. The directory carries config + scripts; the versioned artifact is
  the **image**.
- **Images are built locally and pushed to GHCR** (since 2026-09-07); the VM
  only pulls. See _Build & push images_ below and
  [ADR 0008](./adr/0008-release-and-image-tag-discipline.md).

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

🚨 **The images must be linux/amd64, whatever you build on.** The VM is
x86_64; Docker builds for the host architecture unless told otherwise, so an
Apple Silicon Mac produces arm64 images and the deploy dies at the pull with
`no matching manifest for linux/amd64 in the manifest list entries` — after
the tag has been pushed and `:latest` overwritten with it, so the next
tagless deploy would break too. Since 0.9.16 `build-push.sh` pins
`DOCKER_DEFAULT_PLATFORM=linux/amd64` itself (override with
`TARGET_PLATFORM=` if the VM ever moves), so nothing is needed from you — but
on an arm64 Mac the build runs under QEMU emulation and takes longer.

If it did happen, the fix is just to rebuild and push the same tag: GHCR keeps
whatever was pushed last, and the previous release's tag is untouched, so
production and rollback are never at risk from a wrong-arch push.

## Quick deploy (copy-paste)

From the project root (`~/Documents/Dev/Narrative`):

```bash
# 0. Build the images locally and push them to GHCR (the VM does not build).
#    Requires Docker running, infra/.env.prod present, and a GHCR login.
echo "$GHCR_PAT" | docker login ghcr.io -u petronijus --password-stdin
NARRATIVE_TAG=v0.9.3 infra/scripts/build-push.sh
#    → ghcr.io/petronijus/narrative-{server,video-worker,web}:{v0.9.3,latest}
#    Omit NARRATIVE_TAG and the tag defaults to the git short sha.

# 1. Sync files to production VM
rsync -avz --delete \
  --exclude .git --exclude node_modules --exclude dist \
  --exclude .env --exclude infra/.env.prod \
  --exclude .claude --exclude test-results --exclude playwright-report \
  --exclude '*.tsbuildinfo' --exclude 'proxmox_mcp.log' \
  ./ petr@192.0.2.147:/opt/narrative/

# 2. Pull + deploy on the VM
ssh petr@192.0.2.147 'chmod +x /opt/narrative/infra/scripts/*.sh &&
  cd /opt/narrative && NARRATIVE_TAG=v0.9.3 USE_SHARED_TUNNEL=1 \
  ./infra/scripts/deploy.sh prod'
```

That's it. The script pulls the prebuilt images, extracts the SPA static files,
runs DB migrations, starts all services, and runs healthchecks.
`NARRATIVE_TAG` defaults to `latest` if unset — pass the release tag explicitly
so the deployed image is identifiable afterwards.

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
3. **Pulls** the prebuilt images from GHCR at `NARRATIVE_TAG` (default
   `latest`) — it does **not** build (was `docker compose build --pull` before
   2026-09-07); needs a one-time `docker login ghcr.io` on the host, the
   packages are private
4. Pulls `ghcr.io/petronijus/narrative-web:$NARRATIVE_TAG`, creates a throwaway
   container and copies `/srv/web` into the `narrative_web_static` Docker
   volume that Caddy serves. The prod `VITE_*` values (API URL, WS URL,
   imgproxy URL, `VITE_BUILD_VERSION`) were baked in **at build time** by
   `build-push.sh` from `infra/.env.prod`
5. Runs Drizzle DB migrations
6. `docker compose up -d --remove-orphans`
7. Waits 15s, then runs healthchecks (API, Caddy, optionally cloudflared)
8. **Prunes old release images** — `infra/scripts/prune-images.sh` keeps the
   deployed tag plus two previous per image (server / video-worker / web),
   never touches an image a running container uses, then drops dangling
   layers and the build cache (this host pulls, it never builds). Added after
   2026-09-21, when sixteen releases of images and 14 GB of stale build cache
   filled the 38 GB disk to 99% and a deploy died mid-extract. Anything
   pruned is still in GHCR. `build-push.sh` does the same on the build
   machine, keeping its build cache.

## Verifying the deploy

```bash
# From your workstation — public endpoint
curl -sI https://narrative.example.com | head -5
# HTTP/2 200

# WHICH VERSION is actually live (the single most useful check)
curl -s https://narrative.example.com/version.json
# {"version":"v0.9.3+00454ec"}

# The document must not be cacheable, or deploys look like no-ops
curl -sI https://narrative.example.com | grep -i cache-control
# cache-control: no-cache

# The live CSP — the file on disk is NOT evidence, see "Config-only changes"
curl -sI https://narrative.example.com | grep -i content-security-policy

# API health
curl https://narrative.example.com/api/health
# {"status":"ok"}

# On the VM — container status and the image tags actually running
ssh petr@192.0.2.147 'docker ps --format "table {{.Names}}\t{{.Status}}"'
ssh petr@192.0.2.147 'docker ps --format "{{.Names}}|{{.Image}}"'
```

All containers should show `Up` + `(healthy)`, and the image tags should match
the tag you deployed.

## Config-only changes (Caddyfile, compose)

These ship by rsync + redeploy **without** a version bump, so they do not move
`/version.json` — verify them against the served artifact instead.

🚨 **The file on the host is not proof the container sees it.** Compose used to
mount `./caddy/Caddyfile` as a single file; a single-file bind mount is pinned
to the file's **inode**, and rsync _replaces_ files rather than rewriting them
in place, so the container went on reading the old, unlinked inode while the
host file, `caddy validate` and `caddy reload` all reported success. That is
how the CSP fix of 2026-09-09 appeared not to land. The **directory** is
mounted now (`./caddy:/etc/caddy:ro`, commit `e6b4042`) — do not "simplify" it
back to a file mount.

After a Caddy config change:

```bash
ssh petr@192.0.2.147 'docker exec narrative-caddy caddy validate --config /etc/caddy/Caddyfile'
ssh petr@192.0.2.147 'docker exec narrative-caddy caddy reload --config /etc/caddy/Caddyfile'
curl -sI https://narrative.example.com | grep -i content-security-policy   # the real check
```

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

The server is stateless (code + Docker images), and since 2026-09-07 every
release is a tagged image in GHCR — so a rollback is **re-deploying an older
tag**, not checking out an older commit and rebuilding:

```bash
ssh petr@192.0.2.147 'cd /opt/narrative && \
  NARRATIVE_TAG=v0.9.2 USE_SHARED_TUNNEL=1 ./infra/scripts/deploy.sh prod'

# Confirm
curl -s https://narrative.example.com/version.json
```

Two caveats:

- **DB migrations are forward-only** (Drizzle). If the newer version migrated
  the schema, rolling the image back may leave the old code facing a newer
  schema. If a migration broke something, write a new migration to undo it —
  don't manually drop tables.
- **Config is not in the image.** If the bad deploy also changed the Caddyfile
  or compose files, rsync the older config too, or the old image runs behind
  the new proxy config.

Available tags: `git tag` locally, or
`docker image ls 'ghcr.io/petronijus/narrative-*'` on the VM — which only
holds the current release and two before it (the deploy prunes the rest).
Rolling further back just pulls the tag from GHCR again; `deploy.sh` does
that on its own.

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

### Deploy fails at "Stahuji prebuilt images z GHCR…"

Either the host is not logged in to GHCR (the packages are private) or the tag
does not exist because `build-push.sh` was never run for it:

```bash
ssh petr@192.0.2.147 'docker login ghcr.io -u petronijus'   # one-time, needs a PAT with read:packages
NARRATIVE_TAG=v0.9.3 infra/scripts/build-push.sh            # on the build machine
```

If the pull itself fails on space, clean up:

```bash
ssh petr@192.0.2.147 'docker system prune -af --volumes'
```

### `build-push.sh` fails to resolve a workspace package

Each Dockerfile copies the workspace `package.json` files it needs **before**
`pnpm install`, by an explicit list. A new workspace package that an image
depends on has to be added to that image's list, or the install inside the
build cannot link it. Agentic-layer A0 (2026-09-26, unreleased) added
`packages/commands` to `apps/web/Dockerfile`; the server and video-worker
images do not depend on it. They do now load **zod** at runtime through
`packages/shared`, which the `--prod` install picks up from
`packages/shared/package.json`. No image had been built with A0 when this was
written — the first `build-push.sh` after it is the verification.

### The browser shows an old version after a deploy

`index.html` is served `no-cache` and the client-side version guard reloads a
tab whose bundle disagrees with `/version.json`. If a browser still shows old
UI, check in this order:

```bash
curl -s https://narrative.example.com/version.json          # did the deploy land at all?
curl -sI https://narrative.example.com | grep -i cache-control
```

A browser that cached `index.html` **before** the `no-cache` header existed
(pre-0.9.0) can hold it for weeks under heuristic freshness — the version guard
exists precisely to break that, and needs one load to fire.

### 415 on uploads / logout, blank canvas, or images that never appear

These are the production-only failure classes fixed in 0.9.x — the tunnel
re-framing bodyless POSTs, and the CSP blocking Pixi's eval / worker / font /
probe paths. Read the live CSP and
[`docs/handoff/0.9.x-production-hardening.md`](./handoff/0.9.x-production-hardening.md)
before re-diagnosing from scratch. A CSP denial is silent to the application:
a blocked worker leaves a promise that never settles, a blocked font leaves a
plausible wrong-looking result.

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
