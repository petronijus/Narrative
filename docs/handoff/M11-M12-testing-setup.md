# M11 + M12 testing setup — handoff for tomorrow's session

**Date:** 2026-04-21
**Branch:** main
**Status:** Infra ready — awaiting manual browser test

## Context

M11 (images) and M12 (video) are both implemented and committed (`7792299`, `b6df387`, `ba7b8f2`). Session ran out of time before end-to-end browser testing. This doc captures the current running state so testing can resume cleanly tomorrow.

## Required env vars

`.env` at repo root was extended this session with M10/M11/M12 values — already committed to working tree. Relevant sections:

- `AUTHENTIK_SECRET_KEY`, `AUTHENTIK_POSTGRES_PASSWORD` (not used while `BYPASS_AUTH=true`, but docker-compose parse needs them)
- `MINIO_ROOT_USER=narrative`, `MINIO_ROOT_PASSWORD=narrative_dev_password`
- `MEDIA_BUCKET=narrative-media`
- `IMGPROXY_KEY`, `IMGPROXY_SALT` (random hex, dev-only)
- `MEDIA_REDIS_URL=redis://127.0.0.1:6380`
- `WORKER_CONCURRENCY=2`

## Docker services

Start from `infra/`:

```bash
cd infra
docker compose --env-file ../.env up -d postgres minio minio-init imgproxy media-redis video-worker
```

Expected state (`docker ps`):

| Service              | Port(s)               | Health  |
| -------------------- | --------------------- | ------- |
| infra-postgres-1     | 5433 → 5432           | healthy |
| infra-minio-1        | 9100 (API), 9101 (UI) | healthy |
| infra-imgproxy-1     | 8080                  | running |
| infra-media-redis-1  | 6380 → 6379           | healthy |
| infra-video-worker-1 | —                     | running |

Verify worker: `docker logs infra-video-worker-1` → `[video-worker] Ready — queue="video-transcode" concurrency=2`.

## Dev server

```bash
pnpm install   # only if node_modules stale
pnpm dev
```

Expected:

- Vite: http://localhost:5173
- API: http://localhost:3001 (BYPASS_AUTH=true — all requests are dev-user)
- Hocuspocus WS: ws://localhost:3002

## Fixes applied this session

1. **`apps/video-worker/Dockerfile`** (committed pending):
   - `CMD` updated to `dist/apps/video-worker/src/index.js` — TS emits nested paths because baseUrl spans repo root (path alias to `@narrative/shared`).
   - Copies compiled `@narrative/shared` JS over the pnpm symlink target and rewrites `main`/`exports` from `.ts` → `.js` so the runtime `node` resolves it.

2. **`.env`** — added M10/M11/M12 vars listed above.

## Test plan for tomorrow

### M11 — images

1. Open http://localhost:5173, log in (bypass is on, so any click works), create a deck.
2. Drag-drop a `.jpg` or `.png` onto the canvas.
3. Expect: upload progress card in corner, image appears on canvas rendered via imgproxy signed URL.
4. Refresh page → image persists (Y.Doc + object_state row).
5. Present mode (`F`) → image renders without imgproxy flash.

### M12 — video

1. Drag-drop an `.mp4` (or `.mov`, `.webm`) onto the canvas.
2. Expect: placeholder shows "Processing…" label with poster pending.
3. Watch `docker logs -f infra-video-worker-1` — ffmpeg should run 3 HLS variants (360p/720p/1080p) + poster + thumbnail.
4. After ~10–60s (depends on video length), renderer auto-updates via 5s polling → shows poster.
5. Enter present mode → preload progress overlay → HLS playback via hls.js overlay.

### Edge cases to poke

- Upload > 500MB → 413 rejection from tus.
- Non-media MIME (e.g. `.pdf`) → rejected by upload plugin.
- Refresh during upload → resumable via tus.
- Video with unusual aspect ratio (e.g. 9:16) → fit math.

## Known quirks

- Windows pnpm occasionally throws `ERR_PNPM_ENOENT` with `_tmp_NNNN` dirs (AV scanning). Retry or reboot fixes it.
- `useVideoInfo` has 3 tests marked `it.skip` — fake-timer flakiness on Windows. Behavior covered via `VideoOverlay.test.tsx`.

## Next steps after testing

- If OK → M13 (transitions between slides, present-mode timeline integration).
- If bugs → file under `docs/handoff/M12-bugfix-*.md`.
