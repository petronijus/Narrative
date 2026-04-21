import { test, expect, type Page } from '@playwright/test'

/**
 * E2E: image upload renders a non-grey raster on the canvas.
 *
 * Captures imgproxy requests + PixiJS warnings so a failure gives the root
 * cause, not just "gray rectangle".
 */

const BLUE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAHklEQVR42mNk+M9Qz0AEYBxVSF+FLP8Z/' +
  '8NcRawKAKoIBQXZR+QoAAAAAElFTkSuQmCC'

async function createDeckAndOpen(page: Page): Promise<string> {
  const api = page.request
  const res = await api.post('http://localhost:3001/decks', {
    data: { title: 'E2E Test Deck' },
  })
  if (!res.ok()) {
    throw new Error(`POST /decks failed: ${res.status()} ${await res.text()}`)
  }
  const body = (await res.json()) as { id: string }
  const deckId = body.id
  await page.goto(`/deck/${deckId}`)
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(1200)
  return deckId
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
    }
    let count = 0
    const d = img.data
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
  })
}

test('uploaded image renders a non-grey texture on the editor canvas', async ({ page }) => {
  test.setTimeout(60_000)

  const errors: string[] = []
  const pixiWarnings: string[] = []
  const consoleAll: string[] = []
  const imgproxyReqs: { url: string; status?: number; method: string }[] = []

  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    const txt = msg.text()
    consoleAll.push(`[${msg.type()}] ${txt.slice(0, 300)}`)
    if (msg.type() === 'error') errors.push(`console.error: ${txt}`)
    if (/PixiJS Warning/i.test(txt)) pixiWarnings.push(txt)
  })
  page.on('request', (req) => {
    const u = req.url()
    if (/\/imgproxy\//.test(u) || /\/uploads\//.test(u) || /tus/i.test(u)) {
      imgproxyReqs.push({ url: u, method: req.method() })
    }
  })
  page.on('response', async (res) => {
    const u = res.url()
    if (/\/imgproxy\//.test(u)) {
      const entry = imgproxyReqs.find((r) => r.url === u && r.status === undefined)
      if (entry) entry.status = res.status()
      else imgproxyReqs.push({ url: u, method: res.request().method(), status: res.status() })
    }
  })

  await createDeckAndOpen(page)

  const baseline = await countColouredPixels(page)
  console.log(`[e2e] baseline coloured pixels: ${baseline}`)

  await dropImage(page, BLUE_PNG_BASE64)

  // Poll for the texture to paint.
  let after = baseline
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    await page.waitForTimeout(500)
    after = await countColouredPixels(page)
    if (after > baseline + 500) break
  }

  console.log(`[e2e] after coloured pixels: ${after}`)
  console.log(`[e2e] imgproxy/upload requests (${imgproxyReqs.length}):`)
  for (const r of imgproxyReqs.slice(0, 30)) {
    console.log(`  ${r.method} ${r.status ?? '???'} ${r.url}`)
  }
  console.log(`[e2e] PixiJS warnings (${pixiWarnings.length}):`)
  for (const w of pixiWarnings.slice(0, 20)) console.log(`  ${w.slice(0, 220)}`)
  console.log(`[e2e] last console lines:`)
  for (const l of consoleAll.slice(-60)) console.log(`  ${l}`)

  // Diagnostics: inspect whether the upload actually mounted an image object.
  const diag = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img')).map((i) => ({
      src: i.src.slice(0, 180),
      complete: i.complete,
      naturalWidth: i.naturalWidth,
      naturalHeight: i.naturalHeight,
    }))
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null
    return {
      imgs,
      canvasSize: canvas ? { w: canvas.width, h: canvas.height } : null,
      thumbnailCanvases: document.querySelectorAll('canvas').length,
    }
  })
  console.log(`[e2e] diag:`, JSON.stringify(diag, null, 2))

  expect(
    after,
    `expected image painted (baseline=${baseline}, after=${after}). ` +
      `imgproxy reqs: ${imgproxyReqs.length}, pixi warnings: ${pixiWarnings.length}. ` +
      `errors: ${errors.join(' | ') || 'none'}`,
  ).toBeGreaterThan(baseline + 500)
})
