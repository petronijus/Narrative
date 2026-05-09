/**
 * renderer-visual.spec.ts
 *
 * Two complementary regression strategies for the Pixi renderer:
 *
 * 1. **Sampled-thumbnail tests** — read a single pixel out of the live
 *    PNG thumbnail to verify the configured colour actually paints.
 *    These are the same shape as the existing
 *    `inspector-flows.spec.ts::Renderer paint smoke` and run reliably
 *    cross-platform because they only assert "this region has roughly
 *    this colour". They run by default in CI.
 *
 * 2. **Pixel-perfect screenshot tests** — guarded by
 *    `RUN_VISUAL_BASELINES=1` env var because they require committed
 *    baseline images and break on any GPU / font-rendering difference
 *    between machines. The first run with `--update-snapshots` creates
 *    the baselines; subsequent runs compare.
 *
 *    The screenshot tests target the canvas region only (not the whole
 *    page) to minimise chrome / timestamp / peer-chip drift. They're
 *    most useful as a design-review tool — a maintainer runs them
 *    locally on a clean macOS environment, commits the baselines, and
 *    the team uses them to catch gross rendering bugs.
 *
 * Why a pragmatic mix and not pure pixel-perfect: cross-machine pixel
 * diff requires (a) a controlled CI runner with stable graphics,
 * (b) a workflow for updating baselines on intentional changes,
 * (c) acceptance that ~10% of "fails" are environment noise. The
 * sampled-thumbnail tests catch the high-value regressions (object
 * doesn't paint, wrong colour, wrong layer order) without the maintenance
 * burden.
 */

import { expect, test, type Page } from '@playwright/test'

const ENABLE_PIXEL_PERFECT = process.env['RUN_VISUAL_BASELINES'] === '1'

async function createDeck(page: Page): Promise<string> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'renderer-visual-spec' },
  })
  const { id } = (await res.json()) as { id: string }
  return id
}

async function openDeckReady(page: Page, deckId: string): Promise<void> {
  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 15_000 })
    .toBe('object')
}

/** Sample one pixel out of the live slide thumbnail (a real rendered PNG). */
async function sampleThumbnailPixel(
  page: Page,
  slideX: number,
  slideY: number,
): Promise<{ r: number; g: number; b: number } | null> {
  return page.evaluate(
    async ({ slideX, slideY }) => {
      const img = Array.from(document.querySelectorAll('img')).find(
        (el) => el.src.startsWith('data:image/png') && el.naturalWidth > 100,
      ) as HTMLImageElement | undefined
      if (img === undefined) return null
      return new Promise<{ r: number; g: number; b: number }>((resolve, reject) => {
        const tmp = new Image()
        tmp.onload = () => {
          const c = document.createElement('canvas')
          c.width = tmp.naturalWidth
          c.height = tmp.naturalHeight
          const ctx = c.getContext('2d')!
          ctx.drawImage(tmp, 0, 0)
          // Map slide-space coords (1280×720 default) to thumbnail px.
          const px = Math.round((slideX / 1280) * tmp.naturalWidth)
          const py = Math.round((slideY / 720) * tmp.naturalHeight)
          const d = ctx.getImageData(px, py, 1, 1).data
          resolve({ r: d[0]!, g: d[1]!, b: d[2]! })
        }
        tmp.onerror = () => reject(new Error('thumbnail load failed'))
        tmp.src = img.src
      })
    },
    { slideX, slideY },
  )
}

// ---------------------------------------------------------------------------
// Sampled-thumbnail regression suite (always on)
// ---------------------------------------------------------------------------

