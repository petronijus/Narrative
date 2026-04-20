# M12 Phase 2 Handoff — Video Upload + ffmpeg Transcode Pipeline

## Status

Complete. Phase 1 (BullMQ + Redis + schema) was the prerequisite; this document covers phase 2 only.

## Architecture

```
Browser
  └─ tus PATCH /api/uploads
        │
        ├─ onUploadCreate: MIME check (video/* OK, size ≤ 500 MB)
        └─ onUploadFinish (video branch)
              ├─ createMediaAsset(kind='video', transcodeStatus='pending')
              └─ enqueueVideoTranscode → BullMQ queue 'video-transcode'
                                               │
                                         media-redis (redis://127.0.0.1:6380)
                                               │
                                    apps/video-worker (BullMQ Worker)
                                          transcodeProcessor
                                               │
                   ┌───────────────────────────┼────────────────────────────┐
                   │                           │                            │
             ffprobe (dims)            ffmpeg × 3 variants        poster + thumb
                                  (360p / 720p / 1080p HLS)     (ffmpeg -vframes 1)
                                               │
                                         MinIO upload
                               decks/<deckId>/videos/<assetId>/
                                               │
                              updateVideoAssetOutputs → Postgres
                                    transcodeStatus = 'done'
```

## ffmpeg Commands Reference

### Probe (ffprobe)

```
ffprobe -v quiet -print_format json -show_streams -select_streams v:0 <input>
```

Fallback for duration: re-probe with `-show_format` if stream duration is missing.

### HLS Variant Encode (repeated per variant: 360p / 720p / 1080p)

```
ffmpeg -i <input>
  -vf scale=-2:<height>
  -c:v libx264 -preset fast -crf 23
  -b:v <videoBitrate> -maxrate <videoBitrate> -bufsize <2x videoBitrate>k
  -c:a aac -ar 48000 -ac 2 -b:a <audioBitrate>
  -hls_time 4 -hls_playlist_type vod
  -hls_segment_filename <variantDir>/seg_%03d.ts
  <variantDir>/playlist.m3u8
```

Variant table:

| Variant | Height | Video bitrate | Audio bitrate | BANDWIDTH |
| ------- | ------ | ------------- | ------------- | --------- |
| 360p    | 360    | 800k          | 96k           | 928 kbps  |
| 720p    | 720    | 2500k         | 128k          | 2688 kbps |
| 1080p   | 1080   | 5000k         | 192k          | 5248 kbps |

Variants whose height exceeds source height are skipped automatically.

### Poster frame (1 s mark)

```
ffmpeg -ss 1 -i <input> -vframes 1 -q:v 2 -y poster.jpg
```

Falls back to `-ss 0` if video is shorter than 1 s.

### Thumbnail (400 px wide, sidebar use)

```
ffmpeg -ss 1 -i <input> -vframes 1 -vf scale=400:-2 -q:v 3 -y thumb.jpg
```

## MinIO Bucket Layout (video outputs)

```
narrative-media/
  decks/<deckId>/
    uploads/<assetId>/
      original.<ext>          ← tus upload target (storageKey in media_assets)
    videos/<assetId>/
      master.m3u8             ← HLS master manifest (hlsManifestKey)
      360p/
        playlist.m3u8
        seg_000.ts
        seg_001.ts
        ...
      720p/
        playlist.m3u8
        seg_*.ts
      1080p/                  ← only when source height ≥ 1080
        playlist.m3u8
        seg_*.ts
      poster.jpg              ← posterKey (signed via imgproxy display variant)
      thumb.jpg               ← thumbnailKey (signed via imgproxy thumb variant)
```

## New API Endpoint

### `GET /api/media/:assetId/video-info`

Auth: JWT required. Access: viewer or above.

Response while pending/processing:

```json
{
  "assetId": "...",
  "transcodeStatus": "pending",
  "durationSec": null,
  "width": null,
  "height": null,
  "posterUrl": null,
  "thumbnailUrl": null,
  "hlsManifestUrl": null,
  "transcodeError": null
}
```

Response when done:

```json
{
  "assetId": "...",
  "transcodeStatus": "done",
  "durationSec": 120,
  "width": 1920,
  "height": 1080,
  "posterUrl": "https://imgproxy.../SIGNED/poster.jpg",
  "thumbnailUrl": "https://imgproxy.../SIGNED/thumb.jpg",
  "hlsManifestUrl": "http://minio:9000/narrative-media/decks/.../master.m3u8",
  "transcodeError": null
}
```

`posterUrl` and `thumbnailUrl` are signed imgproxy URLs (display and thumb variants respectively, `jpg` extension).

`hlsManifestUrl` is a direct MinIO URL (public bucket policy for M12 dev).

## New Files

- `packages/shared/src/video-queue.ts` — `VIDEO_TRANSCODE_QUEUE` + `VideoTranscodeJobData` + `VideoTranscodeResult` (source of truth; shared by server and worker)
- `apps/server/src/media/enqueue.ts` — BullMQ Queue singleton + `enqueueVideoTranscode()` + `closeQueueConnection()`
- `apps/video-worker/src/db.ts` — Drizzle client factory for the worker
- `apps/video-worker/src/schema.ts` — Drizzle schema subset (media_assets only)
- `apps/video-worker/src/assets.ts` — `updateTranscodeStatus()` + `updateVideoAssetOutputs()`
- `apps/video-worker/vitest.config.ts` — Vitest config with @narrative/shared alias

## Changed Files

