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
 * A zoom on a live slide does not re-rasterise every text in one frame:
 * the texts get the new resolution a batch per frame, those on screen first
 * (SceneGraph.restageTextResolution, docs/plans/canvas-performance.md step
 * 3). The last test checks that every text still ends up drawn at it.
 *
 * Run: PLAYWRIGHT_USE_SYSTEM_CHROME=1 npx playwright test --config apps/web/playwright.config.ts canvas-sharpness-final
 */

import { test, expect } from './fixtures/test'
import { provisionDeckWithText } from './fixtures/provisionDeck'

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
  // The resolution commits 300 ms after the last zoom input (Canvas.tsx). Wait for it to settle.
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

/**
 * The canvas's resolution: the device's at every zoom, up to 8 (ADR 0020 —
 * the canvas draws the region the window shows, so its backing store no
 * longer grows with the zoom and needs no pixel cap on the resolution).
 */
function expectedResolution(dpr: number, zoom: number): number {
  return Math.min(8, dpr * zoom)
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

    const expected = expectedResolution(1, 2)
    expect(m.rendererResolution).toBeCloseTo(expected, 1)
    expect(m.totalPixels).toBeLessThan(MAX_PIXELS * 1.05)
    await ctx.close()
  })

  test('zoom=2 DPR=2: resolution is the device resolution, the backing store stays in budget', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    const deckId = await createDeck(page)
    await gotoEditorAtZoom(page, deckId, 2)

    const m = await getCanvasMetrics(page)
    console.log('zoom=2 DPR=2:', JSON.stringify(m))

    // dpr*zoom = 4: the canvas draws the region in view, so no cap is needed
    const expected = expectedResolution(2, 2)
    expect(m.rendererResolution).toBeCloseTo(expected, 1)
    expect(m.totalPixels).toBeLessThan(MAX_PIXELS * 1.05)
    await ctx.close()
  })

  test('zoom=0.5: resolution is the device resolution (no canvas shrunk by the compositor)', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    const deckId = await createDeck(page)
    await gotoEditorAtZoom(page, deckId, 0.5)

    const m = await getCanvasMetrics(page)
    console.log('zoom=0.5 DPR=2:', JSON.stringify(m))

    expect(m.rendererResolution).toBeCloseTo(expectedResolution(2, 0.5), 1)
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

  test('the canvas is drawn texel for device pixel, no blur', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    const deckId = await createDeck(page)
    await gotoEditorAtZoom(page, deckId, 2)

    const cssCheck = await page.evaluate(() => {
      const canvas = document.querySelector('.artboard canvas') as HTMLCanvasElement
      const blurSources: string[] = []
      // The canvas may carry a transform (ADR 0020: its box sits at whole CSS
      // px of the zoomed artboard, a translate and scale about its corner put
      // its backing store on the device grid) — sharp exactly when every
      // texel lands on one device pixel: the drawn size is the backing
      // store's, the corner on a whole device px.
      const dpr = window.devicePixelRatio
      const r = canvas.getBoundingClientRect()
      const off = (v: number): number => Math.abs(v - Math.round(v))
      if (
        Math.abs(r.width * dpr - canvas.width) > 0.01 ||
        Math.abs(r.height * dpr - canvas.height) > 0.01
      )
        blurSources.push(
          `canvas drawn ${r.width * dpr}×${r.height * dpr} device px for a ${canvas.width}×${canvas.height} backing store`,
        )
      if (off(r.left * dpr) > 0.01 || off(r.top * dpr) > 0.01)
        blurSources.push(`canvas corner off the device grid: ${r.left * dpr}, ${r.top * dpr}`)
      let el: HTMLElement | null = canvas
      let depth = 0
      while (el && depth < 15) {
        const s = window.getComputedStyle(el)
        if (s.filter !== 'none' && s.filter.includes('blur'))
          blurSources.push(`${el.tagName} has filter: ${s.filter}`)
        el = el.parentElement
        depth++
      }
      return { blurSources }
    })

    expect(cssCheck.blurSources).toEqual([])
    await ctx.close()
  })

  test('a live zoom redraws every text at the new resolution, off screen up to the cap', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await provisionDeckWithText(page, {
      title: 'Canvas Sharpness — live zoom',
      objectId: 'sharp-seed',
      text: 'seed',
      x: 10,
      y: 10,
      width: 100,
      height: 40,
    })
    // Texts over the whole slide: at 300 % most of them are off screen.
    await page.evaluate(() => {
      const api = window.__narrative_test_api!
      for (let i = 0; i < 24; i++) {
        api.addText({
          id: `sharp-${i}`,
          x: 40 + (i % 6) * 300,
          y: 60 + Math.floor(i / 6) * 250,
          w: 260,
          h: 80,
          fontSize: 28,
          text: `Line ${i} of sharp text`,
        })
      }
    })

    /** Every text node of the scene: the resolution it is set to and the one its texture has. */
    const texts = (): Promise<{
      renderer: number
      pending: number
      nodes: Array<{ res: number | null; texRes: number | null; landed: boolean }>
    }> =>
      page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi internals: _resolution, _gpuData
        const sg = window.__narrative_scene_graph as any
        const renderer = sg.getApp().renderer
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nodes: any[] = []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const walk = (c: any): void => {
          if (c.anchor !== undefined && '_didTextUpdate' in c) nodes.push(c)
          for (const ch of c.children ?? []) walk(ch)
        }
        walk(sg.getRoot())
        return {
          renderer: renderer.resolution as number,
          pending: sg.pendingTextRestage as number,
          nodes: nodes.map((n) => {
            const gpu = n._gpuData?.[renderer.uid]
            return {
              res: n._resolution as number | null,
              texRes: (gpu?.texture?.source?._resolution as number | undefined) ?? null,
              landed:
                gpu !== undefined &&
                gpu.generatingTexture !== true &&
                gpu.currentKey === n.styleKey,
            }
          }),
        }
      })

    const allAt = async (): Promise<string> => {
      const t = await texts()
      // Off screen a text may stay at the cap (2.2, Canvas.tsx
      // OFFSCREEN_TEXT_RESOLUTION; ADR 0020): in view it gets the renderer's.
      const floor = Math.min(t.renderer, 2.2) - 0.01
      const off = t.nodes.filter(
        (n) =>
          !n.landed ||
          n.res === null ||
          n.res < floor ||
          n.res > t.renderer + 0.01 ||
          n.texRes === null ||
          Math.abs(n.texRes - n.res) > 0.01,
      )
      return t.nodes.length >= 25 && t.pending === 0 && off.length === 0
        ? 'ok'
        : `${off.length}/${t.nodes.length} texts not at ${t.renderer}, ${t.pending} pending`
    }
    await expect.poll(allAt, { timeout: 15_000 }).toBe('ok')
    const before = (await texts()).renderer

    // Zoom in on the slide's centre with the wheel, as a person does.
    const box = (await page.locator('.artboard').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.down('ControlOrMeta')
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, -100)
      await page.waitForTimeout(30)
    }
    await page.keyboard.up('ControlOrMeta')

    await expect
      .poll(async () => (await texts()).renderer, { timeout: 10_000 })
      .toBeGreaterThan(before + 0.5)
    await expect.poll(allAt, { timeout: 15_000 }).toBe('ok')
  })
})
