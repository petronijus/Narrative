/**
 * canvas-sharpness-final.spec.ts
 *
 * Verifies that the Pixi renderer dynamically adjusts its resolution
 * based on the editor zoom level so text and graphics stay sharp when
 * zoom > 1.
 *
 * Resolution is capped by a pixel budget (25M pixels) rather than a
 * fixed multiplier, so the effective cap depends on the canvas size.
 *
 * Run: PLAYWRIGHT_USE_SYSTEM_CHROME=1 npx playwright test --config apps/web/playwright.config.ts canvas-sharpness-final
 */

import { test, expect } from './fixtures/test'

const MAX_PIXELS = 25_000_000

async function createDeck(page: import('@playwright/test').Page) {
  const resp = await page.request.post('http://localhost:3001/decks', {
    headers: { 'Content-Type': 'application/json' },
    data: { title: 'Canvas Sharpness Test' },
  })
  expect(resp.ok()).toBeTruthy()
  const { id } = await resp.json()
  return id as string
}

async function gotoEditorAtZoom(
  page: import('@playwright/test').Page,
  deckId: string,
  zoom: number,
) {
  await page.goto(`/deck/${deckId}`)
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 })
  await page.evaluate((z) => {
    window.sessionStorage.setItem('narrative:zoom-level', String(z))
  }, zoom)
  await page.reload()
  await expect(page.locator('canvas')).toBeVisible({ timeout: 15_000 })
  // Resolution update is debounced (150 ms). Wait for it to settle.
  await page.waitForTimeout(2000)
}

function getCanvasMetrics(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const dpr = window.devicePixelRatio
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const perf = (window as any).__narrative_perf
    const renderer = perf?.app?.renderer
    return {
      dpr,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
      backingRatioW: +(canvas.width / canvas.clientWidth).toFixed(3),
      rendererResolution: renderer?.resolution ?? null,
      totalPixels: canvas.width * canvas.height,
    }
  })
}

function expectedResolution(dpr: number, zoom: number, clientW: number, clientH: number): number {
  const pixelCap = Math.sqrt(MAX_PIXELS / (clientW * clientH))
  return Math.min(pixelCap, dpr * Math.max(1, zoom))
}

test.describe('Canvas Sharpness — zoom-adaptive resolution', () => {
  test.describe.configure({ timeout: 60_000 })

  test('zoom=1 DPR=2: resolution equals DPR', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    const deckId = await createDeck(page)
    await gotoEditorAtZoom(page, deckId, 1)

    const m = await getCanvasMetrics(page)
    console.log('zoom=1 DPR=2:', JSON.stringify(m))

    expect(m.rendererResolution).toBeCloseTo(2, 1)
    expect(m.backingRatioW).toBeCloseTo(2, 1)
    expect(m.totalPixels).toBeLessThan(MAX_PIXELS * 1.05)
    await ctx.close()
  })

  test('zoom=2 DPR=1: resolution doubles to 2', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    })
    const page = await ctx.newPage()
    const deckId = await createDeck(page)
    await gotoEditorAtZoom(page, deckId, 2)

    const m = await getCanvasMetrics(page)
    console.log('zoom=2 DPR=1:', JSON.stringify(m))

    const expected = expectedResolution(1, 2, m.clientWidth, m.clientHeight)
    expect(m.rendererResolution).toBeCloseTo(expected, 1)
    expect(m.totalPixels).toBeLessThan(MAX_PIXELS * 1.05)
    await ctx.close()
  })

  test('zoom=2 DPR=2: resolution capped by pixel budget', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    const deckId = await createDeck(page)
    await gotoEditorAtZoom(page, deckId, 2)

    const m = await getCanvasMetrics(page)
    console.log('zoom=2 DPR=2:', JSON.stringify(m))

    // dpr*zoom = 4, but pixel budget caps it lower
    const expected = expectedResolution(2, 2, m.clientWidth, m.clientHeight)
    expect(m.rendererResolution).toBeCloseTo(expected, 0)
    expect(m.totalPixels).toBeLessThan(MAX_PIXELS * 1.05)
    await ctx.close()
  })

  test('zoom=0.5: resolution stays at DPR (no downscale)', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    const deckId = await createDeck(page)
    await gotoEditorAtZoom(page, deckId, 0.5)

    const m = await getCanvasMetrics(page)
    console.log('zoom=0.5 DPR=2:', JSON.stringify(m))

    expect(m.rendererResolution).toBeCloseTo(2, 1)
    expect(m.totalPixels).toBeLessThan(MAX_PIXELS * 1.05)
    await ctx.close()
  })

  test('total buffer never exceeds pixel budget', async ({ browser }) => {
    // Four zoom levels, each a load and a reload of the editor painting a
    // buffer of up to 25M pixels: ~25 s a level on the MacBook (2026-10-07).
    test.setTimeout(180_000)
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    const deckId = await createDeck(page)

    for (const zoom of [1, 2, 3, 4]) {
      await gotoEditorAtZoom(page, deckId, zoom)
      const m = await getCanvasMetrics(page)
      console.log(`zoom=${zoom} DPR=2: ${m.totalPixels} pixels, res=${m.rendererResolution}`)
      expect(m.totalPixels).toBeLessThan(MAX_PIXELS * 1.05)
    }
    await ctx.close()
  })

  test('no blur-inducing CSS on canvas element', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    const deckId = await createDeck(page)
    await gotoEditorAtZoom(page, deckId, 2)

    const cssCheck = await page.evaluate(() => {
      const canvas = document.querySelector('canvas') as HTMLCanvasElement
      const cs = window.getComputedStyle(canvas)
      const blurSources: string[] = []
      let el: HTMLElement | null = canvas
      let depth = 0
      while (el && depth < 15) {
        const s = window.getComputedStyle(el)
        if (el === canvas && s.transform !== 'none')
          blurSources.push(`canvas has transform: ${s.transform}`)
        if (s.filter !== 'none' && s.filter.includes('blur'))
          blurSources.push(`${el.tagName} has filter: ${s.filter}`)
        el = el.parentElement
        depth++
      }
      return { canvasTransform: cs.transform, blurSources }
    })

    expect(cssCheck.canvasTransform).toBe('none')
    expect(cssCheck.blurSources).toEqual([])
    await ctx.close()
  })
})
