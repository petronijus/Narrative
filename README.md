# Narrative

Self-hosted collaborative presentation tool with Keynote-level animations, real-time multi-user editing, and AI-assisted slide generation. Built for small teams (up to 15 simultaneous editors) on your own infrastructure.

## Requirements

- Node.js >= 22
- pnpm >= 9
- Docker (for local Postgres)

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy env template and fill in values
cp .env.example .env
# Edit .env — at minimum set POSTGRES_PASSWORD

# 3. Start local Postgres
docker compose -f infra/docker-compose.yml up -d

# 4. Start dev servers (web on :5173, server on :3001)
pnpm dev
```

Verify the server is running:

```bash
curl http://localhost:3001/health
# {"status":"ok"}
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

## Deployment

> **Security note:** Auth (OIDC via Authentik) is added in M10. Until then the API is open — deploy only on private networks or behind a firewall. Do not expose to the public internet before M10.

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
