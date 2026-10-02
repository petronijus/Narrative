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
- **No git on the server** — `/opt/narrative` is an **rsync of the tagged
  tree** (`git archive`, since 2026-09-30; of a working tree before), not a
  checkout. `git log` there means nothing, and there is no `git pull`. The
  directory carries config + scripts; the versioned artifact is the
  **image**.
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

## Releasing the agentic layer (A1) — done in v0.10.0

The first release with agentic A1 (MCP server, personal access tokens,
OAuth) went live as **v0.10.0 on 2026-09-27**. What it needed is now in
place, and stays load-bearing if the prod env is ever rebuilt:

1. **`AGENT_PRINCIPAL_KEY_SECRET` is required** (≥ 32 chars, not the dev
   default — `apps/server/src/agent/principalKeySecret.ts`).
   `docker-compose.prod.yml` declares it `${AGENT_PRINCIPAL_KEY_SECRET:?…}`,
   so without it Compose refuses to parse the file — **`build-push.sh` on
   the build machine fails first**, then `deploy.sh`, then the server.
   It lives in `env.prod.sops`; to regenerate, add
   `AGENT_PRINCIPAL_KEY_SECRET=<openssl rand -base64 48>` with
   `./scripts/secrets-edit.sh prod` (generate it straight into the file,
   never paste it into a chat), then `./scripts/secrets-decrypt.sh prod`
   and `scp infra/.env.prod` to the VM. Rotating it needs no migration.
2. **`CLOUDFLARED_TRUSTED_PROXIES`** holds the shared cloudflared
   connector's real LAN address (in `env.prod.sops`; this repo only ever
   shows `192.0.2.x` placeholders). It was read on 2026-09-27 from Caddy's
   `remote_ip` for tunnel traffic, and the post-deploy check confirmed
   tunnel requests reach Caddy from exactly that address. If the connector
   moves, re-read it the same way (see "Client IP" below) and update it —
   left wrong, every visitor shares one rate-limit bucket and one
   WebSocket failed-auth throttle.
3. Migrations `0016`–`0023` and the Caddyfile's root
   `/.well-known/oauth-*` routes shipped with v0.10.0.

**Still open after the release:** the agent smoke test against prod needs a
person signed in to create the token — Access tokens → create an `mcp`
token, then
`claude mcp add --transport http narrative https://<domain>/api/mcp --header "Authorization: Bearer <token>" --scope local`
and `claude -p "List my 3 most recently changed decks" --allowedTools "mcp__narrative__*"`.
Revoke the token afterwards if it was only for the test.

## Releasing A2.12b (component-owned media) — 0.10.15

