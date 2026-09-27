# Narrative — Operations Runbook

Status: **M6 observability baseline + the 0.9.x production checks**. Full
runbook still lands with M30 (Prometheus/Grafana, alerting, restore drill).

Deploy procedure lives in [`deploy.md`](./deploy.md); this file is what to
look at when something is already running.

_(Rewritten in English 2026-09-09 — was Czech; the M29 `/metrics` TODO below is
resolved, and the production section is new.)_

---

## Production at a glance

Four checks answer "is the deployed thing the thing I think it is" (a fifth
once the agentic layer is released). Run them against the public URL — not
against the VM, and not against the repo.

```bash
# 1. Which version is live
curl -s https://narrative.bastla.com/version.json
# {"version":"v0.9.3+00454ec"}     ← matches a git tag + package.json version

# 2. The document must be revalidated on every load
curl -sI https://narrative.bastla.com | grep -i cache-control
# cache-control: no-cache

# 3. The live CSP (the Caddyfile on disk is NOT evidence — see below)
curl -sI https://narrative.bastla.com | grep -i content-security-policy

# 4. API health
curl -s https://narrative.bastla.com/api/health
# {"status":"ok"}

# 5. (from the agentic A1 release on) OAuth discovery for MCP clients — JSON,
#    not the SPA's HTML; HTML means claude.ai connectors cannot sign in
curl -s https://narrative.bastla.com/.well-known/oauth-authorization-server/api | head -c 80
# {"issuer":"https://narrative.bastla.com/api", …
```

On the VM (`ssh narrative`, user `petr`, only reachable via the `pve` jump
host):

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
docker ps --format "{{.Names}}|{{.Image}}"     # image tags must match the release
```

### Version discipline

`package.json` version = git tag = GHCR image tag = `/version.json`. A
divergence means someone bypassed the pipeline by hand — treat it as a bug, not
a nuance. Rationale:
[ADR 0008](./adr/0008-release-and-image-tag-discipline.md).

Config-only changes (Caddyfile, compose) ship without a version bump and do
**not** move `/version.json`. Verify those against the served header or the
running mount.

### 🚨 The Caddy config trap

Compose mounts the **directory** `./caddy:/etc/caddy:ro`, not the Caddyfile.
A single-file bind mount is pinned to the file's inode, and the deploy syncs
config in with rsync, which replaces files rather than rewriting them in place
— so the container kept reading the old, unlinked inode while the host file,
`caddy validate` and `caddy reload` all looked correct. That cost a full
debugging round on 2026-09-09 (fixed in `e6b4042`). Do not convert the mount
back to a single file, and always confirm a config change with `curl -sI`
against the public URL.

### The CSP is a renderer constraint

The SPA policy is deliberately same-origin and tight. Four separate rendering
failures in 0.9.x came from it, and **a CSP denial is silent to the
application**: a blocked worker leaves a promise that never settles, a blocked
font leaves a plausible wrong-looking result. If the canvas misbehaves in
production and not in dev, read the header first.
[ADR 0007](./adr/0007-csp-as-a-renderer-constraint.md) explains which
directives exist for which Pixi behaviour and why `script-src` never gets
`'unsafe-eval'` or `'unsafe-inline'`.

Known, deliberate noise: Cloudflare injects an inline script plus
`static.cloudflareinsights.com/beacon.min.js` downstream of Caddy. The
`index.html` on disk carries neither, and the CSP blocks both. Silence it by
turning Web Analytics off in the Cloudflare dashboard — not by widening
`script-src`.

---

## Health checks

```bash
# API server
curl http://localhost:3001/health
# → { "status": "ok" }

# Prometheus metrics (token-gated — see below)
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3001/metrics
```

In production replace `localhost:3001` with the domain or the internal address.

---

## Metrics (`/metrics`)

The endpoint returns Prometheus text format (version 0.0.4).

| Metric                             | Type    | Meaning                                                   |
| ---------------------------------- | ------- | --------------------------------------------------------- |
| `narrative_ws_connections`         | gauge   | Currently active Hocuspocus WebSocket connections         |
| `narrative_updates_ingested_total` | counter | Yjs document flush operations (per flush, not per update) |
| `narrative_updates_bytes_total`    | counter | Bytes of Yjs updates written to Postgres                  |

**Reading them**:

- `narrative_ws_connections` > 0 = clients connected; 0 = no active editor.
- `narrative_updates_ingested_total` rises with every save flush (debounced 2 s
  after the last Yjs update by default).
- A high `narrative_updates_bytes_total` means large documents or heavy editing.

**Access control** (was a TODO for M29; **done** in the 2026-06-12 audit,
commit `c45faf4`): `/metrics` leaks connection counts and document sizes, so in
production it is gated by `METRICS_TOKEN` — scrape with
`Authorization: Bearer <token>`. If `NODE_ENV=production` and `METRICS_TOKEN`
is unset or empty, the endpoint is **not registered at all**: the server keeps
running and metrics are simply unreachable until a token is configured. See
`apps/server/src/metrics/index.ts`.

---

## Sentry

Error tracking — dev-gated (no init without a DSN).

| Env var              | Meaning                                                     |
| -------------------- | ----------------------------------------------------------- |
| `SENTRY_DSN`         | Server DSN — empty means Sentry never initialises           |
| `VITE_SENTRY_DSN`    | Client (browser) DSN — empty means Sentry never initialises |
| `VITE_BUILD_VERSION` | Release string (tag + short sha); default `dev`             |

**Without a DSN**: silent, no overhead, no errors. Dev-friendly.

`VITE_BUILD_VERSION` is not only a Sentry release marker — since 0.9.3 it is
the value the version guard compares against `/version.json`, and
`build-push.sh` sets it explicitly because a Docker build context has no
`.git`. Do not remove it thinking it is Sentry-only.

**Production setup**:

1. Create a project in Sentry (sentry.io or self-hosted).
2. Copy the DSN into `.env` (server) and pass it as a Vite build arg (client).
3. Restart the server / rebuild the frontend.

---

## Synthetic load harness

For stress-testing the server locally:

```bash
# Start the server (dev or a prod build)
pnpm --filter server dev

