# M12 Phase 1a — Video Pipeline Infrastructure Handoff

**Date:** 2026-04-20
**Agent:** infra
**Status:** Complete (phase 1a only — transcodeProcessor is a stub)

## What was done

Set up the queue infrastructure for video processing. No ffmpeg logic implemented — that is phase 2 (media agent).

### New files

- `apps/video-worker/package.json` — `@narrative/video-worker` workspace package
- `apps/video-worker/tsconfig.json` + `tsconfig.build.json`
- `apps/video-worker/Dockerfile` — multi-stage: Node 22 alpine builder + runtime with ffmpeg
- `apps/video-worker/src/index.ts` — BullMQ Worker bootstrap, graceful shutdown
- `apps/video-worker/src/queue.ts` — `VIDEO_TRANSCODE_QUEUE` constant + `VideoTranscodeJobData` / `VideoTranscodeResult` types
- `apps/video-worker/src/processors/transcode.ts` — placeholder stub (throws immediately)
- `infra/scripts/verify-redis.sh` — health probe for media-redis

### Modified files

- `infra/docker-compose.yml` — added `media-redis` service (port 6380), `video-worker` service, `media_redis_data` volume
- `infra/docker-compose.prod.yml` — prod overrides: 127.0.0.1 binding for media-redis, ZFS volume path, `restart: always` for both services
- `.env.example` — added `MEDIA_REDIS_PORT`, `MEDIA_REDIS_URL`, `WORKER_CONCURRENCY`
- `infra/.env.prod.example` — added `MEDIA_REDIS_DATA_PATH`, `MEDIA_REDIS_URL`, `WORKER_CONCURRENCY`
- `.github/workflows/ci.yml` — added `video-worker` Docker build validation step
- `README.md` — added "Video pipeline (M12)" section

## Workspace location decision

Placed at `apps/video-worker/` (not `apps/workers/video/` as noted in BUILD_PLAN.md) because:

- `pnpm-workspace.yaml` uses `apps/*` glob — `apps/workers/video` is two levels deep and would not be picked up without adding `apps/workers/*` to the yaml.
- `apps/video-worker/` requires zero workspace config changes and is consistent with existing `apps/server/` and `apps/web/` siblings.
- If a second worker is added later, the workspace yaml can be extended then.

## Architecture notes

### Why separate Redis for media queue

Authentik's `authentik-redis` is session/cache-critical. Media queue Redis (`media-redis`) can be wiped without user-visible impact. Keeping them separate:

- Prevents queue traffic (heavy during video uploads) from affecting auth latency
- Different restart tolerance: queue Redis can be stopped for maintenance without touching auth sessions
- Different backup/restore SLA: job queue doesn't need PITR

### Env var split

| Var               | Used by                  | Purpose                  |
| ----------------- | ------------------------ | ------------------------ |
| `MEDIA_REDIS_URL` | `apps/server`            | Enqueue BullMQ jobs      |
| `REDIS_URL`       | `video-worker` container | Worker connects to queue |

The split exists because the server runs natively in dev (port 6380 on localhost) while the worker runs in Docker (internal network hostname `media-redis:6379`). In prod both can use `redis://media-redis:6379` via Docker network.

## What phase 2 (media agent) must implement

1. `transcodeProcessor` in `apps/video-worker/src/processors/transcode.ts`:
   - Stream original from MinIO (`storageKey`) to `/tmp`
   - `ffmpeg` transcodes: 360p/720p/1080p HLS segments + poster + thumbnail
   - Upload all outputs to MinIO under `decks/<deckId>/videos/<assetId>/`
   - Parse ffprobe JSON for `width`, `height`, `durationSec`
   - `UPDATE media_assets SET status='ready', hls_manifest_key=..., ...` via Postgres

2. Server endpoint (in `apps/server`):
   - After tus upload completes, enqueue a `VideoTranscodeJobData` job on `VIDEO_TRANSCODE_QUEUE`
   - Requires `MEDIA_REDIS_URL` in server env

3. `GET /api/media/:id/video-info` — returns HLS manifest URL for client playback

4. `media_assets` schema extension (state-sync agent):
   - `status` (enum: pending, processing, ready, failed)
   - `hls_manifest_key`, `poster_key`, `thumbnail_key`
   - `duration_sec`, `width`, `height`

## How to start services

```bash
# Dev — media-redis in Docker, worker native (hot-reload)
cd infra && docker compose --env-file ../.env up -d media-redis
cd apps/video-worker && pnpm dev

# Dev — both in Docker
cd infra && docker compose --env-file ../.env up -d media-redis video-worker

# Prod
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d media-redis video-worker

# Health check
MEDIA_REDIS_URL=redis://127.0.0.1:6380 ./infra/scripts/verify-redis.sh
```

## Worker image size estimate

`node:22-alpine` base (~55 MB) + `ffmpeg` package (~80 MB) + node_modules (~60 MB compiled) = ~195 MB total image. Acceptable for a long-running worker container.

## Tests

None added in phase 1a — `transcodeProcessor` is a stub and has nothing to test. Phase 2 should add:

- Unit tests for ffprobe parsing
- Integration test: enqueue a job with a test video, assert MinIO outputs are created