test.describe('Renderer — sampled thumbnail regressions', () => {
  test('rectangle paints inside its declared bbox, not outside', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    // Place a green rectangle at (200,150)..(800,550). Background stays white.
    await page.evaluate(() => {
      window.__narrative_test_api!.addRect({
        id: 'rv-rect',
        x: 200,
        y: 150,
        w: 600,
        h: 400,
        fill: 0x22aa22, // green, distinct from white bg + from any default red
      })
    })

    await expect
      .poll(
        () =>
          page.evaluate(
            (id) => window.__narrative_test_api!.sceneGraphHasMountedNode(id),
            'rv-rect',
          ),
        { timeout: 5000 },
      )
      .toBe(true)
    await page.waitForTimeout(800) // thumbnail debounce

    // Inside the rect (centre): should be green-ish.
    const inside = await sampleThumbnailPixel(page, 500, 350)
    expect(inside).not.toBeNull()
    expect(inside!.g).toBeGreaterThan(120)
    expect(inside!.r).toBeLessThan(120)

    // Outside the rect (top-left corner of slide): should be near-white bg.
    const outside = await sampleThumbnailPixel(page, 50, 50)
    expect(outside).not.toBeNull()
    expect(outside!.r).toBeGreaterThan(220)
    expect(outside!.g).toBeGreaterThan(220)
    expect(outside!.b).toBeGreaterThan(220)
  })

  test('layer order: object added later renders on top', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    await page.evaluate(() => {
      const api = window.__narrative_test_api!
      // Bottom: red rect covering most of the slide.
      api.addRect({ id: 'rv-bottom', x: 100, y: 100, w: 1000, h: 500, fill: 0xff0000 })
      // Top: blue rect overlapping the centre.
      api.addRect({ id: 'rv-top', x: 400, y: 250, w: 400, h: 200, fill: 0x0000ff })
    })

    await expect
      .poll(
        () => page.evaluate(() => window.__narrative_test_api!.sceneGraphHasMountedNode('rv-top')),
        { timeout: 5000 },
      )
      .toBe(true)
    await page.waitForTimeout(800)

    // Centre overlap should be blue (top wins).
    const overlap = await sampleThumbnailPixel(page, 600, 350)
    expect(overlap).not.toBeNull()
    expect(overlap!.b).toBeGreaterThan(180)
    expect(overlap!.r).toBeLessThan(80)

    // Edge of bottom rect (no overlap with top): should still be red.
    const bottomOnly = await sampleThumbnailPixel(page, 200, 350)
    expect(bottomOnly).not.toBeNull()
    expect(bottomOnly!.r).toBeGreaterThan(180)
    expect(bottomOnly!.b).toBeLessThan(80)
  })

  test('updating fill colour repaints the thumbnail', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    await page.evaluate(() => {
      window.__narrative_test_api!.addRect({
        id: 'rv-recolour',
        x: 200,
        y: 200,
        w: 600,
        h: 300,
        fill: 0xff0000, // red first
      })
    })
    await page.waitForTimeout(800)

    const beforeRecolour = await sampleThumbnailPixel(page, 500, 350)
    expect(beforeRecolour!.r).toBeGreaterThan(180)

    // Recolour to blue.
    await page.evaluate(() => {
      window.__narrative_test_api!.updateObject('rv-recolour', { fill: 0x0000ff })
    })
    await page.waitForTimeout(900) // thumbnail debounce window

    const afterRecolour = await sampleThumbnailPixel(page, 500, 350)
    expect(afterRecolour!.b).toBeGreaterThan(180)
    expect(afterRecolour!.r).toBeLessThan(120)
  })
})

// ---------------------------------------------------------------------------
// Pixel-perfect baseline suite (opt-in)
// ---------------------------------------------------------------------------

test.describe('Renderer — pixel-perfect baselines (opt-in via RUN_VISUAL_BASELINES=1)', () => {
  test.skip(
    !ENABLE_PIXEL_PERFECT,
    "Set RUN_VISUAL_BASELINES=1 to enable. Cross-platform pixel diff is fragile — these run on the maintainer's machine + CI image, not contributor laptops.",
  )

  test('empty deck — first slide is blank white canvas', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)
    await page.waitForTimeout(1200)

    // Screenshot only the canvas region, not the whole page chrome.
    const canvas = page.locator('.canvas-backdrop').first()
    await expect(canvas).toHaveScreenshot('empty-deck.png', { maxDiffPixels: 100 })
  })

  test('single rectangle — known fill', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    await page.evaluate(() => {
      window.__narrative_test_api!.addRect({
        id: 'baseline-rect',
        x: 200,
        y: 150,
        w: 600,
        h: 400,
        fill: 0x3b82f6,
      })
    })
    await page.waitForTimeout(1200)

    const canvas = page.locator('.canvas-backdrop').first()
    await expect(canvas).toHaveScreenshot('rect-blue.png', { maxDiffPixels: 100 })
  })

  test('single text block — known content + size', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    await page.evaluate(() => {
      window.__narrative_test_api!.addText({
        id: 'baseline-text',
        x: 200,
        y: 250,
        w: 800,
        h: 100,
        text: 'Hello, world',
        fontSize: 48,
      })
    })
    await page.waitForTimeout(1500) // HTMLText raster needs more time than rect

    const canvas = page.locator('.canvas-backdrop').first()
    // Text rendering is the most cross-platform-fragile case; allow a
    // bigger pixel-diff threshold so anti-aliasing differences don't
    // false-positive.
    await expect(canvas).toHaveScreenshot('text-hello.png', { maxDiffPixels: 500 })
  })
})
