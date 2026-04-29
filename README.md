# Narrative

Self-hosted collaborative presentation tool with Keynote-level animations, real-time multi-user editing, and AI-assisted slide generation. Built for small teams (up to 15 simultaneous editors) on your own infrastructure.

## Requirements

- Node.js >= 22
- pnpm >= 9
- Docker (for local Postgres)

## Setup

See **[SETUP.md](./SETUP.md)** for the complete first-run guide — env vars, Docker
services, MinIO bucket, migrations, optional video pipeline / Authentik, and a
troubleshooting list for the failures that actually bite on a fresh machine.

TL;DR for an experienced setup:

```bash
pnpm install
cp .env.example .env                   # then fill secrets — see SETUP.md
docker compose -f infra/docker-compose.yml --env-file .env up -d \
  postgres minio minio-init imgproxy
pnpm --filter server db:migrate
pnpm dev                               # web :5173, server :3001
```

Verify:

```bash
curl http://localhost:3001/health      # {"status":"ok"}
```

## Structure

```
apps/
  web/      React + Vite + TS + Tailwind (editor frontend)
  server/   Fastify + TypeScript (API + Hocuspocus, added M4)
packages/
  shared/       Shared types (API shapes, etc.)
  slide-model/  Yjs bindings + object type registry
  animation/    JSON DSL + GSAP compiler
  ui/           Reusable React components
infra/
  docker-compose.yml   Postgres (dev) — extended in M4/M10/M11
  scripts/             Deploy + backup scripts
docs/
  adr/       Architecture Decision Records
  handoff/   Per-milestone handoff documents
```

See [BUILD_PLAN.md](./BUILD_PLAN.md) for the full milestone roadmap and stack decisions.

See [docs/agents.md](./docs/agents.md) for the AI agent workflow and ownership model.

## Development scripts

```bash
pnpm dev          # Start web + server in parallel
pnpm -r build     # Build all workspaces
pnpm -r typecheck # TypeScript check across all workspaces
pnpm -r lint      # ESLint across all workspaces
pnpm -r test      # Tests across all workspaces
```

## CI

GitHub Actions runs on every push and PR to `main`:
lint → typecheck → build → test + Docker build validation.

