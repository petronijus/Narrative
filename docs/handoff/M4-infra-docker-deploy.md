# Handoff M4 — Infra: Docker + Deploy Script

**Status:** done (fáze 2 — infra vrstva)
**Date:** 2026-04-19
**Agent:** infra
**Navazuje na:** `docs/handoff/M4-state-sync-hocuspocus.md` (fáze 1)

---

## Co bylo dokončeno

### 1. Dockerfiles (multi-stage)

**`apps/server/Dockerfile`** — Node.js server, dvě stage:

- `builder`: pnpm full install + `tsc --project tsconfig.build.json` → `apps/server/dist/`
- `runtime`: pnpm prod-only install (`--prod --ignore-scripts`) + zkopíruje `dist/` + `drizzle/`
- HEALTHCHECK přes `wget` na `/health`
- EXPOSE 3001 (Fastify) + 3002 (Hocuspocus)

**`apps/web/Dockerfile`** — React SPA, dvě stage:

- `builder`: pnpm full install + `vite build` (VITE\_\* jako ARG)
- `runtime`: Caddy alpine se statickými soubory v `/srv/web/`
- Build args: `VITE_API_URL`, `VITE_HOCUSPOCUS_URL` (deploy.sh je předává správně)

**`apps/server/tsconfig.build.json`** — separátní tsconfig pro emit (noEmit=false), bez test souborů.

### 2. `.dockerignore` v rootu

Vylučuje: `node_modules`, `dist`, `.git`, `spikes`, `docs`, `.env*`, `.claude`, `.github`, `coverage`.

### 3. `infra/docker-compose.yml` — rozšířen o server service

- `server` service: build z `apps/server/Dockerfile`, healthcheck, `depends_on postgres (healthy)`
- Postgres healthcheck: `pg_isready` s `start_period: 10s`
- Ports: `3001` (API), `3002` (WS) — obě na 0.0.0.0 pro dev/local

### 4. `infra/docker-compose.prod.yml` — production override

- Caddy service s volume `/srv/web` (statika) + `caddy_data` (TLS certs)
- Postgres port binding na `127.0.0.1` (nepublikovat ven)
- Server ports binding na `127.0.0.1` (Caddy je před nimi)
- `PG_DATA_PATH` env var pro ZFS dataset mount
- `DOMAIN` env var required (Caddy auto-TLS)

### 5. `infra/caddy/Caddyfile`

Routing:

```
/api/*  → reverse_proxy server:3001
/ws*    → reverse_proxy server:3002 (WebSocket upgrade headers)
/*      → file_server z /srv/web s try_files fallback na index.html (SPA)
```

### 6. `infra/scripts/deploy.sh`

Idempotentní deploy skript. Funkce:

1. Validace `.env.prod`
2. ZFS snapshot před prod deployem (pokud `ZFS_DATASET` + `zfs` binary dostupné)
3. `docker compose build --pull`
4. Web static build jako separátní image → extrakce do `web_static` volume přes tar pipe
5. DB migrace: `docker compose run --rm server node apps/server/dist/db/migrate.js`
6. `docker compose up -d --remove-orphans`
7. Healthcheck: `curl localhost:3001/health` + `curl https://DOMAIN/health`

Použití:

```bash
cd /opt/narrative/infra
./scripts/deploy.sh prod
```

### 7. `infra/scripts/backup.sh`

pg_dump → gzip → `backups/narrative-TIMESTAMP.sql.gz`. Retention: `RETAIN_DAYS` dní (default 7).

### 8. `infra/.env.prod.example`

Template pro produkční env vars. Dokumentuje: DOMAIN, POSTGRES\_\*, PG_DATA_PATH, ZFS_DATASET, BACKUP_DIR.

### 9. `.env.example` rozšíření

Přidány: CORS_ORIGIN, DOMAIN, PG_DATA_PATH, ZFS_DATASET, BACKUP_DIR (produkční vars).

### 10. CI rozšíření (`.github/workflows/ci.yml`)

Přidán `docker-build` job (paralelně s CI):

- Docker Buildx setup
- Build server image (push: false — jen validace)
- Build web image s VITE args
- GitHub Actions cache pro Docker layers (type=gha)

### 11. README.md — Deployment sekce

Přidána kompletní sekce: architektura, prod-like local test, remote deploy workflow, DB migrace, backup, cron.

### 12. Opravy package.json

- `apps/server/package.json`: `yjs` přidán jako přímá dependency (bylo transitive, tsc build selhával)
- `apps/web/package.json`: totéž — `yjs` jako přímá dependency
- `apps/server/package.json`: `build` script změněn z `tsc --noEmit` na `tsc --project tsconfig.build.json` (skutečný emit)

---

## Docker build výsledky (ověřeno lokálně)

