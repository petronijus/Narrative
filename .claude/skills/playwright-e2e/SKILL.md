---
name: playwright-e2e
description: Hands-on reference for writing and running Playwright E2E tests against the Narrative editor dev stack. Use when writing a new spec, debugging a flake, or wiring in a canvas visual assertion.
---

# Playwright E2E for Narrative

Narrative uses Playwright (chromium only, installed in `apps/web`) to verify UI features the Vitest unit tests can't catch — canvas painting, hls.js playback, drag-drop file upload, thumbnail sidebar rastering.

## Run

From the repository root, with the dev stack up (`just services`, then
`just dev` in another terminal — the recipe refuses to start otherwise):

```bash
just e2e                                  # every spec
just e2e image-upload                     # one spec file
just e2e -g "folder-tokens"               # by test name
node node_modules/@playwright/test/cli.js show-trace apps/web/test-results/<test>/trace.zip
```

`just e2e` picks the browser (Playwright's own Chromium, or the system Chrome
with video off where Playwright ships none — Ubuntu 26.04;
`tools/dev/playwright-env.sh`). Install Playwright's browser where it is
supported: `pnpm --filter web exec playwright install chromium`.

`.env` needs `BYPASS_AUTH=true`, `VITE_BYPASS_AUTH=true`,
`MINIO_ENDPOINT=http://localhost:9100`, `MINIO_PUBLIC_URL=/storage`,
`IMGPROXY_ENDPOINT=/imgproxy`, `VITE_IMGPROXY_URL=/imgproxy` (the dev `.env`
from `scripts/secrets-decrypt.sh dev` has them).

## Parallel by default

`just e2e` runs specs in parallel (`fullyParallel`, 6 workers; `PW_WORKERS=N`
or `--workers N` overrides) — every browser is the same `dev-user` on one
server and one database. So a spec seeds its own folders, decks, components
and tokens, finds them by the ids it got back (never by position in, or the
length of, a user-wide list: all folders, all decks, Drafts, access tokens,
connected apps), gives them unique names (`Date.now()`), and deletes what it
can. Decks and folders are deleted for it: specs import `test` from
`e2e/fixtures/test.ts` (ESLint refuses `test` from `@playwright/test`), which
notes every deck and folder created through Playwright's request and browser
contexts — never seed with Node's own `fetch` — and deletes them, as their
creator, when the worker is done. Tests in one file must not depend on each other either: `beforeAll`
runs once per worker, so module state set there is per worker. Wait for
conditions (`expect.poll`, `toPass`), not fixed sleeps — under parallel load
a 1.5 s "settle" is not enough. A spec that genuinely cannot share the
machine — it measures CPU or frame timing, or changes user-wide state other
specs read — gets `{ tag: '@serial' }` and runs in the `serial` project, one
test at a time, after the parallel project (alone:
`just e2e <spec> --no-deps`, otherwise the whole parallel project runs first
as its dependency). The server limits POST /access-tokens to 10 per hour per
user; the suite creates 2 per run.

## Two people in one test

Under `BYPASS_AUTH` a browser context becomes another synthetic identity
with the `narrative_dev_as` cookie (`dev-` + lowercase letters, digits,
dashes; `apps/server/src/auth/devIdentity.ts`). The server honours it on
REST, the WebSocket and tus; the web app shows that user. The identity
gets a directory entry (`<sub>@dev.narrative.test`) on its first request,
so make one request as it before inviting its address. Use fresh,
unique identities per test. Example: `e2e/folder-sharing.spec.ts`.

```ts
async function personPage(browser: Browser, sub: string): Promise<Page> {
  const context = await browser.newContext()
  await context.addCookies([
    { name: 'narrative_dev_as', value: sub, domain: 'localhost', path: '/' },
  ])
  return context.newPage()
}
```

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

## Visual assert — default: full-page screenshot + coloured-pixel count

For 95 % of "did the thing render" checks, **take one full-page screenshot
before the action and another after**, then count saturated pixels in both
PNGs. The delta tells you whether real content painted anywhere in the
editor — main canvas, sidebar thumbnail, inspector preview, all at once.
No need to probe individual Pixi contexts or DOM subtrees.

```ts
import { PNG } from 'pngjs'

function countColouredPixelsInPng(buf: Buffer): number {
  const png = PNG.sync.read(buf)
  const d = png.data
  let count = 0
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
}

// In a test:
const before = await page.screenshot({ fullPage: true })
const baseline = countColouredPixelsInPng(before)
await dropImage(page, BLUE_PNG_BASE64)
let after = baseline
const deadline = Date.now() + 15_000
while (Date.now() < deadline) {
  await page.waitForTimeout(500)
  after = countColouredPixelsInPng(await page.screenshot({ fullPage: true }))
  if (after > baseline + 500) break
}
expect(after).toBeGreaterThan(baseline + 500)
```

This is the default. Don't reach for `getImageData` on a specific canvas
unless you genuinely need per-element attribution. Pixi v8 defaults to
`preserveDrawingBuffer: false`, so `drawImage(canvas)` on the test side
captures an empty WebGL backing store — `page.screenshot` uses the
browser's screenshotter which bypasses that limitation.

`pngjs` + `@types/pngjs` are already installed in `apps/web` devDeps for
decoding screenshot buffers in Node.

### When per-element sampling IS worth it

Only when "did ANY pixel paint" isn't enough and you need to localise
the failure — e.g. "the sidebar thumbnail specifically renders vs. the
main canvas". Then use `locator.screenshot()` + the same pixel count
helper. Still probably overkill for most tasks.

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
