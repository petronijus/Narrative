# Local development setup

Single source of truth for getting the editor running on a fresh machine. If
the steps here don't end with a working editor on `http://localhost:5173`,
something's broken — file an issue, don't paper over it.

## Prerequisites

- **Node.js ≥ 22.18** (`node -v`; `engines` in `package.json` since A2.1, 2026-09-28 — `pnpm lint` loads the TypeScript parity table through Node's built-in type stripping, on by default from 22.18; was ≥ 22)
- **pnpm ≥ 9** — recommended via Corepack: `corepack enable && corepack prepare pnpm@latest --activate`
- **Docker** with the Compose plugin (`docker compose version`)
- **Linux only**: file-watcher headroom for the dev stack
  ```bash
  sudo sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=512
  ```
  Without this, `tsx watch` and Vite throw `ENOSPC` on startup. To persist
  across reboots, drop a file in `/etc/sysctl.d/`.

## 1. Clone & install

```bash
git clone https://github.com/petronijus/Narrative.git
cd Narrative
pnpm install
```

## 2. Generate secrets

```bash
# 64 hex chars each — required by imgproxy URL signing.
openssl rand -hex 32   # → IMGPROXY_KEY
openssl rand -hex 32   # → IMGPROXY_SALT
```

Identity is Google OIDC — no IdP secret to generate. For dev you can leave
`OIDC_*` vars at the example values and just set `BYPASS_AUTH=true`.

## 3. Create `.env`

```bash
cp .env.example .env
```

Open `.env` and at minimum:

| Variable                           | What to do                                         |
| ---------------------------------- | -------------------------------------------------- |
| `POSTGRES_PASSWORD`                | Pick any; copy the same value into `POSTGRES_URL`. |
| `MINIO_ROOT_USER` / `_PASSWORD`    | Any 8+ char value (used by Docker + the server).   |
| `IMGPROXY_KEY`, `IMGPROXY_SALT`    | Paste the two 64-hex values from step 2.           |
| `BYPASS_AUTH` / `VITE_BYPASS_AUTH` | Set both to `true` — skip Google OIDC for dev.     |

Leave everything else at the defaults. In particular:

- `IMGPROXY_ENDPOINT=http://localhost:5173/imgproxy` — routes signed URLs through
  Vite's dev proxy so the browser fetches them same-origin (imgproxy v3.27
  doesn't honour its own CORS env).
- `MINIO_ENDPOINT=http://127.0.0.1:9100` — server reads MinIO via the host port.
- `MEDIA_REDIS_URL=redis://127.0.0.1:6380` — only needed if you start the video pipeline (optional, see step 7).

## 4. Boot the storage / image stack

```bash
cd infra
docker compose --env-file ../.env up -d postgres minio minio-init imgproxy
cd ..
```

What this brings up:

- `postgres` — main DB.
- `minio` — S3-compatible object store on `:9100` (API) and `:9101` (console).
- `minio-init` — one-shot job that creates the `narrative-media` bucket. Should exit `0`. Verify: `docker compose -f infra/docker-compose.yml --env-file .env logs minio-init` — last line should say `Bucket ready: narrative-media`.
- `imgproxy` — image transformer on `:8080`.

## 5. Run DB migrations

```bash
pnpm --filter server db:migrate
```

Expected: `Migrations applied successfully`. Re-runnable; safe.

## 6. Start the dev stack

```bash
pnpm dev
```

This boots two processes in parallel:

- `apps/web` — Vite on `http://localhost:5173`
- `apps/server` — Fastify (REST + Hocuspocus WebSocket) on `:3001` / `:3002`

Verify:

```bash
curl http://localhost:3001/health
# {"status":"ok"}
```

Open `http://localhost:5173`. With `BYPASS_AUTH=true` you land on the deck list as `dev-user` — no login required.

## 7. Optional: video pipeline

Only needed if you upload videos.

```bash
cd infra
docker compose --env-file ../.env up -d media-redis video-worker
```

`video-worker` is a stub on this branch — see `apps/video-worker/src/processors/transcode.ts`. Running it just verifies the queue connects.

## 8. Optional: real Google OIDC sign-in (skip for normal dev)

With `BYPASS_AUTH=true` the editor synthesises a `dev-user` principal and skips
JWT validation entirely — that's the recommended dev setup. Only do the steps
below if you're actively testing the real OIDC flow.

1. https://console.cloud.google.com → APIs & Services → Credentials → Create OAuth 2.0 Client ID → Web app
2. Authorized redirect URI: `http://localhost:5173/auth/callback`
3. Copy the Client ID into both `OIDC_CLIENT_ID` and `VITE_OIDC_CLIENT_ID` in `.env`
4. Set `OIDC_ALLOWED_EMAILS=your.email@gmail.com` (or `OIDC_ALLOWED_DOMAIN=yourdomain.com`)
5. Set `BYPASS_AUTH=false` and `VITE_BYPASS_AUTH=false`
6. Restart `pnpm dev`

## 9. Optional: drive Narrative from Claude Code (MCP)

The MCP server is part of the API: `http://localhost:3001/mcp` in dev. Nothing
has to be configured for local use — `PUBLIC_API_URL` defaults to
`http://localhost:<API_PORT>` (the MCP resource every OAuth token is bound to is
`<PUBLIC_API_URL>/mcp`), and the OAuth redirect allowlist already holds Claude
Code's loopback callbacks and the claude.ai callback. Set
`MCP_OAUTH_REDIRECT_URIS` only for another MCP client with its own callback
(https, or http on `localhost` / `127.0.0.1`, any port).

1. Account menu → **Access tokens** → create a token with the `mcp` scope.
2. In a scratch directory:
   `claude mcp add --transport http narrative-local http://localhost:3001/mcp --header "Authorization: Bearer <token>" --scope local`
3. `claude -p "List my 5 most recently updated decks with narrative-local" --allowedTools "mcp__narrative-local__*"`

Without `--header`, Claude Code signs in through Narrative's OAuth flow instead
(its client metadata document, a loopback callback, then the consent page).
Details: [`docs/mcp.md`](./docs/mcp.md).

Dev notes:

- `AGENT_PRINCIPAL_KEY_SECRET` is optional in dev (a built-in dev-only key is
  used); production refuses to start without it.
- Under `BYPASS_AUTH=true` the Access tokens page works as the dev user; that
  is also what `pnpm agent:eval` relies on to mint its own tokens
  ([`tests/agent-eval/README.md`](./tests/agent-eval/README.md)).
- A confirmation link (`/confirm/<id>`, for deletes, sharing and URL
  downloads from a client that cannot ask) opens in the web app on :5173.
- `claude -p` runs headless and dismisses every confirmation question, so an
  irreversible call from it always goes through that page.

## Verifying everything works

| Check                                                                                                      | Pass                           |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `curl http://localhost:3001/health`                                                                        | `{"status":"ok"}`              |
| `curl -sI http://localhost:5173`                                                                           | `HTTP/1.1 200 OK`              |
| Open a deck → drag-drop a JPG onto the canvas                                                              | Image renders (not a gray box) |
| Refresh editor                                                                                             | Image still there              |
| Open home in incognito                                                                                     | Deck thumbnails visible        |
| Inspector → Identity → set the same Name on objects across two slides → set slide transition to Magic Move | Objects animate between slides |

## Common first-run failures

- **`ENOSPC: System limit for number of file watchers reached`** — Linux only. See prerequisites; raise inotify limits.
- **Server won't start, `IMGPROXY_KEY env required`** — Run `openssl rand -hex 32` twice and put the two values in `.env`. Both must be 64 hex characters.
- **`Bucket ready` never logs** — `minio` container failed health check. `docker compose logs minio` — usually `MINIO_ROOT_PASSWORD` < 8 chars.
- **Image upload renders gray** — `IMGPROXY_ENDPOINT` is still pointing at `127.0.0.1:8080` direct. Set it to `http://localhost:5173/imgproxy` in `.env` and restart `pnpm dev`.
- **`/decks` returns empty in incognito** — `BYPASS_AUTH=true` returns dev-user-owned decks only; create one from the home page first.
- **Server, web or tests fail to resolve a package right after a `git pull`** — the range added a workspace package or a dependency (agentic-layer A0 added `packages/commands` and `zod`; A1 added `@modelcontextprotocol/sdk`, `@fastify/rate-limit` and `yaml`, and made the server depend on `@narrative/commands`; a 0.9.x range added `sharp`, which killed the dev server until installed). Run `pnpm install`, then restart `pnpm dev`. New migrations (A1: `0016`–`0023`) apply on the next dev server start.
- **Vite serves stale code after a `git pull`** — `touch` the affected file, or stop+start `pnpm dev`. Vite occasionally caches transformed modules across hard reloads.
- **Editor logs `Hocuspocus: authentication token required`** — `VITE_BYPASS_AUTH` differs from `BYPASS_AUTH`. Set both to the same value.
- **Pre-commit hooks fail with permission errors** — you ran `pnpm install` as root. Re-clone, install as a normal user.
- **`npx playwright install` fails on Ubuntu 26.04** — `ERROR: Playwright does not support chromium on ubuntu26.04-x64` (same for the ffmpeg download that video capture needs). Playwright ships no managed build for this OS release yet, so a plain `pnpm --filter web test:e2e` fails. `apps/web/playwright.config.ts` already has the escape hatch — install Google Chrome and run:
  ```bash
  PLAYWRIGHT_USE_SYSTEM_CHROME=1 PLAYWRIGHT_NO_VIDEO=1 pnpm --filter web test:e2e
  # or: PLAYWRIGHT_CHROME_EXECUTABLE=/usr/bin/google-chrome PLAYWRIGHT_NO_VIDEO=1 …
  ```
  Verified on `petronijus-PC`, Ubuntu 26.04.1 LTS, 2026-09-09.

## Dev is not production

Nine of the ten defects fixed between 2026-09-07 and 2026-09-09 were invisible
in `pnpm dev`, because four things exist only in production:

| Only in prod      | Consequence                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| Cloudflare Tunnel | re-frames bodyless POSTs as chunked; terminates TLS, so the origin sees plain HTTP                         |
| Caddy             | rewrites `Host`, strips `/api` via `handle_path`, overwrites `X-Forwarded-Proto`                           |
| The CSP           | Vite's dev server sends none at all — Pixi's eval, worker, font and probe paths are unexercised locally    |
| The prod build    | Lightning CSS minification, and browser caching of a document the dev server never sends cache headers for |

If a change touches uploads, the renderer's asset/font/worker paths, or
anything served by Caddy, it is not verified until it has been checked on the
deployed instance. Details and the four failure classes:
[`docs/handoff/0.9.x-production-hardening.md`](./docs/handoff/0.9.x-production-hardening.md).

## Ports used in dev

| Port | Service                            |
| ---- | ---------------------------------- |
| 5173 | Vite (web)                         |
| 3001 | Fastify HTTP API                   |
| 3002 | Hocuspocus WebSocket               |
| 5432 | Postgres                           |
| 8080 | imgproxy (proxied via Vite in dev) |
| 9100 | MinIO S3 API                       |
| 9101 | MinIO console                      |
| 6380 | media-redis (BullMQ queue)         |

## Tearing it down

```bash
cd infra
docker compose --env-file ../.env down            # keep data
docker compose --env-file ../.env down -v         # nuke volumes (DB + MinIO data gone)
```
