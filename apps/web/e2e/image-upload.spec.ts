import { Buffer } from 'node:buffer'
import { test, expect, type Page } from './fixtures/test'
import { PNG } from 'pngjs'

/**
 * E2E: uploading an image to a fresh deck should paint real pixels in the
 * editor — both on the main Pixi canvas and on the sidebar thumbnail.
 *
 * Strategy: one full-page screenshot before the drop, one 5 s after. Count
 * "meaningfully coloured" pixels on each — if the image really painted
 * anywhere, the delta is > 500; a grey placeholder changes nothing.
 */

/** 64×64 solid-blue PNG (generated via pngjs) — big enough for the coloured-pixel
 *  heuristic to clear its +500 threshold, small enough to keep the upload fast. */
function makeBluePng(): Buffer {
  const size = 64
  const png = new PNG({ width: size, height: size })
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2
      png.data[idx] = 30
      png.data[idx + 1] = 90
      png.data[idx + 2] = 230
      png.data[idx + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

async function createDeckAndOpen(page: Page): Promise<string> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'E2E Test Deck' },
  })
  if (!res.ok()) {
    throw new Error(`POST /decks failed: ${res.status()} ${await res.text()}`)
  }
  const { id } = (await res.json()) as { id: string }
  await page.goto(`/deck/${id}`)
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(1200)
  return id
}

async function dropImage(page: Page, buffer: Buffer): Promise<void> {
  // Bypass the flaky DataTransfer simulation — drive the hidden <input type="file">
  // used by the toolbar's Insert Image button. Same code path ends at
  // startUpload → tus → onDone → addMediaObject.
  const fileInput = page.locator('input[type="file"][accept^="image"]').first()
  await fileInput.setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer })
}

/** Count pixels with visible saturation (non-grey, non-near-black/white). */
function countColouredPixelsInPng(pngBuffer: Buffer): number {
  const png = PNG.sync.read(pngBuffer)
  const d = png.data
  let count = 0
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!,
      g = d[i + 1]!,
      b = d[i + 2]!,
      a = d[i + 3]!
    if (a < 200) continue
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (max - min > 30 && max > 20 && min < 235) count++
  }
  return count
}

test('uploaded image paints pixels somewhere on the page', async ({ page }) => {
  test.setTimeout(60_000)

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      errors.push(`console.${msg.type()}: ${msg.text()}`)
    }
  })
  page.on('requestfailed', (req) => {
    errors.push(`requestfailed: ${req.method()} ${req.url()} — ${req.failure()?.errorText ?? '?'}`)
  })
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.request().method()} ${r.url()}`)
  })

  await createDeckAndOpen(page)

  const before = await page.screenshot({ fullPage: true })
  const baseline = countColouredPixelsInPng(before)
  console.log(`[e2e] baseline coloured pixels (fullPage): ${baseline}`)

  await dropImage(page, makeBluePng())

  let after = baseline
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await page.waitForTimeout(500)
    const shot = await page.screenshot({ fullPage: true })
    after = countColouredPixelsInPng(shot)
    if (after > baseline + 500) break
  }
  console.log(`[e2e] after coloured pixels (fullPage): ${after}`)

  expect(
    after,
    `image never painted — baseline=${baseline}, after=${after}. errors: ${errors.join(' | ') || 'none'}`,
  ).toBeGreaterThan(baseline + 500)
})