# All load scenarios
pnpm load:all

# Individual scenarios
pnpm load:hotedit    # 5 clients × 200 mutations
pnpm load:awareness  # 15 clients × 30 Hz × 30 s
pnpm load:growth     # 1000 objects, initial sync
```

**Expected numbers** (from spike B, 2026-04-19, localhost):

- Hot-edit observer latency, avg: ~0.02 ms (threshold: < 20 ms)
- Awareness latency, avg: ~4.5 ms (threshold: < 100 ms)
- Doc sync, 1000 objects: ~18 ms (threshold: < 3000 ms)
- Encoded doc size: ~228 KB (threshold: < 1 MB)

`tests/load/runAll.mjs` also compares against `tests/load/baselines.json` and
warns on > 20 % drift. Breakdown: `docs/handoff/spike-b-yjs-scale.md`.

---

## Client-side performance overlay (DEV only)

In a dev build press **Ctrl+Shift+M** in the editor for an overlay with:

- FPS (rolling 1 s average)
- Frame time (avg, p99)
- WebSocket connection status

It does not appear in a production build (`import.meta.env.DEV === false`).

---

## Docker Compose

```bash
# Dev
docker compose up -d

# Prod — three overlays; the third is shared-tunnel mode (USE_SHARED_TUNNEL=1)
docker compose -f infra/docker-compose.yml \
               -f infra/docker-compose.prod.yml \
               -f infra/docker-compose.prod.shared-tunnel.yml up -d
```

See `infra/docker-compose.yml` for the details.

---

## Postgres

```bash
# Dev migrations (run automatically when the server starts in dev mode)
pnpm --filter server db:migrate

# Manual migration (prod) — normally run by deploy.sh. The VM has no pnpm and
# no source checkout; run the compiled migrator in the server image:
cd /opt/narrative/infra && docker compose -f docker-compose.yml \
  -f docker-compose.prod.yml -f docker-compose.prod.shared-tunnel.yml \
  --env-file .env.prod run --rm --entrypoint "" server \
  node apps/server/dist/apps/server/src/db/migrate.js
```

(Was documented here as `pnpm --filter server db:migrate` for prod too, which
cannot work on the VM; corrected 2026-09-27 to what `infra/scripts/deploy.sh`
runs.)

Migrations are forward-only. To undo one, write a new migration; do not drop
tables by hand.

Backups: `infra/scripts/backup.sh` (gzip'd `pg_dump`, retention `RETAIN_DAYS`,
cron'd daily at 03:00 on the VM).

---

## Agents (MCP) — operating notes

From the agentic-layer A1 release on (unreleased as of 2026-09-27).
Reference: [`mcp.md`](./mcp.md); env vars, Caddy routes, kill switch and
retention: [`deploy.md`](./deploy.md).

- **A server restart drops agent state that lives in memory**: open MCP
  sessions (clients re-initialise on their own), pending out-of-band
  confirmations (the agent must ask again), and the per-run undo history —
  **runs made before the restart can no longer be reverted** (ADR 0011,
  "Revert works only while the document is loaded"). Restarting is still the
  way to cut an MCP session off immediately after `revokeUserAccess`.
- **Cutting someone off**: `revokeUserAccess` (deploy.md "Revoking a user");
  exit code 2 means they could still sign in again.
- **Log events worth alerting on** once M30 lands:
  `event: "mcp_oauth_refresh_replay"` (a refresh token was reused; the
  connection is flagged under Connected apps, and revoked unless it was the
  client racing itself).
- **Housekeeping runs in-process** (nothing to schedule): agent runs/ops
  after 90 days, PPTX exports after a day, expired OAuth tokens and
  authorisations hourly.
- **Rate limits are in process memory** and reset on restart; claude.ai
  traffic arrives from Anthropic's egress `160.79.104.0/21`, so per-IP limits
  are shared by all claude.ai users (agent bearers are counted per token).

---

## Incident response (still TODO for M30)

M30 adds:

- Prometheus + Grafana dashboards
- Alerting rules (connections, error rate, latency)
- PagerDuty / webhook integration
- Runbooks for common incidents (DB down, OOM, WS storm)
- A backup **restore** drill procedure — the backups are not proven until one
  has been restored
