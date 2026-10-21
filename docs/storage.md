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
  the sweep runs once more a minute after the window: the delete writes a
  `media_owner_sweeps` row in its own transaction (migration 0040,
  `media/ownerSweeps.ts`), every server process looks for due rows each
  minute, and a row goes once its sweep ended without an error — a failed
  one is tried again (5 minutes doubling, 6 hours at most, 8 tries, then a
  warning). A row is taken by moving its due time 10 minutes forward
  (`FOR UPDATE SKIP LOCKED`), so two processes never sweep the same owner at
  once, and a row whose owner exists is dropped unswept. Until 2026-10-20
  this second sweep was an in-process timer that every restart forgot: the
  dev bucket had collected 5.8 GiB under 26 deleted decks.

Object versioning is NOT enabled. Deletes are hard-deletes. There is no
background garbage collection of prefixes no deletion scheduled: what a
purge that gave up leaves stays until its owner's prefix is swept again.

## Access patterns

| Consumer          | How                                                    | Auth                              |
| ----------------- | ------------------------------------------------------ | --------------------------------- |
| Browser (display) | imgproxy signed URL via Caddy `/imgproxy/*`            | URL signature (IMGPROXY_KEY/SALT) |
| Browser (upload)  | tus endpoint on `apps/server` `/api/uploads/*`         | JWT Bearer                        |
| apps/server       | AWS S3 SDK → `minio:9000` (internal Docker)            | MINIO_ROOT_USER/PASSWORD          |
| Ops               | MinIO console at `minio.${DOMAIN}` or `localhost:9101` | MINIO_ROOT_USER/PASSWORD          |

## imgproxy URL structure

imgproxy URLs are signed by `apps/server` (media agent, M11 phase 2). The browser receives pre-signed URLs from the API and uses them directly as `<img src>`.

Preset variants (`apps/server/src/media/imgproxyUrl.ts`; the caps are
`@narrative/shared` `imageVariants.ts`). Every `fit` is a ceiling: imgproxy
never enlarges, so a smaller source is served at its own size.

- **thumb** — `rs:fill:400:225:0/g:ce` — 400 × 225 cover crop (deck-grid and component tiles)
- **preview** — `rs:fit:600:600:0` — slide-panel thumbnails
- **medium** — `rs:fit:1280:1280:0` — a picture that covers at most 1280 device pixels of the canvas
- **display** — `rs:fit:2560:2560:0` — larger pictures, HiDPI, zoomed in
- **original** — no resize directive

The canvas chooses between `medium` and `display` per picture, by its drawn
size × the canvas's density (`apps/web/src/renderer/imageVariant.ts`;
docs/plans/performance.md → L3). Clients resolve many assets' URLs at once
with `GET /api/media/urls?ids=…&variants=…`; new uploads have `preview`,
`medium` and `display` encoded into the cache right away (`imgproxyWarm.ts`).

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

### Incomplete uploads

