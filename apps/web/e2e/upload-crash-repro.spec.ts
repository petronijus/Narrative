/**
 * e2e/upload-crash-repro.spec.ts
 *
 * Diagnostic: reproduce "file upload is crashing" bug.
 * Tests both paths:
 *   1. Toolbar hidden <input type="file"> → setInputFiles
 *   2. Native drag-and-drop onto the canvas container
 *
 * Captures all console errors, unhandled rejections, network failures (4xx/5xx,
 * requestfailed), and full stack traces.
 *
 * Does NOT assert visual correctness — only crash detection.
 */

import { Buffer } from 'node:buffer'
import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal 4×4 solid-red PNG. */
function makeRedPng(): Buffer {
  const size = 4
  const png = new PNG({ width: size, height: size })
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2
      png.data[idx] = 220
      png.data[idx + 1] = 30
      png.data[idx + 2] = 30
      png.data[idx + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

async function createDeck(page: import('@playwright/test').Page): Promise<string> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'upload-crash-repro' },
  })
  if (!res.ok()) {
    throw new Error(`POST /decks failed: ${res.status()} ${await res.text()}`)
  }
  const { id } = (await res.json()) as { id: string }
  await page.goto(`/deck/${id}`)
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 })
  // Let the editor fully settle — WS connection, Pixi init
  await page.waitForTimeout(2_000)
  return id
}

interface CollectedErrors {
  pageErrors: string[]
  consoleErrors: string[]
  networkFails: string[]
  http4xx5xx: string[]
}

function attachErrorCollectors(page: import('@playwright/test').Page): CollectedErrors {
  const out: CollectedErrors = {
    pageErrors: [],
    consoleErrors: [],
    networkFails: [],
    http4xx5xx: [],
  }

  page.on('pageerror', (err) => {
    out.pageErrors.push(`${err.message}\n${err.stack ?? ''}`)
  })

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      out.consoleErrors.push(msg.text())
    }
    // Also capture unhandled promise rejection echoes
    if (msg.type() === 'warning' && msg.text().includes('Unhandled')) {
      out.consoleErrors.push(`[WARN] ${msg.text()}`)
    }
  })

  page.on('requestfailed', (req) => {
    out.networkFails.push(
      `requestfailed: ${req.method()} ${req.url()} — ${req.failure()?.errorText ?? '?'}`,
    )
  })

  page.on('response', (r) => {
    if (r.status() >= 400) {
      out.http4xx5xx.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`)
    }
  })

  return out
}

// ---------------------------------------------------------------------------
// Test 1: Toolbar hidden file input
// ---------------------------------------------------------------------------

test('toolbar image-upload: no crash', async ({ page }) => {
  test.setTimeout(45_000)

  const errs = attachErrorCollectors(page)
  await createDeck(page)

  const pngBuf = makeRedPng()

  // Locate the hidden <input type="file" accept="image/*"> wired to the Toolbar
  const fileInput = page.locator('input[type="file"][accept^="image"]').first()

  // Trigger file selection — this fires the onChange → startUpload → tus.Upload.start()
  await fileInput.setInputFiles({ name: 'toolbar-test.png', mimeType: 'image/png', buffer: pngBuf })

  // Wait up to 20 s for the upload to complete (status=done) or any error to appear
  // We look for either: UploadProgressCard disappears (done/dismissed) OR error card shows.
  await page.waitForTimeout(10_000)

  // Take a diagnostic screenshot regardless
  await page.screenshot({
    path: 'test-results/upload-crash-repro/toolbar-after-upload.png',
    fullPage: true,
  })

  console.log('[repro] pageErrors:', errs.pageErrors)
  console.log('[repro] consoleErrors:', errs.consoleErrors)
  console.log('[repro] networkFails:', errs.networkFails)
  console.log('[repro] http4xx5xx:', errs.http4xx5xx)

  const allErrors = [
    ...errs.pageErrors,
    ...errs.consoleErrors,
    ...errs.networkFails,
    ...errs.http4xx5xx,
  ]

  expect(
    allErrors.filter(
      (e) =>
        // Filter to only fatal signals — not routine 401/CORS warnings
        e.includes('pageerror') ||
        errs.pageErrors.includes(e) ||
        errs.networkFails.some((n) => e.startsWith(n.split(':')[0])) ||
        errs.http4xx5xx.some((h) => h.startsWith('HTTP 5')),
    ).length,
    `Toolbar upload produced errors:\n${allErrors.join('\n')}`,
  ).toBe(0)
})

// ---------------------------------------------------------------------------
// Test 2: Native drag-and-drop
// ---------------------------------------------------------------------------

test('drag-drop image upload: no crash', async ({ page }) => {
  test.setTimeout(45_000)

  const errs = attachErrorCollectors(page)
  await createDeck(page)

  const pngBuf = makeRedPng()
  const base64 = pngBuf.toString('base64')

  // Find the canvas container div that UploadDropZone attaches to
  // It wraps the <canvas> element
  const canvasContainer = page.locator('[data-testid="canvas-container"]').first()
  // Fallback: the direct parent of the first canvas
  const target =
    (await canvasContainer.count()) > 0 ? canvasContainer : page.locator('canvas').first()

  const box = await target.boundingBox()
  if (!box) throw new Error('canvas container not found / not visible')

  const dropX = box.x + box.width / 2
  const dropY = box.y + box.height / 2

  // Dispatch native drag events with a DataTransfer containing the PNG file
  await page.evaluate(
    async ({ base64Png, dropX, dropY }) => {
      const binaryStr = atob(base64Png)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'image/png' })
      const file = new File([blob], 'dragdrop-test.png', { type: 'image/png' })

      const dt = new DataTransfer()
      dt.items.add(file)

      const el = document.elementFromPoint(dropX, dropY) ?? document.body

      const makeEvent = (type: string) =>
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })

      el.dispatchEvent(makeEvent('dragenter'))
      el.dispatchEvent(makeEvent('dragover'))
      await new Promise((r) => setTimeout(r, 80))
      el.dispatchEvent(makeEvent('drop'))
    },
    { base64Png: base64, dropX, dropY },
  )

  await page.waitForTimeout(10_000)

  await page.screenshot({
    path: 'test-results/upload-crash-repro/dragdrop-after-upload.png',
    fullPage: true,
  })

  console.log('[repro] pageErrors:', errs.pageErrors)
  console.log('[repro] consoleErrors:', errs.consoleErrors)
  console.log('[repro] networkFails:', errs.networkFails)
  console.log('[repro] http4xx5xx:', errs.http4xx5xx)

  const allErrors = [
    ...errs.pageErrors,
    ...errs.networkFails,
    ...errs.http4xx5xx.filter((e) => e.includes('HTTP 5')),
  ]

  expect(allErrors.length, `Drag-drop upload produced errors:\n${allErrors.join('\n')}`).toBe(0)
})