See [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Authentication (M10)

### Architecture

Authentik is the self-hosted OIDC identity provider. Both the Narrative web app and server validate JWTs issued by Authentik.

```
User → Narrative web (http://localhost:5173)
      → redirects to Authentik authorize endpoint (auth.DOMAIN or localhost:9000)
      → user logs in at Authentik
      → Authentik redirects back with authorization code
      → web exchanges code for JWT access token (PKCE flow — no client secret)
      → web stores token, sends as Bearer on every API/WS request
      → server validates JWT signature via Authentik JWKS endpoint
      → server checks issuer claim matches AUTHENTIK_ISSUER
```

Access control: users must be members of the `narrative-users` group in Authentik. The blueprint creates this group automatically; you add users to it manually via the Authentik admin UI.

### First-run setup

```bash
# 1. Generate secrets
openssl rand -hex 32    # → AUTHENTIK_SECRET_KEY in .env
openssl rand -hex 16    # → AUTHENTIK_POSTGRES_PASSWORD in .env

# 2. Set env vars in .env (dev) or infra/.env.prod (prod)
#    Required: AUTHENTIK_SECRET_KEY, AUTHENTIK_POSTGRES_PASSWORD,
#              AUTHENTIK_BOOTSTRAP_PASSWORD, AUTHENTIK_BOOTSTRAP_EMAIL

# 3. Start services
cd infra
docker compose --env-file ../.env -f docker-compose.yml up -d

# 4. Wait for blueprint to apply (30–60 s on first run)
docker compose -f docker-compose.yml logs -f authentik-server | grep -i blueprint

# 5. Open Authentik admin
#    → http://localhost:9000
#    → Username: akadmin
#    → Password: value of AUTHENTIK_BOOTSTRAP_PASSWORD
#    → If AUTHENTIK_BOOTSTRAP_PASSWORD was empty: visit http://localhost:9000/if/flow/initial-setup/

# 6. Update the redirect URI for your production domain
#    Admin UI → Providers → Narrative OIDC Provider → Edit
#    Add: https://narrative.example.com/auth/callback

# 7. Create the first Narrative user
#    Admin UI → Directory → Users → Create
#    Then: Directory → Groups → narrative-users → Add member

# 8. Verify OIDC endpoints are reachable
./scripts/verify-authentik.sh
```

### Blueprint

`infra/authentik/blueprints/custom/narrative-oidc.yaml` is applied automatically on each Authentik server start. It creates (idempotently):

- OIDC provider `Narrative OIDC Provider` — public client, PKCE, client ID `narrative-web`
- Application `Narrative` linked to the provider
- Group `narrative-users`
- Expression policy restricting app access to group members

The blueprint pre-registers `http://localhost:5173/auth/callback` as a redirect URI. Add your production URI via admin UI or edit the blueprint before first run.

### DNS (production)

Both `narrative.example.com` and `auth.narrative.example.com` must resolve to the server IP. Use either:

- A wildcard DNS record: `*.narrative.example.com → server IP`
- Two explicit A records: `narrative.example.com` + `auth.narrative.example.com`

Caddy handles TLS automatically for both via Let's Encrypt.

## Video pipeline (M12)

### Architecture

```
User uploads video via tus.io (existing upload endpoint)
  → server receives upload-complete event
  → server enqueues BullMQ job on media-redis (video-transcode queue)
  → video-worker picks up job
  → ffmpeg transcodes: 360p / 720p / 1080p HLS segments + poster + thumbnail
  → outputs uploaded to MinIO under decks/<deckId>/videos/<assetId>/
  → media_assets row updated with HLS manifest key, duration, dimensions, status=ready
  → client polls GET /api/media/:id or receives Yjs state update
```

### Services

- `media-redis` — dedicated Redis instance for the BullMQ queue (port 6380 by default, separate from Authentik's Redis on its internal Docker network).
- `video-worker` — Node.js + ffmpeg container, runs `@narrative/video-worker` package.

### MinIO bucket layout extension

```
narrative-media/
  decks/<deckId>/
    videos/<assetId>/
      master.m3u8         # HLS master playlist (all variants)
      360p/
        playlist.m3u8
        seg000.ts
        seg001.ts
        ...
      720p/
        playlist.m3u8
        ...
      1080p/
        playlist.m3u8
        ...
      poster.jpg          # first I-frame, full resolution
      thumb.jpg           # poster scaled to 320 px wide
```

### Running locally

Start both services alongside the existing stack:

```bash
# Start media-redis + video-worker (requires MinIO to be up)
cd infra
docker compose --env-file ../.env up -d media-redis video-worker

# Check worker logs
docker compose --env-file ../.env logs -f video-worker

# Health probe for media-redis
MEDIA_REDIS_URL=redis://127.0.0.1:6380 ./scripts/verify-redis.sh
```

For rapid iteration on worker code without rebuilding the image:

```bash
# Worker connects to MEDIA_REDIS_URL from .env (127.0.0.1:6380)
# Make sure media-redis container is up first.
pnpm --filter @narrative/video-worker dev
```

### Environment variables

| Variable                | Default                  | Where                                     |
| ----------------------- | ------------------------ | ----------------------------------------- |
| `MEDIA_REDIS_PORT`      | `6380`                   | Host port for media-redis                 |
| `MEDIA_REDIS_URL`       | `redis://127.0.0.1:6380` | Server uses this to enqueue jobs          |
| `WORKER_CONCURRENCY`    | `2`                      | Parallel ffmpeg jobs per worker container |
| `MEDIA_REDIS_DATA_PATH` | _(named volume)_         | Prod: ZFS path for queue persistence      |

Worker-internal env (set by compose, not needed in `.env`):

| Variable         | Value in compose           |
| ---------------- | -------------------------- |
| `REDIS_URL`      | `redis://media-redis:6379` |
| `MINIO_ENDPOINT` | `http://minio:9000`        |

### Phase 1a status

The `transcodeProcessor` in `apps/video-worker/src/processors/transcode.ts` is a **stub** — it throws immediately. The worker boots and connects to Redis, queues are registered, but jobs will fail until the media agent implements the real ffmpeg pipeline in phase 2.

### Known TODOs (phase 2+)

- Media agent implements real ffmpeg transcoding in `transcodeProcessor`
- Server endpoint to enqueue jobs after tus upload completes
- `GET /api/media/:id/video-info` returning HLS manifest URL for client playback
- Audio-only fallback track (M14+)
- HLS variant selection UI in the player
- DRM / signed HLS URLs (M29+)
- Resource limits on video-worker (M29 — profile first)

### Authentik version

Pinned to `ghcr.io/goauthentik/server:2024.8.3`. To upgrade: update the image tag in `infra/docker-compose.yml` (both `authentik-server` and `authentik-worker`) and review the Authentik changelog for breaking changes.

### Consumer expectations for phase 2 (server JWT middleware)

The server implementation in M10 phase 2 should:

- Fetch JWKS from `AUTHENTIK_JWKS_URL` (internal Docker network, no TLS needed)
- Validate JWT signature using keys from JWKS
- Verify `iss` claim matches `AUTHENTIK_ISSUER`
- Verify `aud` claim includes `AUTHENTIK_CLIENT_ID` (`narrative-web`)
- Reject tokens with `exp` in the past
- Extract `sub` (user ID) and `email` claims for request context

---

## Media pipeline (M11)

### Architecture

MinIO stores original uploaded files; imgproxy serves resized variants on demand.

```
Browser upload  → apps/server /api/uploads/* (tus, resumable) → MinIO S3 (internal)
Browser display → Caddy /imgproxy/* → imgproxy → MinIO S3 (internal)
```

See [docs/storage.md](./docs/storage.md) for the full bucket layout, URL structure, and ops notes.

### First-run setup (dev)

```bash
# 1. Generate imgproxy signing secrets (run twice — one for KEY, one for SALT)
xxd -g 2 -l 32 -p /dev/random | tr -d '\n'

# 2. Set env vars in .env
#    Required: MINIO_ROOT_USER, MINIO_ROOT_PASSWORD, IMGPROXY_KEY, IMGPROXY_SALT

# 3. Start MinIO + imgproxy
cd infra
docker compose --env-file ../.env up -d minio minio-init imgproxy

# minio-init exits automatically after creating the bucket (check with:)
docker compose --env-file ../.env logs minio-init
# Expected: "Bucket ready: narrative-media"

# 4. Verify
MINIO_ROOT_USER=... MINIO_ROOT_PASSWORD=... ./scripts/verify-minio.sh
```

Service endpoints in dev:

- MinIO S3 API: `http://localhost:9100`
- MinIO console: `http://localhost:9101`
- imgproxy: `http://localhost:8080`

### First-run setup (prod)

```bash
# On the server — before first deploy:
zfs create tank/narrative/minio

# In infra/.env.prod, set:
#   MINIO_DATA_PATH=/mnt/tank/narrative/minio
#   MINIO_ROOT_USER, MINIO_ROOT_PASSWORD (strong values)
#   IMGPROXY_KEY, IMGPROXY_SALT (64 hex chars each — see above)
#   VITE_IMGPROXY_URL=https://narrative.example.com/imgproxy
```

DNS: `minio.${DOMAIN}` must resolve to the server (wildcard `*.${DOMAIN}` covers this). Caddy handles TLS automatically.

### Security notes

- `IMGPROXY_KEY` and `IMGPROXY_SALT` must NOT be committed. They protect signed URLs from manipulation.
- MinIO console (`minio.${DOMAIN}`) is admin-only. Consider restricting with firewall rules or forward auth (planned M29).
- imgproxy only serves objects from MinIO — `IMGPROXY_ALLOWED_SOURCES` is restricted to `minio:9000`.

---

## Deployment

> **Security note (M10):** Authentik is now deployed. The system can be exposed to the public internet after M10 phase 2 (server JWT validation) is complete. Phase 1a (this milestone) deploys Authentik but the API is still open until the server middleware is wired in phase 2. During phase 1a, keep the server ports on 127.0.0.1 (prod compose does this) and use a firewall to block direct access.

### Architecture

Single domain, Caddy as reverse proxy with automatic TLS:

```
https://DOMAIN/          → React SPA (static files, Caddy file_server)
https://DOMAIN/api/*     → Fastify HTTP API (port 3001)
wss://DOMAIN/ws          → Hocuspocus WebSocket (port 3002)
```

### Prod-like local test (all services in containers)

```bash
cd infra
cp .env.prod.example .env.prod
# Edit .env.prod — at minimum: POSTGRES_PASSWORD, DOMAIN=localhost

docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod up -d

# Verify
curl http://localhost:3001/health
```

### Deploy to remote server

**Prepare the target server:**

1. Install Docker with Compose plugin: https://docs.docker.com/engine/install/
2. Point DNS A record for `DOMAIN` to the server IP
3. (Optional) Create ZFS dataset: `zfs create tank/narrative/postgres`
4. Clone repo or rsync files:

```bash
rsync -av --exclude='.git' --exclude='node_modules' \
  ./ user@server:/opt/narrative/
```

**On the target server:**

```bash
cd /opt/narrative/infra
cp .env.prod.example .env.prod
# Edit .env.prod — fill DOMAIN, POSTGRES_PASSWORD, PG_DATA_PATH

chmod +x scripts/deploy.sh scripts/backup.sh
./scripts/deploy.sh prod
```

The deploy script:

1. Takes a ZFS snapshot (if `ZFS_DATASET` is set)
2. Builds Docker images
3. Builds the React SPA and copies static files into the Caddy volume
4. Runs DB migrations (Drizzle)
5. Starts all services with `docker compose up -d`
6. Runs health checks

### DB migrations

Migrations run automatically during deploy. To run manually:

```bash
cd infra
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  run --rm server node apps/server/dist/db/migrate.js
```

### Backup

```bash
cd infra
./scripts/backup.sh .env.prod
```

Backups are stored as gzip-compressed pg_dump files in `BACKUP_DIR` (default: `../backups/`).
Retention: `RETAIN_DAYS` days (default: 7).

Add to cron for automated backups:

```
0 3 * * * /opt/narrative/infra/scripts/backup.sh /opt/narrative/infra/.env.prod
```