The server writes some objects as multipart uploads: a `.pptx` exported
into the bucket streams through `apps/server/src/media/multipartUpload.ts`
(a part in flight at a time), and the tus store uses them for resumable
uploads. A failed write aborts its upload — also when it fails while the
upload is still being created, or with a part on its way — so it leaves no
parts behind. What a killed process could not abort, MinIO removes itself:
`MINIO_API_STALE_UPLOADS_EXPIRY=24h`, checked every
`MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL=6h` (the `minio` service in
`infra/docker-compose.yml`; MinIO's defaults, pinned there). The S3
lifecycle rule for this (`AbortIncompleteMultipartUpload`) is not an option:
MinIO refuses it ("did not validate against our published schema", tried on
the pinned image 2026-10-19), and `mc ilm rule add` has no flag for it.
24 h is also how long a tus upload stays resumable. To check:
`mc admin config get <alias> api` lists both, with the environment override.

### Backup

MinIO data is stored on the ZFS dataset (`MINIO_DATA_PATH`). ZFS snapshots cover it automatically as part of the pre-deploy snapshot (`deploy.sh` → `zfs snapshot`).

For off-host replication, use `mc mirror`:

```bash
mc mirror local/narrative-media remote/narrative-media-backup
```

`mc mirror` is idempotent and safe to run in cron. Full backup automation is planned for M29.

### Security notes

- `IMGPROXY_KEY` and `IMGPROXY_SALT` are never committed: they keep signed
  image URLs from being rewritten.
- The MinIO console (`minio.${DOMAIN}`) is admin-only; prefer the SSH tunnel
  above to exposing the subdomain.
- imgproxy only reads from MinIO — `IMGPROXY_ALLOWED_SOURCES` is restricted to
  `minio:9000`.

## Video pipeline

Uploaded videos are prepared for playback by `apps/video-worker` (ffmpeg),
queued through BullMQ on a dedicated Redis. Since M12 phase 2 it keeps the
source quality: one progressive, faststart MP4 played by a plain `<video>`
over MinIO byte-range requests — no HLS ladder any more
(`apps/video-worker/src/processors/transcode.ts`;
[handoff](./handoff/M12-phase2-video-pipeline.md)):

```
tus upload completes (apps/server/src/media/tus.ts → enqueueVideoTranscode)
  → BullMQ job on media-redis (queue video-transcode)
  → video-worker: ffprobe, then playback.mp4 at source resolution —
      h264 / vp9 / av1 / vp8: stream copy; anything else (ProRes, HEVC, …): libx264 + aac
  → poster.jpg and thumb.jpg (400 px) at the 1 s mark, on the row at once
  → outputs to MinIO under <prefix>/videos/<assetId>/
  → the media_assets row gets the keys, duration, size, transcode_status=done
  → a source larger than 1920×1080 (as displayed): present.mp4 fitted into
      1920×1080 (libx264), after the playback; its key and size on the row
      (present_playback_key, present_width/height, migration 0039)
  → the editor reads GET /api/media/:assetId/video-info for the playback URL
      (and `presentPlayback`, which present mode plays when the screen shows
      no more pixels than it has: apps/web/src/renderer/videoRendition.ts)
```

A failed job is retried three times, then the row is marked `failed`.

**present.mp4 comes minutes after `done`.** Two consequences, both handled
or accepted on purpose:

- _The asset deleted meanwhile._ The rendition is recorded with an update
  that reports the rows it changed (`updatePresentRendition` in
  `apps/video-worker/src/assets.ts`); none — the row is gone, and its deletion
  read the keys before this file existed — and the worker deletes the
  `present.mp4` it just uploaded. The other way round (recorded, then
  deleted) the deletion names it: a single asset's delete purges the keys
  the `DELETE … RETURNING` hands back (`deleteMediaAsset`), a deck's or a
  folder's also sweeps the prefix again after a grace period (scheduled in
  `media_owner_sweeps`).
- _The video copied meanwhile_ (deck insert, `deck.insertFrom`, a
  component placed into another owner: `services/deckInsert.ts`). The copy
  takes the files the row names when it is copied; a `done` row without
  `present_playback_key` yet gives a copy with none, and nothing adds one
  later — no link from a copy back to its source is kept, and there is no
  rendition-only job. Accepted: the copy plays everywhere from its
  `playback.mp4` at full resolution (present mode just does not get the
  lighter file for it), and a fresh upload of the video gets both.

`<prefix>` is the owner's namespace, `decks/<deckId>` or
`components/<componentId>` (bucket layout above; a folder's videos keep the
key they were written under). `just dev` runs the worker
against the `media-redis` that `just services` starts; in containers:

```bash
cd infra
docker compose --env-file ../.env up -d media-redis video-worker
docker compose --env-file ../.env logs -f video-worker
MEDIA_REDIS_URL=redis://127.0.0.1:6380 ./scripts/verify-redis.sh
```

| Variable                | Default                  | Where                                           |
| ----------------------- | ------------------------ | ----------------------------------------------- |
| `MEDIA_REDIS_PORT`      | `6380`                   | Host port for media-redis                       |
| `MEDIA_REDIS_URL`       | `redis://127.0.0.1:6380` | The server and the dev worker enqueue/read here |
| `WORKER_CONCURRENCY`    | `2`                      | Parallel ffmpeg jobs per worker container       |
| `MEDIA_REDIS_DATA_PATH` | _(named volume)_         | Prod: ZFS path for queue persistence            |

Inside Docker the worker reads `REDIS_URL=redis://media-redis:6379` and
`MINIO_ENDPOINT=http://minio:9000` from compose. Not built: GPU encoding,
audio normalisation, resource limits on the worker.