Written 2026-09-30, while the work was uncommitted; production ran
`v0.10.14+61260f2` (`/version.json`, re-checked the same day after A2.13).
0.10.15 also carries A2.13 (the close of A2: the action catalog guard, the
e2e test hook through commands, `object.create`'s optional `id`), which
adds no migration, env var or deploy step. The release brings three schema
migrations and one data migration
([ADR 0012](./adr/0012-component-owned-media.md)):

- **0027** adds `media_assets.component_id` (FK to `components`,
  `ON DELETE CASCADE`) and its index.
- **0028** adds two CHECK constraints. `media_assets_one_owner`
  (`num_nonnulls(deck_id, component_id, folder_id) <= 1`) is **validated**:
  if any existing row breaks it, the migration fails and `deploy.sh` stops
  at step 5. `components_id_storage_safe` (`id ~ '^[A-Za-z0-9_-]{1,64}$'`)
  is `NOT VALID`. Existing rows pass, but a legacy component with an
  unsafe id cannot take media (the storage code refuses it).
- **0029** makes `upload_sessions.deck_id` nullable, adds
  `upload_sessions.component_id` and a validated CHECK
  `upload_sessions_one_owner` (`num_nonnulls(deck_id, component_id) = 1`).
  Every existing row has a `deck_id` (it was `NOT NULL`), so the check
  cannot fail.
- **Data migration `2026-09-30-component-media`** runs in the background
  after start (step 6 below). It copies the deck media of masters promoted
  before this release into their components. Watch for
  `data migration: completed` with a report of `components`, `adopted`,
  `copied`, `unresolved` and `failed`. `unresolved` counts references it
  deliberately leaves alone: media of a deck in another folder, or media
  that no longer exists.

**Before deploying**, check production (on the VM, with Petr's consent for
the host). Both queries must return no rows:

```bash
cd /opt/narrative/infra
# 0028's validated CHECK: a media row with more than one owner (before 0027
# there is no component_id, so deck + folder is the only way to have two)
docker exec narrative-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT id, deck_id, folder_id FROM media_assets WHERE num_nonnulls(deck_id, folder_id) > 1;"'
# component ids that cannot name storage keys (created by a client before 0.10.15)
docker exec narrative-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT id, folder_id, name FROM components WHERE id !~ '"'"'^[A-Za-z0-9_-]{1,64}$'"'"';"'
```

If the first query returns rows, stop and decide which owner each row
keeps. The migration fails otherwise. If the second returns rows, those
components keep working as documents but cannot take media. As of
2026-09-30 neither query had been run on production or on a dev database.
Only the shell quoting was checked (by `echo`).

## Releasing folder roles — 0.10.16

0.10.16 brings two data-only migrations (folder sharing step 1,
[ADR 0013](./adr/0013-folder-sharing-roles.md)): **0030** creates
`folder_permissions` and gives every folder's owner an owner row; **0031**
gives every deck's creator an owner row in `deck_permissions` and drops the
`decks.owner_user_id` fallback with it. Both only insert (`ON CONFLICT`), so
they cannot fail on existing data. Checked on production on 2026-10-02
before the deploy, both 0 (4 decks, 3 folders):

```bash
docker exec narrative-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM decks d JOIN folders f ON f.id = d.folder_id WHERE d.owner_user_id <> f.owner_user_id;"'
docker exec narrative-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM decks d WHERE NOT EXISTS (SELECT 1 FROM deck_permissions p WHERE p.deck_id = d.id AND p.user_id = d.owner_user_id);"'
```

A deck whose creator is not its folder's owner would give the folder's
owner the owner role on it after 0030 — decide before deploying if the
first query ever returns more than 0.

## Access

The VM is reachable only through the Proxmox host (`pve`), which is the jump
host; nothing else routes to it. SSH aliases live in `~/.ssh/config`, keys
come from the 1Password SSH agent (approve the Touch ID prompt):

```
Host pve        # Proxmox host + jump host (Tailscale), root
Host narrative  # the VM: user petr (sudo + docker), ProxyJump pve
```

- Log in as **`petr`**, not root. The Tailscale host `docker`
  (alias `docker-vm`) is an **unrelated** homelab box — Narrative does not
  live there.
- A machine without the `narrative` alias (the Linux desktop, 2026-09-22)
  reaches the VM directly on the LAN: pass `NARRATIVE_SSH=petr@<vm address>`
  to `just deploy`.
- Coding agents connect to these hosts only with Petr's explicit consent per
  host.

## Quick deploy

From the project root, with the release tagged and pushed (AGENTS.md →
Conventions: `just bump`, CHANGELOG, commit → tag → push):

```bash
just deploy v0.10.15
```

The recipe refuses unless `HEAD` is that tag, the tracked files are clean and
the tag is on origin, then:

1. builds the images and pushes them to GHCR
   (`NARRATIVE_TAG=<tag> infra/scripts/build-push.sh`; needs Docker,
   `infra/.env.prod` and a `docker login ghcr.io`);
2. syncs **the tagged tree** (`git archive <tag>`, never the working
   directory — gitignored local files such as PPTX fixtures or the private
   overlay must not travel) to `/opt/narrative` with `rsync --delete`,
   sparing `infra/.env.prod`, a root `.env` and `backups/`, which live only on
   the VM;
3. runs `USE_SHARED_TUNNEL=1 NARRATIVE_TAG=<tag> ./infra/scripts/deploy.sh
prod` there;
4. fails unless `https://<domain>/version.json` then serves the tag.

Claude Code asks before running it (`.claude/settings.json`). By hand, the
same steps:

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u petronijus --password-stdin
NARRATIVE_TAG=v0.10.15 infra/scripts/build-push.sh
tree="$(mktemp -d)" && git archive v0.10.15 | tar -x -C "$tree"
rsync -az --delete --exclude /.env --exclude infra/.env.prod --exclude backups/ "$tree/" narrative:/opt/narrative/
ssh narrative 'chmod +x /opt/narrative/infra/scripts/*.sh &&
  cd /opt/narrative && NARRATIVE_TAG=v0.10.15 USE_SHARED_TUNNEL=1 ./infra/scripts/deploy.sh prod'
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
6. `docker compose up -d --remove-orphans` — once listening, the server also
   runs any pending one-time **data** migrations in the background
   (`apps/server/src/services/dataMigrations.ts`; completed ones are rows in
   `app_data_migrations`, migration 0026). These change documents rather
   than the schema, through the sync server, so open editors receive them as
   ordinary edits. Watch for `data migration: completed` (with a report) or
   `data migration: failed; retried on the next start` in
   `docker compose logs server`; a failed one leaves no row and runs again on
   the next start. The first, `2026-09-30-folder-tokens-on-server` (0.10.14),
   seeds folders without tokens, brings older seeds up to date and re-styles
   linked text that lags its text style. The second,
   `2026-09-30-component-media` (A2.12b, 0.10.15), copies the deck media
   that older component masters show into their components (see
   "Releasing A2.12b" above).
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

# MCP / OAuth discovery (claude.ai connectors). Both must be JSON from the
# API — an HTML answer means Caddy's root /.well-known/oauth-* route is
# missing and connecting from claude.ai will fail (see "MCP server" below).
curl -s https://narrative.example.com/.well-known/oauth-authorization-server/api | head -c 120
# {"issuer":"https://narrative.example.com/api", …
curl -s https://narrative.example.com/.well-known/oauth-protected-resource/api/mcp
# {"resource":"https://narrative.example.com/api/mcp","authorization_servers":["https://narrative.example.com/api"], …
curl -s -o /dev/null -D - https://narrative.example.com/api/mcp | grep -i www-authenticate
# www-authenticate: Bearer realm="narrative", resource_metadata="…/api/.well-known/oauth-protected-resource/mcp", scope="mcp"

# Client IP: the peer Caddy sees must be the cloudflared host, or every
# visitor shares one rate-limit bucket (see "Client IP" below). Load the site
# once first so there is traffic to look at.
ssh petr@192.0.2.147 "docker logs --since 10m narrative-caddy 2>&1 | grep -o '\"remote_ip\":\"[^\"]*\"' | sort | uniq -c"
# expected: only "remote_ip":"192.0.2.101" (plus 127.0.0.1 from the healthcheck)

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
- **Data migrations are forward-only too.** A completed one is not undone
  by a rollback (its row stays in `app_data_migrations` and it never runs
  again); what it changed in documents is ordinary document history.
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

| Variable                     | Source                                                                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`          | `openssl rand -hex 32` (generated at setup)                                                                                                                                                                                                                          |
| `OIDC_CLIENT_ID`             | Google Cloud → petr-apps → OAuth credentials                                                                                                                                                                                                                         |
| `OIDC_CLIENT_SECRET`         | Same (1Password: `google petr-apps OAuth client`)                                                                                                                                                                                                                    |
| `SESSION_COOKIE_SECRET`      | `openssl rand -hex 32` (generated at setup)                                                                                                                                                                                                                          |
| `MINIO_ROOT_USER/PASS`       | Chosen at setup                                                                                                                                                                                                                                                      |
| `IMGPROXY_KEY/SALT`          | `openssl rand -hex 32` each (generated at setup)                                                                                                                                                                                                                     |
| `RESEND_API_KEY`             | Resend dashboard                                                                                                                                                                                                                                                     |
| `AGENT_PRINCIPAL_KEY_SECRET` | `openssl rand -base64 48` (≥ 32 chars; required — the server refuses to start without it). HMAC key of the "working for" key agent peers carry in awareness; rotating it needs no migration (open editors relabel their agent by display name until they reconnect). |

The per-IP rate-limit pre-limit (3000 requests/minute) does not apply to agent
bearer tokens: requests with a well-formed `nmo_`/`nrt_` token are pre-limited per
token, so claude.ai users behind Anthropic's shared egress (160.79.104.0/21) do not
share a budget. New, unseen tokens are capped at 300 per minute per client IP;
tokens that failed verification are remembered for 60 s and cost no database
lookup. All in process memory, no configuration.

Non-secret settings with compose defaults (set them in `.env.prod` only to
override):

| Variable                        | Default (docker-compose.prod.yml) | Meaning                                                                                                                                                                                                               |
| ------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_API_URL`                | `https://${DOMAIN}/api`           | Public base of the API. The MCP endpoint is `<base>/mcp` — the URL users paste into claude.ai — and every MCP OAuth token is bound to it (changing it invalidates connected apps).                                    |
| `MCP_OAUTH_REDIRECT_URIS`       | empty                             | Extra OAuth callbacks besides the built-in claude.ai and Claude Code ones: comma-separated https URLs (exact), or http URLs on `localhost` / `127.0.0.1` (any port). Checked at start.                                |
| `MCP_OAUTH_CIMD_HOSTS`          | `claude.ai`                       | Hosts whose OAuth Client ID Metadata Documents are accepted (comma-separated; `none` = none). Checked at start.                                                                                                       |
| `MCP_OAUTH_DCR_ENABLED`         | `false`                           | `true` enables OAuth dynamic client registration (not needed for Claude Code / claude.ai). Checked at start.                                                                                                          |
| `AGENT_URL_FETCH_ALLOWED_HOSTS` | empty                             | Hostnames agent URL downloads may reach without the user confirming the host (comma-separated, exact, no port). Empty: every URL download is confirmed. Such a download may only be redirected to other listed hosts. |

If `.env.prod` is lost, regenerate all secrets, update the Postgres
password via `psql`, and redeploy.

### MCP server (`/api/mcp`) and its OAuth discovery

Claude Code (personal access token) and claude.ai custom connectors (OAuth)
reach Narrative at `https://<domain>/api/mcp` (docs/mcp.md). The OAuth
authorization server's issuer is `https://<domain>/api`, so its RFC 8414
metadata lives at the host root with the path inserted —
`/.well-known/oauth-authorization-server/api` — outside `/api`. The Caddyfile
therefore routes `/.well-known/oauth-authorization-server[/*]` and
`/.well-known/oauth-protected-resource[/*]` to the API **without** stripping
the path (the "OAuth discovery" block, before the SPA fallback; the SPA CSP is
untouched). It is a Caddyfile change, so it ships as a config-only change
(above) and must be checked on the live host with the `curl`s under
"Verifying the deploy".

Anthropic calls these endpoints from `160.79.104.0/21` and expects discovery,
registration and token answers within 10 s (refresh 30 s); all of them are
answered from memory or with a few indexed queries. Every claude.ai user shares
that egress range, so the per-IP limits (the 3000/min pre-limit, the anonymous
600/min bucket, `/oauth/token` 300/min, `/oauth/register` 30/hour) are shared
by all claude.ai users together — ample for this team; authenticated `/mcp`
traffic is limited per OAuth grant instead (240/min).

Housekeeping (nothing to schedule): hourly, and once a minute after start,
the server deletes expired OAuth tokens and authorization requests, and
**dynamically registered clients that have had no live grant and no use for 7
days** — claude.ai and other DCR clients register a new client on every fresh
connection. Clients that use a Client ID Metadata Document (Claude Code does,
because Narrative advertises it) are never stored at all.

### Client IP (`CLIENT_IP_HEADER`, `CLOUDFLARED_TRUSTED_PROXIES`)

Not secrets, but load-bearing. `CLIENT_IP_HEADER=cf-connecting-ip` is set in
`infra/docker-compose.prod.yml`. The server keys three things on the client
IP it reads from that header (`apps/server/src/http/clientIp.ts`): the
anonymous rate-limit buckets, the per-IP pre-limit that runs before any
credential lookup (3000 requests/minute), and the WebSocket
failed-authentication throttle (30 failures per 10 minutes). Signed-in
callers' own buckets are keyed by session or token, not IP. Behind Caddy
every request comes from Caddy's container address, so the real IP has to
come from the header Cloudflare's edge sets; Fastify's `trustProxy` is
deliberately off (the rate-limit module explains why).

Cloudflare overwrites a client-sent `CF-Connecting-IP`, but only for traffic
that goes through the tunnel. In the shared-tunnel topology Caddy publishes
port 80 on the LAN, so any LAN host could reach it directly and send its own
header — picking or poisoning any bucket, or getting another address
throttled. Caddy therefore **overwrites `CF-Connecting-IP` with the real TCP
peer address unless the peer is the cloudflared connector**
(`infra/caddy/Caddyfile`, "Client IP"). Which peers count as the connector is
`CLOUDFLARED_TRUSTED_PROXIES` in the Caddy container:

| Topology                                                            | Value                                                                                                                                                                                                         | Why                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Shared tunnel (`docker-compose.prod.shared-tunnel.yml`, prod today) | the cloudflared host's real LAN address, set in `.env.prod` — the overlay default `192.0.2.101/32` is a documentation placeholder and never matches (see "Releasing the agentic layer (A1)", done in v0.10.0) | The docker VM running the shared cloudflared; port 80 is reachable from the whole LAN. |
| Bundled cloudflared (`docker-compose.prod.yml` alone)               | `private_ranges` (default)                                                                                                                                                                                    | Caddy publishes no port; its only peers are containers on the compose network.         |

Set it in `.env.prod` to the connector's real address (the overlay default
is a documentation placeholder, see above). **Assumption, verify after
any network change:** Docker's published-port DNAT keeps the LAN source
address, so tunnel traffic reaches Caddy from `192.0.2.101` itself. If Docker
ever rewrites the source (a userland proxy, rootless Docker), every tunnelled
request would carry the Docker gateway address instead and all visitors
would share one IP bucket — the WebSocket throttle would then hit everyone at
once. Check it with the Caddy access log, which records the peer:

```bash
ssh petr@192.0.2.147 "docker logs --since 10m narrative-caddy 2>&1 | grep -o '\"remote_ip\":\"[^\"]*\"' | sort | uniq -c"
# expected: only "remote_ip":"192.0.2.101" (plus 127.0.0.1 from the healthcheck)
```

If ingress ever stops going through Cloudflare, unset `CLIENT_IP_HEADER` —
the header would then be client-controlled.

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

## Revoking a user (kill switch)

To cut someone off completely — a leaked laptop, someone leaving — revoke
every session **and** every agent credential (personal access tokens, and
every MCP OAuth grant — the user's connected apps — with its access and
refresh tokens; `apps/server/src/auth/agentCredentials.ts`) in one step:

```bash
ssh petr@192.0.2.147 'docker exec narrative-server \
  node apps/server/dist/apps/server/src/scripts/revokeUserAccess.js friend@gmail.com --dry-run'
ssh petr@192.0.2.147 'docker exec narrative-server \
  node apps/server/dist/apps/server/src/scripts/revokeUserAccess.js friend@gmail.com'
# dev: pnpm --filter @narrative/server db:revoke-user <email|sub> [--dry-run]
```

- It accepts an email or a Google `sub`, prints what it revoked, and exits
  `2` with a warning when the user **could still sign in again** — through
  `OIDC_ALLOWED_EMAILS` / `OIDC_ALLOWED_DOMAIN` (edit `.env.prod`, see above),
  a pending invite, or a deck permission (remove it in the share dialog).
  Revoking credentials does not take that access away; you have to.