```
narrative-server:m4-test  → BUILD OK
  - builder stage: pnpm install + tsc emit (13 souborů do dist/)
  - runtime stage: prod deps + dist/ + drizzle/

narrative-web:m4-test     → BUILD OK
  - builder stage: pnpm install + vite build (821 modulů, ~628 kB main chunk)
  - runtime stage: caddy:2-alpine se statickými soubory
  - Warning: chunk > 500 kB (PixiJS — expected, TODO code-split v M8+)
```

---

## Architektonická rozhodnutí

### Caddy serve static místo nginx service

Caddy je reverse proxy i static file server. Odpadá `nginx` service — méně containerů, jednodušší konfigurace. Web statika jde do Docker volume přes tar pipe v deploy.sh, Caddy ji servuje z `/srv/web`.

### Web static jako volume, ne embedded v Caddy image

Caddy image by musel mít VITE env vars "vypečeny" při build time. Deploy.sh buildí web image s runtime-correct VITE\_ hodnotami a extrahuje soubory do named volume. Caddy volume pak Caddy mountuje. Výhoda: Caddy image je generický, env vars jsou deploy-time concern.

### `--ignore-scripts` v server runtime stage

Root `package.json` má `"prepare": "husky"` lifecycle script. V Docker bez `.git` by selhal. `--ignore-scripts` přeskočí všechny lifecycle scripts.

### `tsconfig.build.json` jako separate config

Server `tsconfig.json` měl `"noEmit": true` zděděné z base (přes `typecheck` script). Separátní `tsconfig.build.json` extends base s `noEmit: false`, excluduje test soubory. `typecheck` zůstává beze změny.

---

## Soubory přidané / upravené

### Nové soubory

| Soubor                                   | Popis                                 |
| ---------------------------------------- | ------------------------------------- |
| `apps/server/Dockerfile`                 | Multi-stage server image              |
| `apps/server/tsconfig.build.json`        | tsconfig pro emit (ne --noEmit)       |
| `apps/web/Dockerfile`                    | Multi-stage web image (Caddy runtime) |
| `.dockerignore`                          | Root dockerignore                     |
| `infra/docker-compose.prod.yml`          | Production compose override           |
| `infra/caddy/Caddyfile`                  | Caddy routing config                  |
| `infra/scripts/deploy.sh`                | Idempotentní deploy skript            |
| `infra/scripts/backup.sh`                | pg_dump backup skript                 |
| `infra/.env.prod.example`                | Produkční env template                |
| `docs/handoff/M4-infra-docker-deploy.md` | Tento dokument                        |

### Upravené soubory

| Soubor                     | Změna                                                             |
| -------------------------- | ----------------------------------------------------------------- |
| `infra/docker-compose.yml` | Přidán server service + postgres healthcheck start_period         |
| `.env.example`             | Přidány prod vars (DOMAIN, PG_DATA_PATH, ZFS_DATASET, BACKUP_DIR) |
| `.gitignore`               | Přidány: `infra/.env.prod`, `backups/`                            |
| `.github/workflows/ci.yml` | Přidán docker-build job s GitHub Actions cache                    |
| `apps/server/package.json` | `yjs` jako přímá dep, build script → tsconfig.build.json          |
| `apps/web/package.json`    | `yjs` jako přímá dep                                              |
| `README.md`                | Deployment sekce                                                  |

---

## Co příští infra agent potřebuje

### M6 — Sentry + základní metriky

- Přidat `SENTRY_DSN` do `.env.prod.example` + compose env
- Sentry SDK init v server + web

### M10 — Authentik OIDC

- Přidat `authentik` service do `docker-compose.yml`
- Přidat `AUTHENTIK_SECRET_KEY` do env
- Caddy forward-auth middleware nebo JWT validation

### M11 — MinIO

- Přidat `minio` service
- Backup script rozšíření: `mc mirror` pro MinIO → offsite

### M12 — Harbor registry + CI push

- CI: přidat `docker push` krok po build validaci
- deploy.sh: `docker compose pull` místo local build (images z registry)

---

## Blokery / Omezení

**Skutečný deploy na staging** — uživatel provádí ručně. Skript je připraven, instrukce v README.

**ZFS snapshot** — vyžaduje `zfs` binary + `ZFS_DATASET` env. Na non-ZFS systémech se přeskočí s varováním.

**Windows symlink chyba při pnpm install** — přetrvává z fáze 1 (viz M4-state-sync-hocuspocus.md). Nebrání Docker buildu (běží na Linux alpine).

**Web chunk size warning** — PixiJS způsobuje >500 kB main bundle. Není blokující pro M4. Code-splitting TODO v M8+.

**Auth je M10** — API je otevřené, deploy pouze na private network / za firewallem.
