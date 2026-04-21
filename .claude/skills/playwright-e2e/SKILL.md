---
name: playwright-e2e
description: Hands-on reference for writing and running Playwright E2E tests against the Narrative editor dev stack. Use when writing a new spec, debugging a flake, or wiring in a canvas visual assertion.
---

# Playwright E2E for Narrative

Narrative uses Playwright (chromium only, installed in `apps/web`) to verify UI features the Vitest unit tests can't catch — canvas painting, hls.js playback, drag-drop file upload, thumbnail sidebar rastering.

## Run

From `apps/web/`:

```bash
# Run all specs
node ../../node_modules/@playwright/test/cli.js test

# Single spec
node ../../node_modules/@playwright/test/cli.js test e2e/image-upload.spec.ts

# Open failed trace
node ../../node_modules/@playwright/test/cli.js show-trace test-results/<test>/trace.zip
```

Prerequisites (always verify before running):

- Docker services (`docker ps` → 5 healthy).
- Dev server running at :3001 (`curl http://localhost:3001/health` → `{"status":"ok"}`).
- Vite running at :5173.
- `.env` has `BYPASS_AUTH=true`, `VITE_BYPASS_AUTH=true`, `MINIO_ENDPOINT=http://localhost:9100`, `MINIO_PUBLIC_URL=/storage`, `IMGPROXY_ENDPOINT=/imgproxy`, `VITE_IMGPROXY_URL=/imgproxy`.

Browser install: `node node_modules/@playwright/test/cli.js install chromium` (from repo root; installs to `%LOCALAPPDATA%\ms-playwright`).

## Canonical setup: deterministic deck creation

Don't rely on dashboard UI.

```ts
async function createDeckAndOpen(page: Page): Promise<string> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'E2E Test Deck' },
  })
  if (!res.ok()) throw new Error(`POST /decks: ${res.status()} ${await res.text()}`)
  const { id } = (await res.json()) as { id: string }
  await page.goto(`/decks/${id}`)
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(800) // Pixi init
  return id
}
```

## Drop a file onto the canvas

Narrative uses native DOM listeners (not React synthetic events) for drag-drop since commit a3a9114. React's `dispatchEvent('drop', { dataTransfer: ... })` does NOT reach the native `addEventListener('drop', ...)` handler — must go through the real event path.

```ts
async function dropImage(page: Page, pngBase64: string): Promise<void> {
  const dt = await page.evaluateHandle((b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const file = new File([bytes], 'test.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    return dt
  }, pngBase64)

  const canvas = page.locator('canvas').first()
  await canvas.dispatchEvent('dragenter', { dataTransfer: dt })
  await canvas.dispatchEvent('dragover', { dataTransfer: dt })
  await canvas.dispatchEvent('drop', { dataTransfer: dt })
}
```

If `dispatchEvent` doesn't fire handlers (happens with some React overlays), fall back to `page.evaluate` that queries `document.elementFromPoint` and calls `el.dispatchEvent(new DragEvent(...))` directly.

## Visual assert on Pixi canvas

Can't query DOM for "is there an image". Sample pixels:

```ts
async function countColouredPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas) return 0
    const tmp = document.createElement('canvas')
    tmp.width = canvas.width
    tmp.height = canvas.height
    const ctx = tmp.getContext('2d')!
    ctx.drawImage(canvas, 0, 0)
    let img: ImageData
    try {
      img = ctx.getImageData(0, 0, tmp.width, tmp.height)
    } catch {
      return -1
    } // tainted
    let count = 0
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]!,
        g = d[i + 1]!,
        b = d[i + 2]!,
        a = d[i + 3]!
      if (a < 200) continue
      const max = Math.max(r, g, b),
        min = Math.min(r, g, b)
      if (max - min > 30 && max > 20 && min < 235) count++
    }
    return count
  })
}
```

Baseline empty slide → drop image → wait ~4s → count again. `after > baseline + 500` is a reliable threshold for "image actually painted, not grey placeholder".

**Pixi caveat**: if `-1` comes back, the canvas is tainted. Pixi v8 defaults to `preserveDrawingBuffer: false`; screenshot via `page.screenshot({ clip: canvasBoundingBox })` instead and do image diff via `@playwright/test` toHaveScreenshot.

## Capture console + page errors

```ts
const errors: string[] = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
})
// After interactions:
console.log('page errors:', errors.join(' | '))
```

Include in `expect` failure messages so triage doesn't require re-running.

## Debugging a failing test

1. `Read` the PNG at `test-results/<test>/test-failed-1.png` — describe what you see.
2. Open trace: `show-trace test-results/<test>/trace.zip` (opens in browser; user is driving so you'll see it).
3. Grep `error-context.md` next to screenshot for last known page state.
4. If flaky: increase `waitForTimeout` only as last resort; prefer `expect(...).toPass({ timeout })` polling.

## Seeding a "done" video asset for present-mode tests

If you need an HLS-ready video without running ffmpeg in-test:

```bash
# Insert row
docker exec infra-postgres-1 psql -U narrative -d narrative -c "
INSERT INTO media_assets (id, deck_id, uploader_user_id, mime_type, size_bytes,
  storage_key, kind, transcode_status, hls_manifest_key, poster_key, width, height, duration_sec)
VALUES ('seed-vid', '<DECK_ID>', 'dev-user', 'video/mp4', 0,
  'decks/<DECK_ID>/uploads/seed-vid/original.mp4', 'video', 'done',
  'decks/<DECK_ID>/videos/seed-vid/master.m3u8',
  'decks/<DECK_ID>/videos/seed-vid/poster.jpg', 1280, 720, 10);
"

# Drop a minimal manifest into MinIO
docker exec infra-minio-1 sh -c '
  mc alias set local http://localhost:9000 narrative narrative_dev_password >/dev/null 2>&1
  echo "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\n360p/playlist.m3u8" > /tmp/m.m3u8
  mc cp /tmp/m.m3u8 local/narrative-media/decks/<DECK_ID>/videos/seed-vid/master.m3u8
'
```

## Anti-patterns

- Asking the user for console logs when Playwright could capture them.
- Commit `test-results/`, `playwright-report/`, `trace.zip`. Add to `.gitignore` if missing.
- Opening real URLs (GitHub, imgproxy.photo, etc.) in tests — breaks offline CI.
- `page.waitForTimeout(>5000)` — almost always a sign of a missing polling wait.
- Tests that mutate shared fixture data without cleanup (each test must be independently runnable).