- HTTP requests, tus uploads and MCP calls re-verify their credential on every
  request, so they stop at once. The script runs in its own process, so it
  cannot close anything the running server holds: **open MCP sessions (and
  their SSE streams) end within a minute** — the server's sweep re-verifies
  every open session's credential and sign-in policy each minute — and **open
  editor tabs keep their WebSocket** until they reconnect (which is refused).
  For an immediate cut-off restart the server afterwards
  (`… up -d --force-recreate server`, as above). Inside the server the same
  kill switch (`revokeAllSessionsForUser`) also ends the user's MCP sessions at
  once and expires their not-yet-exchanged OAuth authorizations, and revoking
  one access token in the web app ends that token's MCP sessions.
- Removing someone from the allowlist alone also stops their tokens: every
  token verification re-applies the sign-in rule to the token's owner.

Personal access tokens always expire — 30, 90 or 365 days, chosen at
creation; migration `0020_pat_expiry_cap` gave tokens created without an
expiry `created_at + 365 days`. They are accepted on the HTTP API, tus
(images, videos and fonts only) and MCP — never on the Hocuspocus WebSocket
(ADR 0011).

## Agent data retention and download limits

Housekeeping the server does by itself (owned by the agent runtime,
`apps/server/src/agent/runtime.ts`; nothing to schedule):

- **Agent runs and their ops** (`agent_runs`, `agent_ops`) are deleted 90
  days after their last activity — at startup and then every 24 hours. Open
  runs are never deleted. Op inputs and results are stored redacted: inline
  file bytes and `data:` URLs become `{ bytes, sha256 }`, URL query strings
  and fragments are stripped.
- **PPTX exports** (`decks/*/exports/` in MinIO) are deleted once older than
  one day — first sweep 5 minutes after start, then every 6 hours (on top of
  the per-deck sweep on re-export).

Files an agent hands over by URL or base64 (not through the browser's tus
upload) are capped lower than browser uploads and downloaded to a temp file,
never buffered whole in memory:

| Kind  | By URL / base64                             | Browser upload (tus) |
| ----- | ------------------------------------------- | -------------------- |
| .pptx | 200 MB, 120 s download deadline             | 2 GB                 |
| Video | 200 MB, 120 s download deadline             | 500 MB               |
| Image | 25 MB                                       | 25 MB                |
| Font  | 8 MB (`media.upload`), 10 MB (folder fonts) | same                 |

At most two URL downloads run at once per user; a third is refused with
"another download is in progress".

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