- `apps/server/src/media/tus.ts` — accepts `video/*`; per-MIME size limits; video branch in `onUploadFinish`
- `apps/server/src/media/routes.ts` — `GET /api/media/:assetId/video-info` endpoint; `publicMinioBaseUrl()` helper
- `apps/server/src/index.ts` — `closeQueueConnection()` wired into SIGTERM handler
- `apps/video-worker/src/processors/transcode.ts` — full ffmpeg pipeline replacing the stub
- `apps/video-worker/src/queue.ts` — re-exports from `@narrative/shared` (backward compat)
- `apps/video-worker/src/index.ts` — `MEDIA_REDIS_URL` env var; `worker.on('failed')` updates DB
- `packages/shared/src/index.ts` — re-exports from `video-queue.ts`
- `apps/server/package.json` — added `bullmq`, `ioredis`, `@narrative/shared`
- `apps/video-worker/package.json` — added `@narrative/shared`
- `apps/server/vitest.config.ts` — `@narrative/shared` resolve alias

## Environment Variables

| Variable                | Default                  | Description                                   |
| ----------------------- | ------------------------ | --------------------------------------------- |
| `MEDIA_REDIS_URL`       | `redis://127.0.0.1:6380` | Dedicated Redis for BullMQ (server + worker)  |
| `MAX_VIDEO_UPLOAD_SIZE` | `500000000`              | Max video upload in bytes (500 MB)            |
| `MAX_UPLOAD_SIZE`       | `25000000`               | Max image upload in bytes (25 MB)             |
| `MINIO_ENDPOINT`        | —                        | MinIO base URL (e.g. `http://localhost:9000`) |
| `MEDIA_BUCKET`          | `narrative-media`        | MinIO bucket name                             |
| `POSTGRES_URL`          | —                        | PostgreSQL connection string (worker)         |

## How to Test Locally

1. Start dependencies:

   ```
   docker compose up -d media-redis minio postgres
   ```

2. Start the video worker:

   ```
   cd apps/video-worker
   MEDIA_REDIS_URL=redis://127.0.0.1:6380 POSTGRES_URL=... MINIO_ENDPOINT=http://localhost:9000 pnpm dev
   ```

3. Start the server:

   ```
   cd apps/server
   MEDIA_REDIS_URL=redis://127.0.0.1:6380 BYPASS_AUTH=true ... pnpm dev
   ```

4. Upload a video via the editor UI (or with curl + tus-client) — watch worker logs for `→ processing` → `encoded 360p` → `uploads complete` → `→ done`.

5. Poll `GET /api/media/<assetId>/video-info` every 2 s until `transcodeStatus === 'done'`.

## Tests Added

- `apps/server/src/media/enqueue.test.ts` — 6 tests (enqueue + singleton + closeConnection)
- `apps/server/src/media/routes.test.ts` — 5 new tests for `GET /api/media/:id/video-info`
- `apps/server/src/media/tus.test.ts` — 5 new tests (video MIME accepted, 413 size limits, video finalize branch)
- `apps/video-worker/src/processors/transcode.test.ts` — 9 tests (mocked ffmpeg/S3/DB) + 1 skipped CI integration placeholder

Total: 191 server tests pass, 9 worker tests pass (1 skipped).

## Known TODOs (for later milestones)

- **HLS presigned URLs** (M29): `hlsManifestUrl` is currently a direct MinIO URL relying on public bucket policy. For production with a private bucket, generate time-limited S3 presigned URLs and update the master manifest's segment references accordingly. Note: `hls.js` carries query string params to child segment URLs by default, so a single presigned master URL may be sufficient if the bucket allows cross-segment query param forwarding.

- **Progress reporting** (M14 polish): Parse ffmpeg's `-progress pipe:1` output to emit fractional progress via `job.updateProgress(n)`. Surface this in editor-ui via the `/api/media/:id/video-info` polling loop or a BullMQ event stream endpoint.

- **Thumbnail sprite sheets** (M14): Generate a VTT + sprite JPEG for scrubbing preview in the video player seek bar.

- **Audio-only content** (post-M12): For podcast-style slides, add an audio transcode path alongside the video pipeline.

- **MinIO GC for orphaned uploads** (M29): When a deck is deleted, the `uploads/` and `videos/` objects in MinIO remain. A periodic GC job should enqueue cleanup for all `storageKey` + `hlsManifestKey` paths belonging to deleted decks.

## Consumer Expectations for Phase 3

### renderer (`renderer` agent)

- Call `GET /api/media/:assetId/video-info` to get current state.
- While `transcodeStatus !== 'done'`: render `posterUrl` as a static image placeholder with a spinner overlay. If `posterUrl` is null, render a generic video placeholder.
- When `transcodeStatus === 'done'`: mount a DOM overlay `<video>` element via `OverlayCompositor`, positioned over the Pixi canvas. Attach `hls.js` to `hlsManifestUrl`. Apply `autoplay` / `muted` / `loop` from `VideoObject` settings in the Yjs slide model.
- Poster frame dimensions: `width` × `height` from the response (filled by ffprobe after transcode).

### editor-ui (`editor-ui` agent)

- Drop zone must accept `video/*` MIME types (the server already accepts them via tus).
- After upload (tus returns `transcodeStatus: 'pending'`): show a persistent "Processing video..." card in the asset panel.
- Poll `GET /api/media/:assetId/video-info` every 2 s until `transcodeStatus === 'done'` or `'failed'`.
- On `'done'`: swap the progress card for the thumbnail (`thumbnailUrl`) and mark the asset as ready.
- On `'failed'`: show an error state with `transcodeError` text.

### present mode

- Same as renderer. DOM overlay `<video>` positioned by `OverlayCompositor`.
- `hls.js` attached to `hlsManifestUrl`. Segment URLs are resolved relative to the manifest — `hls.js` inherits query params from the master URL, which works with MinIO presigned URLs.
