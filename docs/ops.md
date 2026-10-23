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
# {"version":"v0.9.3+c4305b8"}     ← matches a git tag + package.json version

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
debugging round on 2026-09-09 (fixed in `8933119`). Do not convert the mount
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

In production `/health` answers at `https://<domain>/health` too; `/metrics`
does not — it is read on the VM (below).

---

## Metrics (`/metrics`)

The endpoint returns Prometheus text format (version 0.0.4).

| Metric                                         | Type    | Meaning                                                                     |
| ---------------------------------------------- | ------- | --------------------------------------------------------------------------- |
| `narrative_ws_connections`                     | gauge   | Currently active Hocuspocus WebSocket connections                           |
| `narrative_updates_ingested_total`             | counter | Yjs document flush operations (per flush, not per update)                   |
| `narrative_updates_bytes_total`                | counter | Bytes of Yjs updates written to Postgres                                    |
| `narrative_media_refusals_total{route,reason}` | counter | Media reads and deletes refused as unknown, by `route` and `reason` (below) |

**Reading them**:

- `narrative_ws_connections` > 0 = clients connected; 0 = no active editor.
- `narrative_updates_ingested_total` rises with every save flush (debounced 2 s
  after the last Yjs update by default).
- A high `narrative_updates_bytes_total` means large documents or heavy editing.
- `narrative_media_refusals_total` counts the media reads and deletes that
  answer an asset the caller may not have with the same 404 as an unknown id,
  by `route` — `url` (`GET /api/media/:id/url`, `media.url`), `video_info`
  (`/video-info`, `media.status`), `font_url` (`/font-url`, `media.fontUrl`),
  `delete` (`DELETE /api/media/:id`, `media.delete`) — and `reason`:
  `unknown`, `wrong_kind` (an image read of a video or font), `not_shown`
  (not the named deck's, master's or folder's), `legacy` (a font row from
  before folder fonts), `forbidden`. Whether an asset exists is not told to
  someone who may not read it; only this counter and the server log line
  `media refused` (`mediaRefusal: { route, reason }`) tell a forbidden asset
  from an unknown one. A rising `forbidden` is someone asking for assets of
  decks they cannot open. (A malformed `share_token` never gets this far:
  401 before any lookup.)

### Client session metrics (performance plan G4)

What real sessions measure in the browser, sampled: every page session (a
share of them, `VITE_CLIENT_METRICS_SAMPLE_RATE` at build time, default 1;
0 turns it off) sends one report when the page is first hidden
(`apps/web/src/observability/sessionMetrics.ts`) to
`POST /api/client-metrics` (`apps/server/src/routes/clientMetrics.ts`). A
report carries durations and counts only — no deck, user, URL or content —
and a coarse route kind (`editor`, `present`, `home`, `other`). The render
page, share-link visitors, the sign-in pages and automated browsers (the e2e
suite, the perf harness: `navigator.webdriver`) never report. The route takes
a signed-in session only (no token: not an agent capability), from the web
app's origin, 30 reports per user per minute. Each report carries a random
id per page session (never stored or logged); an id among the last 10,000
seen is a repeat and counted nowhere, so one page session counts once.

**The numbers are client-asserted.** Any signed-in user can send made-up
reports within the schema's bounds and the rate limit: read them as trends
across many sessions, never as an alerting signal or a per-user fact.

Each report becomes histograms on `/metrics` (in memory: a restart starts
them from zero) and one log line of the server, `client session metrics`
(kept as long as the container's logs). Production has `/metrics` from
the performance-round release on (`METRICS_TOKEN` in `infra/.env.prod`;
before it the endpoint was not registered and the log lines were the only
source — see "Access control" below).

| Metric (`narrative_client_…`, labels `route`, deck ones also `load`)    | What                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `reports_total`                                                         | reports received                                                        |
| `nav_ttfb_ms`, `nav_fcp_ms`, `nav_dom_content_loaded_ms`                | the document: first byte, first contentful paint, DOMContentLoaded      |
| `deck_ws_connected_ms`, `deck_ws_synced_ms`                             | deck open, from the deck route's mount: WebSocket connected, doc synced |
| `deck_pixi_ready_ms`, `deck_first_paint_ms`                             | deck open: renderer initialised, first canvas frame                     |
| `deck_long_task_ms`                                                     | long-task time between the deck route's mount and its first paint       |
| `session_long_tasks`, `session_long_task_ms`, `session_longest_task_ms` | long tasks (> 50 ms) of the whole session: count, total, the longest    |
| `inp_ms`                                                                | Interaction to Next Paint (the worst, or the p98 from 50 interactions)  |

`load="cold"` is the deck the page landed on (chunks, fonts and the
WebSocket all new), `warm` a deck opened later in the same page. Only the
last deck of a page is reported (`state/loadTimings.ts` keeps one). The
first paint can come before the sync (the canvas draws the empty slide first).

**Reading them** — `infra/scripts/client-metrics.py` prints count, p50, p75
and p95 per metric from either source:

```bash
# On the VM: every report in the server's logs (exact percentiles). `docker
# logs` needs no compose files (the prod overlay refuses to parse without
# --env-file .env.prod)
docker logs narrative-server 2>&1 | infra/scripts/client-metrics.py
# … since a deploy
docker logs narrative-server 2>&1 | infra/scripts/client-metrics.py --since 2026-10-21T08:00

# The histograms since the server started (interpolated in the buckets);
# the token expands inside the container, never on the VM's command line
docker exec narrative-server sh -c \
  'wget -qO- --header "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3001/metrics' \
  | infra/scripts/client-metrics.py
```

**Access control** (was a TODO for M29; **done** in the 2026-06-12 audit,
commit `b89796b`): `/metrics` leaks connection counts and document sizes, so in
production it is gated by `METRICS_TOKEN` — scrape with
`Authorization: Bearer <token>`. If `NODE_ENV=production` and `METRICS_TOKEN`
is unset or empty, the endpoint is **not registered at all**: the server keeps
running and metrics are simply unreachable until a token is configured. See
`apps/server/src/metrics/index.ts`.

**Production** (since the performance-round release, 2026-10):

- The token is `METRICS_TOKEN` in `infra/.env.prod` (64 hex characters,
  `openssl rand -hex 32`; source of truth the SOPS file
  `private/config/env.prod.sops`). It reaches the server only because
  `docker-compose.prod.yml` lists it in the server's `environment:` — that
  list, not `.env.prod`, is what the container gets. Rotate: a new value in
  both, then `docker compose … up -d server`.
- **Caddy never forwards `/api/metrics`** (it answers 404, Caddyfile
  "Prometheus metrics"): nothing outside the VM scrapes, so the public path
  is closed rather than left to the token alone. In the shared-tunnel
  topology the server publishes no host port either, so `curl
127.0.0.1:3001` on the VM does not reach it. Read it inside the container:

  ```bash
  docker exec narrative-server sh -c \
    'wget -qO- --header "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3001/metrics' | head
  ```

  (single quotes: `$METRICS_TOKEN` expands in the container's shell, so the
  token appears neither in the VM's process list nor in its shell history.)

- A Prometheus scraper (M30) belongs on the compose network and scrapes
  `http://server:3001/metrics` with the bearer token — not through Caddy.
- Check after a deploy: the server log has no `METRICS_TOKEN is unset`
  line, and `infra/scripts/boot-timing.py` says `/metrics registered: yes`.

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

`tests/load/runAll.mjs` also warns on > 20 % drift from a local
`baselines.json` next to it, when there is one (not committed; copy
`tests/load/baselines.example.json` after a clean run). Breakdown: `docs/handoff/spike-b-yjs-scale.md`.

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
