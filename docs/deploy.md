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
│  ┌──────────────┐  ┌───────────────┐            │
│  │ media-redis   │  │ render-worker │            │
│  │  :6379        │  │ (Chromium)    │            │
│  └──────────────┘  └───────────────┘            │
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

`just deploy` needs on the machine it runs on only git, `gh` logged in,
Tailscale, and SSH with the 1Password agent: the agent opens the build host
(`NARRATIVE_BUILDER`) and, forwarded, the VM. No Docker, no
`infra/.env.prod`, no particular CPU or uplink (Quick deploy below).

For work on the VM by hand:

```bash
ssh petr@192.0.2.147       # direct (from LAN)
ssh -J root@192.0.2.100 petr@192.0.2.147  # via jump host (outside LAN)
```

🚨 **The images must be linux/amd64, whatever you build on.** The VM is
x86_64; Docker builds for the host architecture unless told otherwise, so an
Apple Silicon Mac produces arm64 images and the deploy dies at the pull with
`no matching manifest for linux/amd64 in the manifest list entries` — after
the tag has been pushed and `:latest` overwritten with it, so the next
tagless deploy would break too. Since 0.9.16 `build-push.sh` pins
the target platform itself (override with
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
`v0.10.14+d2773e5` (`/version.json`, re-checked the same day after A2.13).
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

## Releasing linked component media

Folder sharing step 2 ([ADR 0013](./adr/0013-folder-sharing-roles.md)) adds
migration **0032** (`deck_moved_media`, created empty: each linked picture
a deck move copied, with its copy) and the
storage-purge fix: until this release every `DeleteObjects` against MinIO
failed, so no purge has ever removed a file on production. From this
release purges really delete, and every one of them keeps a key that a
remaining row still names. Before deploying, list the media rows whose file
lies under another owner's prefix — those are the files a purge without
that guard would have taken:

```bash
docker exec narrative-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT id, kind, deck_id, component_id, folder_id, storage_key FROM media_assets
   WHERE (storage_key LIKE '\''decks/%'\'' AND (deck_id IS NULL OR storage_key NOT LIKE '\''decks/'\''||deck_id||'\''/%''))
      OR (storage_key LIKE '\''components/%'\'' AND (component_id IS NULL OR storage_key NOT LIKE '\''components/'\''||component_id||'\''/%''));"'
```

Expected: folder fonts uploaded before migration 0009 (`folder_id` set,
key under `decks/<origin deck>/fonts/`) and their per-deck clones. They are
safe now — the sweep keeps them — but they are the rows to look at if a
deleted deck ever takes a font with it. The orphans the failed purges left
on production stay; sweeping them is a separate, deliberate step.

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

## Releasing folder sharing — 0.10.18

Folder sharing steps 3 and 4 ([ADR 0013](./adr/0013-folder-sharing-roles.md))
add migrations **0033** (`folder_invites`, created empty) and **0034**
(`folders.is_drafts`, backfilled with each owner's oldest folder named
"Drafts", one per owner by a unique index the backfill cannot break). Both
are safe on any data. What needs a look is the new sign-in rule
(`auth/signInPolicy.ts`): outside the env allowlist, only a pending invite,
a grant on someone else's deck or a membership in someone else's folder
admits an account, and only with a verified email. Before, any
`deck_permissions` row did — including the owner row every deck gives its
creator. List the accounts the database will no longer admit:

```bash
docker exec narrative-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT u.email, coalesce(u.email_verified::text, '\''null'\''),
          EXISTS (SELECT 1 FROM deck_permissions p WHERE p.user_id = u.sub) AS admitted_before
   FROM users u
   WHERE NOT (coalesce(u.email_verified, false) AND (
     EXISTS (SELECT 1 FROM deck_invites i WHERE lower(i.email) = lower(u.email)
             AND i.accepted_at IS NULL AND i.expires_at > now())
     OR EXISTS (SELECT 1 FROM deck_permissions p JOIN decks d ON d.id = p.deck_id
                WHERE p.user_id = u.sub AND d.owner_user_id <> u.sub)
     OR EXISTS (SELECT 1 FROM folder_permissions m JOIN folders f ON f.id = m.folder_id
                WHERE m.user_id = u.sub AND f.owner_user_id <> u.sub)))
   ORDER BY 1;"'
```

Every row whose address `OIDC_ALLOWED_EMAILS` does not list (or, with a
verified email, `OIDC_ALLOWED_DOMAIN` does not cover) is turned away after
the deploy, its personal access tokens included. With neither variable set,
the env allowlist admits everyone and the list does not matter. For each
such account: add it to the allowlist, share a deck or a folder with it
after the deploy, or let it go — decide before deploying.

## Releasing the render worker — 0.10.21

The first release with `apps/render-worker` (agentic A3,
[plan](./plans/a3-render-worker.md): "Memory" and "Isolation"): a new image,
`ghcr.io/petronijus/narrative-render-worker`, built by the build host with
the others (`build-push.sh` `APPS`), pulled by `deploy.sh`, pruned by
`prune-images.sh`; a new compose service (`render-worker`) on a new network
(`narrative_render`, internal — no route out — which Caddy and the media
Redis join too), with the
production overrides in `docker-compose.prod.yml` (`RENDER_APP_ORIGIN
https://<domain>`, `RENDER_UPSTREAM http://caddy`, `mem_limit` /
`memswap_limit 900m`, `cpus: 2`). The GHCR package is private like the
others: the VM's and the build host's logins cover it. No migration, no env
var, no secret: the worker holds no credentials.

The container runs `seccomp=unconfined` so Chromium's own sandbox can start
(the plan's "Isolation" says why), with `RENDER_REQUIRE_SANDBOX=1`: if the
sandbox cannot start, the worker refuses to render and says so in its log.
Checked on VM 103 beforehand (2026-10-10): Ubuntu 24.04's
`kernel.apparmor_restrict_unprivileged_userns=1` does not stop it — a
non-root process in a container with these settings creates a user
namespace.

**After deploying:** `docker ps` shows `narrative-render-worker` running;
`docker logs narrative-render-worker` ends with `ready — queue="render"
app=https://<domain> via http://caddy sandbox=required`; open a deck,
right-click a slide → **Export as PNG**: a 1920×1080 PNG downloads within a
few seconds, and the log shows `browser started: Playwright headless shell …`
(a sandbox failure would show `Chromium's sandbox is not active`);
`docker stats narrative-render-worker` falls back to ~100 MiB a minute
later.

**0.10.24 (A3.4):** the worker keeps the page of the last render session
open for `RENDER_IDLE_MS` (60 s) after its job — `RENDER_WARM_PAGES`, default
1 (0 opens a page per job; more costs a page's memory each, beside the
900 MB limit — 1200 MB since 0.10.25). Nothing to configure for the release; after it, ask an agent
to look at a slide twice within a minute and check the log: only the first
job is followed by `browser started` / a page load, and the second comes
back in about a second.

## The desktop app's update feed

Since the desktop app (ADR 0015), Caddy serves `/opt/narrative/desktop-feed`
on the VM at `https://<domain>/desktop/` (`infra/caddy/Caddyfile`, mounted
read-only). `deploy.sh` creates the directory as the deploy user, and the
release sync (`remote-release.sh`) leaves it alone. Only `just
desktop-publish <linux|mac|win>` writes to it, after a release is deployed:
signed through the 1Password SSH agent, files first, `latest*.yml` last,
three versions kept per platform. The steps are in
[docs/desktop.md](./desktop.md#releasing-the-desktop-app).

## Releasing the MinIO image switch

The first release after `infra/docker-compose.yml` moved MinIO from
`minio/minio:RELEASE.2024-12-18T13-15-44Z` (deleted from Docker Hub on
2026-09-11, so it cannot be pulled again anywhere) to the private GHCR mirror
of Chainguard's build ([storage.md → MinIO image](./storage.md#minio-image)).
`just deploy` handles it: `deploy.sh` pulls the new image with the host's
GHCR login, and `compose up -d` recreates `minio` because its image changed.
Before that, the new one-shot `minio-perms` hands `MINIO_DATA_PATH` (the ZFS
dataset, root-owned because the old image ran as root) to user `65532`,
which the new server runs as. No migration, no env var.

**Before deploying** (on the VM, with Petr's consent for the host):

```bash
ssh narrative 'docker pull ghcr.io/petronijus/minio:RELEASE.2026-09-22T19-25-18Z@sha256:25bc63a89475bc494bfbce9bbeddb0421aece3f3968d77c809db5104d07b4545'
# denied / unauthorized: the VM's GHCR token cannot read the package —
#   docker login ghcr.io -u petronijus with a read:packages token
ssh narrative 'docker exec narrative-minio sh -c '"'"'MC_HOST_l="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@127.0.0.1:9000" mc ls --recursive l/narrative-media | wc -l'"'"''
# the object count to compare with after the deploy (398 on 2026-10-04)
```

`deploy.sh` snapshots the dataset only when `ZFS_DATASET` is set in
`.env.prod`; otherwise take one by hand first (`zfs snapshot
<dataset>@pre-minio-mirror`) — it is the way back to root-owned data.
Production (VM 103) has neither: no `ZFS_DATASET`, no ZFS on the VM, and
MinIO's data is the Docker volume `narrative_minio_data` on the VM's own
disk. There the way back is a tarball that keeps the owners, taken with an
image already on the VM (done for 0.10.19 on 2026-10-09: 106 MB, 1449
entries, in `backups/2026-10-09-pre-minio-mirror/`):

```bash
ssh narrative 'B=/opt/narrative/backups/$(date +%F)-pre-minio-mirror && mkdir -p $B &&
  docker run --rm -v narrative_minio_data:/data:ro -v $B:/b alpine:3.20 \
    tar -C /data --numeric-owner -cpzf /b/minio_data.tgz .'
```

**After deploying:** `docker ps` shows `narrative-minio` on the
`ghcr.io/petronijus/minio` image and `healthy`;
`docker inspect narrative-minio-perms --format '{{.State.ExitCode}}'` prints
`0`; the object count matches (the same command, now run with the new
image's `mc`); an existing deck shows its pictures and a new upload works.

**Rollback.** The old image survives only in the VM's image cache:
`prune-images.sh` leaves it alone, but `docker system prune -a` or
`docker image prune -a` would delete it for good — do not run either there
until the switch has proven itself. Rolling back to a release before this
one brings back its compose files and with them the old image, which runs
as root and so reads and writes the `65532`-owned data without a `chown`
back. Once the cached copy is gone, there is no way back to the official
image: stay on the mirror (any later Chainguard build is a `crane copy` away).
On production that is the state since 2026-10-10: the cached copy was
removed after 0.10.19 ran healthy for 17 hours.

## Releasing style packs — 0.11.1 (0.11.0 never deployed)

Agentic A4 ([plan](./plans/a4-style-packs.md),
[handoff](./handoff/A4-style-packs.md)). No new image, service, env var or
secret. One schema migration and one data migration:

- **0035** adds `media_assets.font_axes` (jsonb, nullable): the weight and
  width axis ranges of a variable font, read on upload. Additive, no
  constraint: it cannot fail on existing rows.
- **Data migration `2026-10-12-font-axes`** runs in the background after
  start. It reads every stored font from MinIO once and records its axes
  (`{}` for a static font). Watch for `data migration: completed` with a
  report of `fonts`, `variable` and `failed`. A font in `failed` keeps
  working: it is drawn at its own weight, only without a width range.

The style packs themselves are not part of the deploy. The five brand
packs live in the private overlay (`just style-pack`). Each goes into a
production folder only at Petr's go, brand by brand (`just
style-pack-import private/packs/<brand>.json <folderId>
https://<domain>`, with a personal access token in `NARRATIVE_TOKEN`). The
brand fonts and logos are uploaded on the MacBook (private/HANDOVER.md).

**After deploying:** `/version.json` names 0.11.1; the server log shows the
data migration completed; Folder Settings of a folder shows the **Style
pack** tab ("This folder has no style pack" until one is imported); a slide with a text
box set to grow with its text, in Inter, renders: right-click → **Export as
PNG** downloads within seconds (before 0.11.0 it timed out).

## Access

The VM is reachable only through the Proxmox host (`pve`), which is the jump
host; nothing else routes to it. SSH aliases live in `~/.ssh/config`, keys
come from the 1Password SSH agent (approve the Touch ID prompt):

```
Host pve        # Proxmox host + jump host (Tailscale), root
Host narrative  # the VM: user petr (sudo + docker), ProxyJump pve
```

- Log in as **`petr`**, not root. The Tailscale host `docker`
  (alias `docker-vm`, VM 105) does not run Narrative; it is the **build
  host** `just deploy` uses (Quick deploy), and it reaches the VM on the LAN
  with the deploying machine's forwarded agent — no alias needed anywhere.
- Coding agents connect to these hosts only with Petr's explicit consent per
  host.

## Quick deploy

From the project root of any of Petr's machines, with the release tagged and
pushed (AGENTS.md → Conventions: `just bump`, CHANGELOG, commit → tag →
push), and its GitHub release made from that CHANGELOG section:

```bash
just gh-release v0.10.18
just deploy v0.10.18
```

`just deploy` (`infra/scripts/ship.sh`) does not build on the machine it runs
on. The **build host** — `NARRATIVE_BUILDER` in the private overlay's
`private/release.env` (with `NARRATIVE_VM`, the production VM; the public
`infra/release.env` holds only the domain), the always-on x86_64 homelab VM 105 on the LAN, logged in to GHCR — does the work,
so a slow uplink, an Apple Silicon CPU, a missing Docker or a stale
`infra/.env.prod` on the deploying machine no longer matter (each of them
stopped the 0.10.18 deploy from a MacBook on 2026-10-07/09).

1. **Preflight** (seconds, before anything is built): the tag and the
   deploying checkout's `HEAD` are on GitHub, `gh` is logged in, and the
   builder answers, has Docker with buildx, is logged in to `ghcr.io`, has
   15 GB free and reaches the VM with the forwarded SSH agent. A failure
   names its fix.
2. **On the builder** (`infra/scripts/remote-release.sh`, streamed over
   `ssh -A`, one release at a time under a lock): fetches the tag from
   GitHub (a `gh` token passed on stdin, kept in the git process's
   environment only, never written), checks out fresh worktrees of the tag
   and of the deploying `HEAD` (the tooling, so an older tag ships with
   today's scripts), then `build-push.sh`: builds the three images for
   linux/amd64 with **no secrets and no domain** (the web app uses `/api` and
   `/ws` on its own origin, `apps/web/src/lib/endpoints.ts`; since 0.10.20),
   pushes them with up to five attempts each, and checks that the registry
   holds linux/amd64 images for the tag.
3. Syncs **the tagged tree** (`git archive <tag>`, never a working directory)
   to `/opt/narrative` on the VM over the LAN with `rsync --delete`, sparing
   `infra/.env.prod`, a root `.env` and `backups/`, which live only on the
   VM; runs `USE_SHARED_TUNNEL=1 NARRATIVE_TAG=<tag> ./infra/scripts/deploy.sh
prod` there.
4. Fails unless `https://<domain>/version.json` serves the tag — checked from
   the builder and again from the deploying machine.

Claude Code asks before running it (`.claude/settings.json`). Another build
host: `NARRATIVE_BUILDER=user@host just deploy vX.Y.Z`; it needs Docker with
buildx, `docker login ghcr.io -u petronijus` with a write:packages token,
git, rsync, flock, curl, python3 and GNU base64, and must reach the VM.

By hand, without a builder (any Docker host, slow under emulation on arm64):

```bash
docker login ghcr.io -u petronijus          # a write:packages token
src="$(mktemp -d)" && git worktree add --detach "$src" v0.10.18
NARRATIVE_TAG=v0.10.18 infra/scripts/build-push.sh --src "$src"
tree="$(mktemp -d)" && git archive v0.10.18 | tar -x -C "$tree"
rsync -az --delete --exclude /.env --exclude infra/.env.prod --exclude backups/ "$tree/" narrative:/opt/narrative/
ssh narrative 'chmod +x /opt/narrative/infra/scripts/*.sh &&
  cd /opt/narrative && NARRATIVE_TAG=v0.10.18 USE_SHARED_TUNNEL=1 ./infra/scripts/deploy.sh prod'
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
   volume that Caddy serves. The bundle's API and WS addresses are the
   relative `/api` and `/ws` (resolved against the page, so the image is
   domain-independent); only `VITE_BUILD_VERSION` is stamped in at build
   time by `build-push.sh`
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
   Then it validates and reloads the Caddyfile inside `narrative-caddy` (a
   file that does not validate fails the deploy; the running config stays).
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
# {"version":"v0.9.3+c4305b8"}

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
mounted now (`./caddy:/etc/caddy:ro`, commit `8933119`) — do not "simplify" it
back to a file mount.

`deploy.sh` validates and reloads the Caddyfile after `compose up` (since
0.10.20), so a release or a redeploy picks a change up by itself and a file
that does not validate fails the deploy. By hand, without a deploy:

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

The **source of truth** is the SOPS-encrypted `private/config/env.prod.sops`
in the private overlay (cloned into `./private`); the dev `.env` comes from
`private/config/env.sops` the same way. The age private key is fetched from
1Password at runtime, never written to disk; the public recipient is in the
overlay's `.sops.yaml`. Prereqs: `sops`, `age`, the 1Password CLI.

| Target | Encrypted (overlay)            | Materializes to     |
| ------ | ------------------------------ | ------------------- |
| `dev`  | `private/config/env.sops`      | `./.env`            |
| `prod` | `private/config/env.prod.sops` | `./infra/.env.prod` |

```bash
./scripts/secrets-decrypt.sh [dev|prod]   # materialize the env file (default dev)
./scripts/secrets-edit.sh    [dev|prod]   # decrypt → $EDITOR → re-encrypt in place
```

On the VM the file is `/opt/narrative/infra/.env.prod` (chmod 600,
gitignored) and is **never rsynced** (excluded in the rsync command), so a
changed prod secret has to be carried there:

```bash
./scripts/secrets-edit.sh prod      # edit + re-encrypt; commit the .sops in ./private
./scripts/secrets-decrypt.sh prod   # infra/.env.prod locally (build-push.sh reads it too)
scp infra/.env.prod narrative:/opt/narrative/infra/.env.prod
ssh narrative 'cd /opt/narrative && ./infra/scripts/deploy.sh prod'
```

An ad-hoc edit made on the VM (e.g. `USE_SHARED_TUNNEL=1`) goes back into
`env.prod.sops` with `secrets-edit.sh prod`, or the next rebuild loses it.

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

# Recreate server container (no rebuild needed). Pass the running release:
# without NARRATIVE_TAG compose falls back to the stale `latest` image and the
# server ends up older than the web app (folders lose `sharedBy`, the home
# page crashes). The tag is in `/version.json`.
ssh petr@192.0.2.147 'cd /opt/narrative/infra && NARRATIVE_TAG=vX.Y.Z \
  docker compose -f docker-compose.yml \
    -f docker-compose.prod.yml \
    -f docker-compose.prod.shared-tunnel.yml \
    --env-file .env.prod up -d --force-recreate server'
```

### Admins add people themselves

Once someone is an instance admin ([ADR 0014](./adr/0014-instance-admin.md)),
nobody needs SSH to let a colleague in: the admin screen (user menu →
Administration) allows an address to sign in and makes other admins. The first
admin comes from `ADMIN_EMAILS` in `infra/.env.prod` (a comma-separated list of
verified emails), set the same way as the allowlist above (including
`NARRATIVE_TAG`); the flag is set at sign-in while the instance has no admin —
the first listed person to sign in becomes it, and promotes the others. Admins own every folder and
deck but other people's Drafts. Their changes need no restart.

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

### Deploy fails at "Pulling prebuilt app images from GHCR…"

Either the host is not logged in to GHCR (the packages are private) or the tag
does not exist because `build-push.sh` was never run for it:

```bash
ssh petr@192.0.2.147 'docker login ghcr.io -u petronijus'   # one-time, needs a PAT with read:packages
NARRATIVE_TAG=v0.9.3 infra/scripts/build-push.sh            # on the build machine
```

If the pull itself fails on space, drop old release images (keeps the
current tag, `latest`, two more and whatever a container runs):

```bash
ssh petr@192.0.2.147 'cd /opt/narrative && ./infra/scripts/prune-images.sh --current <live tag> --builder-cache'
```

Never `docker system prune --volumes` here: with the stack stopped it
deletes every named volume — Postgres, MinIO and Redis data included,
wherever a `*_DATA_PATH` is not set to a host path.

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
