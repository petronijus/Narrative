# Media storage (M11)

## Architecture

```
Browser → Caddy /imgproxy/* → imgproxy:8080 → minio:9000 (S3 internal)
                                                    ↑
apps/server (tus endpoint, M11 phase 2) → minio:9000 (S3 SDK, internal Docker network)
```

- **MinIO** stores original uploaded files (S3-compatible, self-hosted).
- **imgproxy** serves resized/formatted variants on demand, fetching originals from MinIO over the internal Docker network using the S3 protocol.
- **tus-node-server** (implemented in `apps/server`, M11 phase 2) handles resumable uploads, writes final objects to MinIO via the AWS S3 SDK.

## Bucket layout

Bucket name: `narrative-media` (configurable via `MEDIA_BUCKET` env var).

```
narrative-media/
  decks/<deckId>/uploads/<uploadId>/original.<ext>   # user-uploaded file (original)
  decks/<deckId>/uploads/<uploadId>/meta.json        # mime type, byte size, original filename
```

- `<deckId>` — Yjs document / deck UUID
- `<uploadId>` — tus upload ID (UUID generated server-side on upload initiation)
- `<ext>` — original file extension (e.g. `jpg`, `png`, `webp`, `gif`)

**Owners (since A2.12b, 2026-09-30, unreleased at the time; [ADR 0012](./adr/0012-component-owned-media.md)).**
Each `media_assets` row has one owner, and its keys live in that owner's
namespace (`apps/server/src/media/mediaOwner.ts`):

```
narrative-media/
  decks/<deckId>/…              # a deck's media (uploads, videos/<assetId>/…, fonts/)
  components/<componentId>/…    # a component master's pictures and videos:
                                #   uploads/<assetId>/original.<ext>, videos/<assetId>/…,
                                #   thumb.<ext> (the master snapshot, PUT /components/:id/thumbnail)
```

A folder owns its fonts (`folder_id`, keys under `fonts/<folderId>/`) and,
since folder sharing step 2, pictures and videos too: deleting a component —
or removing a picture or video from a master — hands its rows to the folder
(`component_id = NULL, folder_id = folder`); their files stay where they
are, under `components/<old id>/`. A component never takes fonts. A tus
upload's object key is its compound upload id
`<assetId>:<deckId|unknown>:<base64url(path)>` (`@tus/s3-store` keys objects
by upload id), with the path above encoded in it. Ids that name a key
segment must match `^[A-Za-z0-9_-]{1,64}$` (`isStorageSafeId`).

**Linked, not copied, within a folder** (folder sharing step 2,
[`plans/folder-sharing.md`](./plans/folder-sharing.md) → "Step 2 design").
A deck or a master shows its own rows and, by link, the pictures and videos
of its folder's components and of the folder itself
(`apps/server/src/media/visibleMedia.ts`). A stamp or a paste out of a master
inside the folder points at the master's own asset: nothing is copied. A
copy is made only when media crosses into a document that may not show it:

- into another folder (paste, `deck.insertFrom`, `deck.duplicate`) — for
  whoever may read the media in its folder (members, guests of its decks);
  for anyone else the reference stays unresolved and is counted;
- from a deck into a master (a master must not depend on a deck);
- when a deck moves to another folder: the move copies what the deck links
  into the deck first and records each asset with its copy
  (`deck_moved_media`, migration 0032). An undo or a run revert that brings
  an old reference back is re-pointed at the recorded copy; an id the move
  did not record is never copied, and a lost copy is made again at most
  once, on the mover's copy budget, never by queuing a transcode
  (`apps/server/src/services/localiseMedia.ts`).

Every server-side copy with media spends one unit of the person's copy
budget (60 a minute, `services/mediaCopyBudget.ts`); a deck move is
unbudgeted.

**Cleanup** (`apps/server/src/media/bucketCleanup.ts`). Deleting a deck, a
component or a folder sweeps the owner's prefix (`decks/<id>/`,
`components/<id>/` — a folder's deletion also sweeps the prefixes of
components deleted earlier, named only by the keys of the rows it took
over) and purges the tus originals by the keys read from the rows before
the cascade. Two rules keep files that are still in use:

- **a key a remaining row names is never deleted** — several rows can
  share one file (a deleted folder font's per-deck clones, a pre-0009
  folder font stored under the deck it was uploaded in, a deleted
  component's media under its old prefix). Explicit purges
  (`purgeUnreferencedKeys`: `media.delete`, `folder.fonts.delete`, deck
  and folder deletion) follow the same rule;
- **a sweep keeps what a row does not name yet**: the video worker writes
  `<prefix>/videos/<assetId>/…` before it records the keys on the row, and
  a copy is stored before its row is registered. Everything under
  `videos/<id>/` of an existing row stays, and so does every object younger
  than the **grace window of 15 minutes** (`MEDIA_SWEEP_GRACE_MS` overrides
  it). When the owner itself is gone (a deleted deck, component or folder),
  the sweep runs once more after the window, in process and best effort.

Object versioning is NOT enabled. Deletes are hard-deletes. There is no
background garbage collection: what a failed purge leaves stays until its
owner's prefix is swept again.

## Access patterns

| Consumer          | How                                                    | Auth                              |
| ----------------- | ------------------------------------------------------ | --------------------------------- |
| Browser (display) | imgproxy signed URL via Caddy `/imgproxy/*`            | URL signature (IMGPROXY_KEY/SALT) |
| Browser (upload)  | tus endpoint on `apps/server` `/api/uploads/*`         | JWT Bearer                        |
| apps/server       | AWS S3 SDK → `minio:9000` (internal Docker)            | MINIO_ROOT_USER/PASSWORD          |
| Ops               | MinIO console at `minio.${DOMAIN}` or `localhost:9101` | MINIO_ROOT_USER/PASSWORD          |

## imgproxy URL structure

imgproxy URLs are signed by `apps/server` (media agent, M11 phase 2). The browser receives pre-signed URLs from the API and uses them directly as `<img src>`.

Preset variants:

- **thumbnail** — `rs:fit:400:0` — max 400 px wide, preserve aspect ratio
- **display** — `rs:fit:1600:0` — max 1600 px wide, preserve aspect ratio
- **original** — passthrough (use presigned MinIO URL directly, not imgproxy)

Example signed URL pattern (Caddy-routed):

```
https://narrative.example.com/imgproxy/<sig>/rs:fit:400:0/plain/s3://narrative-media/decks/<deckId>/uploads/<uploadId>/original.jpg
```

## Generating imgproxy KEY and SALT

Both values must be 64 hex characters (32 bytes). Run on any Unix system:

```bash
xxd -g 2 -l 32 -p /dev/random | tr -d '\n'
```

Run twice — once for `IMGPROXY_KEY`, once for `IMGPROXY_SALT`. Store in `.env` (dev) or `infra/.env.prod` (prod). Never commit these values.

## Local dev setup

MinIO and imgproxy start with the full docker compose stack:

```bash
cd infra
cp ../.env.example ../.env
# Fill in MINIO_ROOT_USER, MINIO_ROOT_PASSWORD, IMGPROXY_KEY, IMGPROXY_SALT in .env

docker compose --env-file ../.env up -d minio minio-init imgproxy
```

- MinIO S3 API: `http://localhost:9100`
- MinIO console: `http://localhost:9101`
- imgproxy: `http://localhost:8080`

The `minio-init` container runs once and creates the `narrative-media` bucket automatically, then exits. Before `minio` starts, the one-shot `minio-perms` container hands the data volume to the server's user (below).

## MinIO image

MinIO deleted `minio/minio` and `minio/mc` from Docker Hub on 2026-09-11, and quay.io has no tags for them either, so a machine without a cached copy can no longer pull the official images. Narrative runs **Chainguard's maintained build** instead, mirrored byte for byte into Petr's GHCR:

```text
ghcr.io/petronijus/minio:RELEASE.2026-09-22T19-25-18Z@sha256:25bc63a89475bc494bfbce9bbeddb0421aece3f3968d77c809db5104d07b4545
```

It is a multi-arch index (amd64 + arm64), a `crane copy` of `cgr.dev/chainguard/minio` at that digest. The reference is written once, as the `x-minio-image` anchor at the top of `infra/docker-compose.yml`; `minio`, `minio-perms` and `minio-init` all use it, and `infra/scripts/verify-minio.sh` and `just doctor` read it from there. Always the full `tag@digest`.

- **The GHCR package is private.** Every machine that pulls it — each dev machine, the production VM, the build host — needs `docker login ghcr.io -u petronijus` once, with a token that has `read:packages`. `just doctor` reports a machine that has neither the image nor the login.
- **What is in it:** entrypoint `/usr/bin/minio` (no default command), user `65532` (nonroot), `mc` and `sh` in `/usr/bin`, no `curl` or `wget`. The same image runs the `mc` jobs: Chainguard's separate `minio-client` image has no shell.
- **Ownership.** The old official image ran as root, so data it wrote is root-owned and the nonroot server refuses it (`Unable to initialize backend: Unable to write to the backend`). `minio-perms` runs as root before every start of `minio` and gives everything under `/data` to `65532:65532` (`chown -R -c`; the image has no `find`), logging how many entries changed — 0 once done. Data written by `minio/minio:RELEASE.2024-12-18` reads and writes fine after that.

To refresh the mirror (a newer Chainguard build):

```bash
crane digest cgr.dev/chainguard/minio:latest            # the new digest
docker run --rm cgr.dev/chainguard/minio@<new digest> --version   # prints the RELEASE tag
crane copy cgr.dev/chainguard/minio@<new digest> ghcr.io/petronijus/minio:<RELEASE tag>
crane digest ghcr.io/petronijus/minio:<RELEASE tag>     # must print <new digest>
```

Then bump both the tag and the digest of `x-minio-image` in `infra/docker-compose.yml`, run `just services` and `just integration`, and ship it with the next release.

## Production ops

### ZFS dataset

Create the dataset before first deploy:

```bash
zfs create tank/narrative/minio
```

Set `MINIO_DATA_PATH=/mnt/tank/narrative/minio` in `infra/.env.prod`.

### MinIO console access

In production the MinIO console is accessible via `https://minio.${DOMAIN}` (proxied by Caddy). DNS must resolve `minio.${DOMAIN}` to the server — a wildcard `*.${DOMAIN}` record covers this alongside `auth.${DOMAIN}`.

Alternatively, use an SSH tunnel for admin access without exposing the subdomain:

```bash
ssh -L 9101:127.0.0.1:9101 user@server
# Then open: http://localhost:9101
```

### Health verification

```bash
cd infra
MINIO_ROOT_USER=... MINIO_ROOT_PASSWORD=... ./scripts/verify-minio.sh
```

### Bucket bootstrap (idempotent)

The `minio-init` container in docker compose creates the bucket on every `compose up`. It is safe to re-run — `mc ls` returns 0 if the bucket already exists, skipping `mc mb`.

To run manually:

```bash
docker compose --env-file ../.env up minio-init
```

### Backup

MinIO data is stored on the ZFS dataset (`MINIO_DATA_PATH`). ZFS snapshots cover it automatically as part of the pre-deploy snapshot (`deploy.sh` → `zfs snapshot`).

For off-host replication, use `mc mirror`:

```bash
mc mirror local/narrative-media remote/narrative-media-backup
```

`mc mirror` is idempotent and safe to run in cron. Full backup automation is planned for M29.
