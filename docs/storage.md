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

Object versioning is NOT enabled. Deletes are hard-deletes. Per-deck object cleanup on deck deletion is not implemented in M11; tracked for M17 (comments — was M21).

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

The `minio-init` container runs once and creates the `narrative-media` bucket automatically, then exits.

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
