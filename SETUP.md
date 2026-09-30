# Local development setup

Single source of truth for getting the editor running on a fresh machine. If
the steps here don't end with a working editor on `http://localhost:5173`,
something's broken — file an issue, don't paper over it.

## Prerequisites

- **Node.js ≥ 22.18 built with TypeScript support** (`node -v`; `engines` in `package.json` since A2.1, 2026-09-28 — `pnpm lint` loads the TypeScript parity table through Node's built-in type stripping, on by default from 22.18; was ≥ 22). The version alone is not enough: check `node -p process.features.typescript` prints `strip` (or `transform`), not `false` — a distro build can leave type stripping out (see "`pnpm lint` fails with `ERR_UNKNOWN_FILE_EXTENSION`" below)
- **pnpm 9.15.4** (the `packageManager` pin) — via Corepack: `corepack enable && corepack prepare pnpm@9.15.4 --activate`
- **Docker** with the Compose plugin (`docker compose version`)
- **just, lefthook, gitleaks** — the task runner and the git hooks (macOS: `brew install just lefthook gitleaks`; Linux: the distro packages or the projects' release binaries). **xmllint** for the PPTX schema tests (`libxml2`). **python3 ≥ 3.9** for the Claude Code hooks and the docs check (standard library only). For secrets: **sops, age** and the 1Password CLI `op`.

`just doctor` checks all of this and prints the fix for anything missing.

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
git clone https://github.com/petronijus/Narrative-private.git private   # secrets overlay
just setup     # pnpm install, git hooks (lefthook), just doctor
```

The dev `.env` comes from the overlay: `scripts/secrets-decrypt.sh dev`
(SOPS, the age key from 1Password). Steps 2–3 below are for a machine
without access to it.

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
just services
```

What this brings up (`infra/docker-compose.yml`):

- `postgres` — main DB.
- `minio` — S3-compatible object store on `:9100` (API) and `:9101` (console).
- `minio-init` — one-shot job that creates the `narrative-media` bucket. Should exit `0`. Verify: `docker compose -f infra/docker-compose.yml --env-file .env logs minio-init` — last line should say `Bucket ready: narrative-media`.
- `imgproxy` — image transformer on `:8080`.
- `media-redis` — the video pipeline's queue on `:6380` (step 7).

## 5. DB migrations

The dev server applies pending migrations when it starts (step 6) with the
same migrator production runs (`pnpm --filter server db:migrate`,
`apps/server/src/db/runMigrations.ts`), so there is nothing to run, a fresh
database included. (Until 2026-09-30 the dev server used drizzle's own
migrator, which could not get a fresh database past the enum migrations.)

## 6. Start the dev stack

```bash
just dev          # or `just dev-lite` without the video worker
```

This boots three processes in parallel:

- `apps/web` — Vite on `http://localhost:5173`
- `apps/server` — Fastify (REST + Hocuspocus WebSocket) on `:3001` / `:3002`
- `apps/video-worker` — the transcoding worker (step 7)

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

## Everyday development

`just` lists every recipe; the ones you use daily:

| Recipe            | What it does                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just services`   | the docker services (Postgres, MinIO, imgproxy, Redis)                                                                                                                                                          |
| `just dev`        | web :5173 + server :3001/:3002 + video worker                                                                                                                                                                   |
| `just check`      | fast lane, ~1 min: formatting, types, lint, docs check, every unit test                                                                                                                                         |
| `just lint-docs`  | `tools/dev/docs-check.py`: every `just` recipe, relative link, heading anchor, repo path in inline code and `@import` the docs name exists; AGENTS.md and CLAUDE.md within 200 lines (also the pre-commit hook) |
| `just test [pkg]` | unit tests, all or one package (`just test server`)                                                                                                                                                             |
| `just e2e [args]` | Playwright against the running dev stack                                                                                                                                                                        |
| `just ci`         | `check` + `integration` + `e2e`                                                                                                                                                                                 |

AGENTS.md → "When to run what" says which further lanes a change needs
(`size`, `load`, `lighthouse`, `eval`, `pptx-roundtrip`, `mutate`).

### Machines and lanes

There is no hosted CI: `just ci` is the CI. Every lane runs on every machine
— the Linux desktop (Ubuntu 26.04), the MacBook and the Omarchy (Arch)
desktop; nothing needs macOS. Differences: Ubuntu 26.04's distro Node has no
type stripping (the recipes load tsx for ESLint) and Playwright ships no
Chromium for it (`just e2e` / `just eval` use the system Chrome, video off).

### Git hooks (lefthook, installed by `just setup`)

| Hook       | Runs                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pre-commit | `tools/dev/format.sh` on the staged files (ESLint --fix + Prettier), re-staged; `gitleaks` on the staged diff; the docs check (`tools/dev/docs-check.py`, every commit: a rename breaks docs the commit never touched)                                  |
| commit-msg | Conventional Commits (`tools/dev/commit-msg.sh`); `Merge…` and `autosync(…)` pass                                                                                                                                                                       |
| pre-push   | `just check` for the pushed content unless it passed before (`tools/dev/check-cache.sh`); skipped for a push that adds no commit (a tag) and for autosync-only pushes (the ai-config session-end autosync pushes work in progress within a 25 s budget) |

Until 2026-09-30 the hooks were husky + lint-staged; a clone from before
needs `just setup` once (it removes husky's `core.hooksPath`, without which
lefthook's hooks never run — `just doctor` flags it).

### Coding agents

`AGENTS.md` is the shared instruction file (Claude Code reads it through
`CLAUDE.md`, which adds the Claude-only part). `.claude/settings.json`
wires three hooks: files written are formatted (`tools/dev/format.sh
--edit`, Prettier only — ESLint costs ~5 s a call), writes of secrets,
lockfiles and generated files are refused, and a turn whose content
has not passed before runs `just check`. Green content is remembered by
`tools/dev/check-cache.sh` (content fingerprints in `.git/claude-check-green`,
one run at a time per clone), so the pre-push hook skips a tree the Stop hook
already checked. Subagents in
`.claude/agents/`, path-scoped rules in `.claude/rules/`.

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
- **`minio-init` cannot pull `minio/mc`** — MinIO's images are gone from Docker Hub and quay (pull access denied, 2026-09). `just services` then creates the bucket with any `minio/mc` image already on the machine; with none at all, create `narrative-media` with another S3 client or a cached image from another machine.
- **Two compose projects (`infra-*` and `narrative-*` containers)** — the compose file has been named `narrative` since 2026-08; containers started before that belong to a project called `infra`, with its own volumes, and hold the ports `just services` needs. Back up what you need, then `cd infra && docker compose -p infra --env-file ../.env down -v` (the Linux desktop was moved on 2026-09-30; its old data is in `backups/2026-09-30-infra-project/`, gitignored).
- **`docs-check` names a path or recipe that is right in context** (another repo's file, a file a plan will create, a file that was moved) — write the reference so it cannot be misread (a moved file: its old place in plain text), or put `<!-- docs-check: ignore -->` on that line (above a code fence: the whole block). Docs that record history (handoffs, finished plans) are listed in `EXCLUDE` in `tools/dev/docs-check.py`; never exclude a living doc to make the check pass.
- **Git hooks do not run after pulling the lefthook change (2026-09-30)** — husky had set `core.hooksPath=.husky/_`, which still points git at the deleted husky hooks. `just setup` (unsets it and runs `lefthook install`); `just doctor` reports it.
- **`npx playwright install` fails on Ubuntu 26.04** — `ERROR: Playwright does not support chromium on ubuntu26.04-x64` (same for the ffmpeg download that video capture needs). Playwright ships no managed build for this OS release yet, so a plain `pnpm --filter web test:e2e` fails. Install Google Chrome and use `just e2e` / `just eval`, which switch to it by themselves (`tools/dev/playwright-env.sh`); by hand:
  ```bash
  PLAYWRIGHT_USE_SYSTEM_CHROME=1 PLAYWRIGHT_NO_VIDEO=1 pnpm --filter web test:e2e
  # or: PLAYWRIGHT_CHROME_EXECUTABLE=/usr/bin/google-chrome PLAYWRIGHT_NO_VIDEO=1 …
  ```
  Verified on `petronijus-PC`, Ubuntu 26.04.1 LTS, 2026-09-09.
- **`pnpm lint` fails with `ERR_UNKNOWN_FILE_EXTENSION` on Ubuntu 26.04's own Node** — `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts" for …/packages/commands/src/parity/slideModelExports.ts`, before a single file is linted (`eslint.config.js` imports that file through `apps/web/eslint.one-door.js`). The distro package `nodejs` (`/usr/bin/node`, v22.22.1) is built without TypeScript support: `node -p process.features.typescript` prints `false`, and `node --experimental-strip-types file.ts` throws `ERR_NO_TYPESCRIPT`. The version satisfies `engines`, so `just doctor` warns instead. Working around it by loading `tsx` as the loader:
  ```bash
  NODE_OPTIONS="--import=tsx" pnpm lint
  ```
  exits 0 with 0 errors (219 warnings). Measured on `petronijus-PC`, Ubuntu 26.04, 2026-09-29. Since 2026-09-30 `just lint` and `tools/dev/format.sh` (the pre-commit hook) add the loader themselves when Node lacks type stripping; only a raw `pnpm lint` still needs it. A Node with type stripping (the Omarchy desktop runs 26.8 via mise, the MacBook 26.5) needs nothing.

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
