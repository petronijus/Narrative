# Narrative

Self-hosted collaborative presentation tool with Keynote-level animations,
real-time multi-user editing, native tables, and PowerPoint round-trip.
Built for small teams (up to 15 simultaneous editors) on your own
infrastructure. Drivable by AI agents over MCP from Claude Code and
claude.ai — see [Agents (MCP)](#agents-mcp) and
[the agentic-layer plan](./docs/plans/agentic-layer.md). Released since
0.10.0 (2026-09-27; was unreleased until then, with production on 0.9.29).

Current release: **0.10.15** (2026-09-30) — see [CHANGELOG.md](./CHANGELOG.md).
Latest work:
**[Agentic layer A2 — extraction](./docs/plans/a2-extraction.md)** (2026-09-28
to 2026-09-30, closed): the editor's own logic moved into commands and the
editor dispatches them through `useCommand()`, so an agent can do what a
person can. A2.1–A2.12a shipped step by step in 0.10.2–0.10.14 (slides panel,
guides, object creation, transforms, paths, clipboard, local-file upload
sessions, gradients / shadows / page numbers, animation, tables, text, folder
tokens on the server); A2.12b (components through commands, component-owned
media) and A2.13 (the parity guard over shortcuts, menus and toolbar buttons;
no file writes documents outside commands any more) together in 0.10.15. Summary: [`docs/handoff/A2-extraction.md`](./docs/handoff/A2-extraction.md).
Next: the tools/list size review, then the MCP work.
Before that:
**[A1 — MCP server and server host](./docs/handoff/A1-mcp-and-server-host.md)**
(2026-09-27, released in 0.10.0): personal access tokens and OAuth for
claude.ai, the server-side command host with per-run revert and an audit
log, 44 server-backed commands, the MCP server at `/api/mcp`, playbooks, and
the `pnpm agent:eval` suite; and
**[A0 — foundations](./docs/handoff/A0-agentic-foundations.md)**
(2026-09-26, commit `9e0e853`, released in 0.10.0): the command registry,
runtime schemas, parity guards, and a round of editor undo and crop fixes.
Before that: the 0.9.x point releases (CHANGELOG), starting with
**[0.9.0 → 0.9.3 — production hardening](./docs/handoff/0.9.x-production-hardening.md)**
(2026-09-07 → 2026-09-09), which fixed ten production defects that were
invisible in `pnpm dev`.
Feature milestones before that:
**[M28 — PowerPoint import & export](./docs/handoff/M28-pptx-import-export.md)** (2026-05-14) +
**[M29 — first-class TableObject](./docs/handoff/0.8.0-table-object.md)** (2026-05-18).

## Requirements

- Node.js >= 22.18 built with TypeScript support (`pnpm lint` needs Node's built-in type stripping; was >= 22 until 2026-09-28). Ubuntu 26.04's own `nodejs` 22.22.1 lacks it — see [SETUP.md](./SETUP.md) "Common first-run failures" (2026-09-29)
- pnpm 9.15.4 (`packageManager`)
- Docker (for local Postgres)
- just, lefthook, gitleaks (task runner and git hooks), python3 ≥ 3.9 (the Claude Code hooks and the docs check) — `just doctor` checks the whole toolchain

## Setup

See **[SETUP.md](./SETUP.md)** for the complete first-run guide — env vars, Docker
services, MinIO bucket, migrations, optional video pipeline, Google OIDC, and a
troubleshooting list for the failures that actually bite on a fresh machine.

TL;DR for an experienced setup:

```bash
just setup                             # dependencies, git hooks, toolchain check
scripts/secrets-decrypt.sh dev         # .env from the private overlay (or cp .env.example .env — see SETUP.md)
just services                          # Postgres, MinIO, imgproxy, Redis
just dev                               # web :5173, server :3001 (migrations apply on start)
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
  shared/       Shared types + zod runtime schemas
  slide-model/  Yjs bindings + object type registry
  animation/    JSON DSL + GSAP compiler
  commands/     Capability registry — every document write, for UI and agents (ADR 0010);
                playbooks/ = agent guidance served as MCP prompts + the `narrative` skill
  ui/           Reusable React components
infra/
  docker-compose.yml   Postgres (dev) — extended in M4/M10/M11
  scripts/             Deploy + backup scripts
tests/
  agent-eval/   `pnpm agent:eval` — headless Claude Code scenarios, graded from the document
  load/         Load / soak harness (`pnpm load:all`)
docs/
  adr/       Architecture Decision Records
  handoff/   Per-milestone handoff documents
  plans/     Multi-phase plans (agentic layer, pptx, tables)
  mcp.md     The MCP server: connecting, auth, OAuth, tools, confirmation
  capabilities.md   Generated list of agent-callable commands (`pnpm capabilities`)
```

See [BUILD_PLAN.md](./BUILD_PLAN.md) for the full milestone roadmap and stack decisions.

See [docs/agents.md](./docs/agents.md) for the AI agent workflow and ownership model.

## Development scripts

`just` lists every recipe; they wrap the pnpm scripts (SETUP.md →
Everyday development):

```bash
just dev          # web + server + video-worker
just check        # fast lane, ~1 min: formatting, types, lint, docs, unit tests
just test server  # one package's unit tests
just e2e          # Playwright against the dev stack
just ci           # check + integration + e2e
```

## Testing

Strategy + roadmap: **[docs/testing-strategy.md](./docs/testing-strategy.md)** —
read before adding a new test or chasing a failing one. The short version:

- **Pure logic = unit tests** (`packages/slide-model`, `packages/animation`,
  `packages/commands`, `apps/server`)
- **User-visible behaviour = Playwright e2e** (`apps/web/e2e/`) — anything
  that depends on focus, keyboard scope, drag/drop, multi-window sync,
  or real rendering
- **No component tests for "does this label render"** — those break on
  every UI iteration without catching real bugs. We deleted ~80 of them.

```bash
pnpm test                                       # unit tests (3,637 pass, 30 skipped, 245 files, 2026-09-30)
pnpm --filter web test:e2e                      # 64 Playwright spec files (see caveat below)
pnpm --filter @narrative/server test:integration  # Drizzle stores + folder token / font reads against the local Postgres (6 files, 29 tests, 2026-09-30; not in `pnpm test`)
pnpm agent:eval                                 # 39 agent scenarios via headless Claude Code (costs usage; 1.62 USD for 13 of them on 2026-09-28, 0.91 USD for 7 on 2026-09-30)
pnpm size                                       # bundle-size budgets (per-chunk + total)
pnpm load:all                                   # load tests with regression tracking
pnpm lighthouse                                 # Core Web Vitals on the editor route
pnpm --filter @narrative/slide-model mutate     # Stryker mutation pilot (broken on vitest 4, 2026-09-26)
```

Coverage highlights:

- Property-based CRDT convergence (400 random op sequences per run)
- Server lifecycle/leak regression guard (50× open/close docs)
- Multi-client e2e collab (3 browser contexts converging through real Hocuspocus)
- Sampled-thumbnail visual regression (catches "wrong colour", "wrong layer order"
  without cross-platform pixel-diff fragility)
- Destructive-flow e2e (deck delete, share-link revoke + IDOR guard, folder cascade)
- Bundle budgets via size-limit (main app chunk ≤ 210 KB gzipped; the Tiptap
  chunk is 12.64 kB over its 120 KB budget as of 2026-09-26, so `pnpm size` fails)
- Agent parity guards in `packages/commands` and the server (every
  slide-model writer and every Fastify route claimed by a command, the
  known-missing list or a reasoned exclusion; every command example run as a
  contract test; the generated capability manifest must be current)
- MCP server over real HTTP with the SDK client, the OAuth flow and its
  failure paths, a `tools/list` size budget (177,000 bytes after A2.11,
  2026-09-30; 169,000 after A2.10, was 132,000 on 2026-09-28 and is raised
  per A2 step), and the agent eval suite's free replay subset (33 recorded
  scenarios, no model; was 11 at A1) inside `pnpm test` — see [`tests/agent-eval/README.md`](./tests/agent-eval/README.md)

> Run the suites through `just` (`just check`, `just e2e`, `just ci`): the
> recipes add what a machine needs — on Ubuntu 26.04, where Playwright ships
> no Chromium, `just e2e` drives the system Chrome with video off. See
> [SETUP.md](./SETUP.md) and [docs/testing-strategy.md](./docs/testing-strategy.md).

## Checks

There is **no CI**. GitHub Actions was removed on 2026-09-07 (commit
`573ba64`) after both workflows had been red since 2026-06-17 on a pnpm
version conflict; there is no `.github/` directory in the repo. `just ci` is
the CI, run locally; the pre-push hook runs `just check`, and
[`AGENTS.md`](./AGENTS.md) maps "files you touched" → "what else to run":

```bash
just check     # the baseline, always (the pre-push hook and Claude Code's Stop hook run it)
```

`just size`, `just load`, `just lighthouse`, `just eval` and `just mutate`
are deliberately not part of that baseline — they need a representative
machine (load, lighthouse), cost subscription usage (eval) or are known red
(AGENTS.md → When to run what has the current state).

## Agents (MCP)

Narrative runs no model. Claude Code and claude.ai drive it through an MCP
server that is part of the API — `https://<domain>/api/mcp` in production,
`http://localhost:3001/mcp` in dev — so the model, its key and its bill stay
in the user's own Claude client
([ADR 0011](./docs/adr/0011-agent-execution-over-mcp.md)).

- **Tools** are generated from the command registry (121 commands on `main`
  after A2.11, 2026-09-30 — 117 in 0.10.12, 114 in 0.10.11, 94 in 0.10.0; list in
  [`docs/capabilities.md`](./docs/capabilities.md)); every
  call runs on the server with the calling user's role, as one change, logged
  to a run the user can revert from the editor's Agent activity popover.
- **Claude Code**: account menu → **Access tokens** → a token with the `mcp`
  scope, then `claude mcp add --transport http narrative https://<domain>/api/mcp --header "Authorization: Bearer <token>"`.
  Without the header it signs in with OAuth instead.
- **claude.ai**: Settings → Connectors → Add custom connector →
  `https://<domain>/api/mcp`; sign in with Google and approve on Narrative's
  consent page. Disconnect under Access tokens → Connected apps.
- Irreversible actions (sharing, invitations, deletes, moving a deck) and URL
  downloads are confirmed by the user — in the client, or on a Narrative
  confirmation page — never by the model.

Full reference (auth, OAuth, rate limits, confirmation, awareness privacy):
[`docs/mcp.md`](./docs/mcp.md). Local setup: [`SETUP.md`](./SETUP.md) §9.
Production env and the Caddy routes it needs:
[`docs/deploy.md`](./docs/deploy.md).

## Authentication

### Architecture

Identity is provided by **Google OIDC directly** (no self-hosted IdP container).
The web client runs the standard PKCE authorization-code flow against
`https://accounts.google.com`; the server validates the resulting **ID token**
(a JWT) against Google's JWKS at `https://www.googleapis.com/oauth2/v3/certs`.

```
User → Narrative web (http://localhost:5173)
      → redirects to https://accounts.google.com/.../authorize (PKCE)
      → user logs in with Google account
      → Google redirects back with authorization code
      → web exchanges code for { id_token, access_token } (PKCE — no client secret)
      → web stores id_token, sends as Bearer on every API/WS request
      → server verifies id_token signature against Google JWKS
      → server checks `iss` = https://accounts.google.com (or accounts.google.com)
      → server checks `aud` = OIDC_CLIENT_ID
      → server checks email against OIDC_ALLOWED_EMAILS / OIDC_ALLOWED_DOMAIN
```

> Note: we send the **ID token**, not the access token, because Google's
> access tokens are opaque strings — only the ID token is a JWT the server
> can verify offline.

Access control: since Google itself authenticates anyone with a Google account,
the deployment is gated by an **email allowlist** enforced server-side
(`OIDC_ALLOWED_EMAILS` exact match and/or `OIDC_ALLOWED_DOMAIN` workspace
domain). At least one MUST be set in production — the server logs a loud
warning at boot if both are empty.

### First-run setup

1. **Create the OAuth client** at <https://console.cloud.google.com> →
   APIs & Services → Credentials → **Create OAuth 2.0 Client ID** → Web application.
   - Authorized JavaScript origins: `http://localhost:5173` (dev) and `https://YOUR_DOMAIN` (prod)
   - Authorized redirect URIs: `http://localhost:5173/auth/callback` and `https://YOUR_DOMAIN/auth/callback`
2. **Copy the Client ID** (ends in `.apps.googleusercontent.com`) into `.env` /
   `infra/.env.prod`:
   - `OIDC_CLIENT_ID` (server-side, validates `aud` claim)
   - `VITE_OIDC_CLIENT_ID` (web bundle, used by oidc-client-ts)
3. **Set the allowlist** (at least one):
   ```
   OIDC_ALLOWED_EMAILS=you@example.com,colleague@example.com
   # or
   OIDC_ALLOWED_DOMAIN=example.com
   ```
4. **For dev**, you can keep `BYPASS_AUTH=true` and skip steps 1–3 — the server
   synthesises a `dev-user`. Set `BYPASS_AUTH=false` only when you need to
   exercise the real OIDC flow.

### DNS + ingress (production)

Public ingress is via **Cloudflare Tunnel** (`cloudflared` container), not a
port-forward + Let's Encrypt. Cloudflare terminates TLS at the edge and proxies
plain HTTP to `caddy:80` over an outbound-only tunnel.

Setup (one time):

1. <https://one.dash.cloudflare.com> → Networks → Tunnels → Create a tunnel
2. Name it (e.g. `narrative`), copy the install token (long `eyJ…` string) into
   `CLOUDFLARE_TUNNEL_TOKEN` in `infra/.env.prod`
3. In the tunnel's **Public Hostname** tab add a route:
   - Subdomain: `narrative` (or whatever)
   - Domain: your zone
   - Service: `http://caddy:80`
4. (Optional) repeat for `minio.YOURDOMAIN` if you want the MinIO console online.

DNS records are created automatically by Cloudflare. No router port-forward
needed; the VM only needs outbound 443 to Cloudflare.

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

- `media-redis` — dedicated Redis instance for the BullMQ queue (port 6380 by default).
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

Historical: in phase 1a the `transcodeProcessor` in `apps/video-worker/src/processors/transcode.ts` was a stub that threw immediately. The real ffmpeg pipeline landed in M12 phase 2 ([handoff](./docs/handoff/M12-phase2-video-pipeline.md)); the section is kept for the env reference above. (Corrected 2026-09-26 — this README still called it a stub.)

### Known TODOs (phase 2+)

- ~~Media agent implements real ffmpeg transcoding in `transcodeProcessor`~~ — done (M12 phase 2)
- ~~Server endpoint to enqueue jobs after tus upload completes~~ — done (`apps/server/src/media/tus.ts` → `enqueueVideoTranscode`)
- ~~`GET /api/media/:id/video-info` returning HLS manifest URL for client playback~~ — done (`apps/server/src/media/routes.ts`)
- Audio-only fallback track (M14+)
- HLS variant selection UI in the player
- DRM / signed HLS URLs (M29+)
- Resource limits on video-worker (M29 — profile first)

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

> **Security note:** Auth is Google OIDC (ID-token validation against Google's JWKS, gated by an email/domain allowlist — see `OIDC_ALLOWED_EMAILS` / `OIDC_ALLOWED_DOMAIN`). The system can be exposed to the public internet only with the allowlist set; otherwise _any_ Google account can sign in. When `BYPASS_AUTH=true` (dev only), keep server ports bound to `127.0.0.1` and block external access at the firewall.

### Architecture

Single domain, Caddy as reverse proxy with automatic TLS:

```
https://DOMAIN/          → React SPA (static files, Caddy file_server)
https://DOMAIN/api/*     → Fastify HTTP API (port 3001; Caddy strips /api) — incl. the MCP server at /api/mcp
https://DOMAIN/.well-known/oauth-{authorization-server,protected-resource}[/*]
                         → Fastify HTTP API, path NOT stripped (OAuth discovery for MCP clients)
wss://DOMAIN/ws          → Hocuspocus WebSocket (port 3002)
```

(Production actually terminates TLS at Cloudflare and reaches Caddy through a
tunnel on plain HTTP — [`docs/deploy.md`](./docs/deploy.md) "Production
topology".)

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

**Build the images locally and push to GHCR** (the VM does not build from
source — see _Why local builds_ below):

```bash
# on your build machine, with Docker running and infra/.env.prod present
echo "$GHCR_PAT" | docker login ghcr.io -u petronijus --password-stdin
infra/scripts/build-push.sh           # builds server + video-worker + web, pushes to GHCR
```

**On the target server** (pulls the prebuilt images):

```bash
cd /opt/narrative/infra
cp .env.prod.example .env.prod
# Edit .env.prod — fill DOMAIN, POSTGRES_PASSWORD, PG_DATA_PATH
docker login ghcr.io -u petronijus       # one-time (GHCR packages are private)

chmod +x scripts/deploy.sh scripts/backup.sh
NARRATIVE_TAG=latest ./scripts/deploy.sh prod
```

The deploy script:

1. Takes a ZFS snapshot (if `ZFS_DATASET` is set)
2. **Pulls** the prebuilt images from GHCR (`narrative-{server,video-worker,web}`)
3. Extracts the React SPA static files (from the pulled `narrative-web` image) into the Caddy volume
4. Runs DB migrations (Drizzle)
5. Starts all services with `docker compose up -d`
6. Runs health checks

#### Why local builds (not on the VM)

Images are three single-purpose containers — **server** (API + Hocuspocus),
**video-worker** (background video rendering), and **web** (static SPA, served
by Caddy). They are built on a dev machine via `infra/scripts/build-push.sh` and
pushed to **private GHCR packages**; the VM only pulls. This keeps build load off
the production host and removes the need for a source checkout / `git pull` there.
The images are private (the source is published under a noncommercial license).

#### Release & version discipline

Since 0.9.0 one identifier flows through the whole pipeline unchanged:

```
package.json version  ==  git tag (vX.Y.Z)  ==  GHCR image tag  ==  /version.json
```

- Check what is deployed: `curl -s https://YOUR_DOMAIN/version.json`
  → e.g. `{"version":"v0.9.3+00454ec"}`.
- Roll back by tag: `NARRATIVE_TAG=v0.9.2 ./infra/scripts/deploy.sh prod`
  (DB migrations are forward-only — that is the limit on how far back is safe).
- `index.html` is served `no-cache`, and the client-side version guard
  (`apps/web/src/state/versionGuard.ts`) reloads a browser stuck on a stale
  document.
- **Config-only changes** (Caddyfile, compose) ship by rsync + redeploy without
  a version bump, so they do **not** move `/version.json`. Verify those against
  the served artifact — `curl -sI` the public URL — never against the file on
  disk: the Caddy container reads a bind-mounted **directory** precisely
  because a single-file mount kept serving a stale inode after rsync
  (see the 0.9.4 CHANGELOG section).

Rationale: [ADR 0008](./docs/adr/0008-release-and-image-tag-discipline.md).
The production CSP is a hard constraint on the renderer, not a tunable —
[ADR 0007](./docs/adr/0007-csp-as-a-renderer-constraint.md).

### DB migrations

Migrations run automatically during deploy. To run manually:

```bash
cd infra
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.prod run --rm --entrypoint "" server \
  node apps/server/dist/apps/server/src/db/migrate.js
```

(The compiled server mirrors the repo layout under `dist/` — was documented
here as `dist/db/migrate.js`, which does not exist in the image; corrected
2026-09-27 to match `infra/scripts/deploy.sh`.)

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

## Secrets

Both the dev `.env` and the prod `infra/.env.prod` are gitignored and kept
SOPS-encrypted in the private overlay so they sync across machines without
plaintext in git:

| Target | Encrypted (overlay)            | Materializes to     |
| ------ | ------------------------------ | ------------------- |
| `dev`  | `private/config/env.sops`      | `./.env`            |
| `prod` | `private/config/env.prod.sops` | `./infra/.env.prod` |

With the overlay cloned into `./private` and the 1Password CLI signed in:

```bash
./scripts/secrets-decrypt.sh [dev|prod]   # materialize the env file (default dev)
./scripts/secrets-edit.sh    [dev|prod]   # decrypt → $EDITOR → re-encrypt in place
```

The age private key is fetched from 1Password at runtime (never written to
disk); the public recipient lives in the overlay's `.sops.yaml`. After editing,
commit the updated `*.sops` in the **private overlay** repo. Prereqs:
`brew install sops age`.

**Prod note:** `secrets-decrypt.sh prod` writes `infra/.env.prod` _locally_ — it
still has to reach the VM. After changing a prod secret:

```bash
./scripts/secrets-edit.sh prod                  # edit + re-encrypt; commit in ./private
./scripts/secrets-decrypt.sh prod               # materialize infra/.env.prod locally
scp infra/.env.prod narrative:/opt/narrative/infra/.env.prod
ssh narrative 'cd /opt/narrative && ./infra/scripts/deploy.sh prod'
```

The agentic-layer release (A1) adds one **required** prod secret,
`AGENT_PRINCIPAL_KEY_SECRET` (`openssl rand -base64 48`): without it in the
decrypted `infra/.env.prod`, Compose will not parse the prod file, so
`build-push.sh` fails before building (checklist:
[`docs/deploy.md`](./docs/deploy.md) "Releasing the agentic layer (A1)").

The encrypted `env.prod.sops` is the source of truth — ad-hoc edits made
directly on the VM (e.g. `USE_SHARED_TUNNEL=1`) should be folded back into it via
`secrets-edit.sh prod` so they aren't lost on a rebuild.

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE) — source-available for
**noncommercial** use (personal, research, evaluation). Commercial use is not
granted. See [`NOTICE`](./NOTICE), which also covers the GSAP dependency's
separate (non-open-source) license.
