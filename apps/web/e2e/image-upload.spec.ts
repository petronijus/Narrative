import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

/**
 * E2E: uploading an image to a fresh deck should paint real pixels in the
 * editor — both on the main Pixi canvas and on the sidebar thumbnail.
 *
 * Strategy: one full-page screenshot before the drop, one 5 s after. Count
 * "meaningfully coloured" pixels on each — if the image really painted
 * anywhere, the delta is > 500; a grey placeholder changes nothing.
 */

// 10×10 solid-blue PNG — small, saturated, easy to detect.
const BLUE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAHklEQVR42mNk+M9Qz0AEYBxVSF+FLP8Z/' +
  '8NcRawKAKoIBQXZR+QoAAAAAElFTkSuQmCC'

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

async function dropImage(page: Page, pngBase64: string): Promise<void> {
  const dataTransferHandle = await page.evaluateHandle((b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const file = new File([bytes], 'test.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    return dt
  }, pngBase64)

  const canvas = page.locator('canvas').first()
  await canvas.dispatchEvent('dragenter', { dataTransfer: dataTransferHandle })
  await canvas.dispatchEvent('dragover', { dataTransfer: dataTransferHandle })
  await canvas.dispatchEvent('drop', { dataTransfer: dataTransferHandle })
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
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })

  await createDeckAndOpen(page)

  const before = await page.screenshot({ fullPage: true })
  const baseline = countColouredPixelsInPng(before)
  console.log(`[e2e] baseline coloured pixels (fullPage): ${baseline}`)

  await dropImage(page, BLUE_PNG_BASE64)

  let after = baseline
  const deadline = Date.now() + 15_000
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
