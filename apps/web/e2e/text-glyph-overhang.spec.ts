/**
 * e2e/text-glyph-overhang.spec.ts
 *
 * Line height must never change the shape of the glyphs.
 *
 * A line box is `lineHeight` tall; the ink in it is `ascent + descent`. Set
 * the line height below that — a PowerPoint `<a:lnSpc><a:spcPct val="75000"/>`
 * does exactly this, and the Inspector lets you go far lower — and CSS lets
 * the glyphs stick out above and below their box. Two things then used to
 * shave them: the clip mask, which began at y=0, and the SVG Pixi rasterises
 * HTMLText through, which was exactly the line boxes tall, so the overhang
 * above the first line was never in the texture at all. The first was fixed
 * and a test of the mask's geometry passed while the second still cut the
 * top off a capital S — which is why this spec no longer asks the mask
 * anything and reads the pixels instead.
 *
 * The invariant is font-agnostic: the ink of "Sell" rendered at a tight line
 * height must be exactly as tall as at a generous one. And to prove the tight
 * case is the case — that the glyphs really do overhang — the ink must start
 * above the text node's origin there, and inside it at the generous height.
 */

import { test, expect } from './fixtures/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'

/** How much taller or shorter the ink may read between the two line heights. */
const INK_TOLERANCE_PX = 2

test.use({ viewport: { width: 1800, height: 1200 } })

interface Ink {
  /** Topmost inked row, relative to the text node's origin (negative = above it). */
  top: number
  /** Bottommost inked row, same origin. */
  bottom: number
}

test('a short line box does not cut the glyphs it cannot hold', async ({ page }) => {
  test.setTimeout(120_000)

  const res = await page.request.post(`${API_BASE}/decks`, { data: { title: 'overhang' } })
  expect(res.ok()).toBe(true)
  const { id: deckId } = (await res.json()) as { id: string }

  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')

  const objectId = 'tight-leading'
  const FONT_SIZE = 160
  await page.evaluate((id) => {
    const api = window.__narrative_test_api!
    api.addText({ id, x: 100, y: 100, w: 1200, h: 400, text: 'Sell' }, api.listSlideIds()[0]!)
  }, objectId)
  await expect
    .poll(() =>
      page.evaluate((id) => window.__narrative_test_api!.getObject(id) !== null, objectId),
    )
    .toBe(true)
  await page.evaluate(
    ([id, fontSize]) => {
      window.__narrative_test_api!.updateObject(id, { fontSize, lineHeight: 1.5, vAlign: 'top' })
    },
    [objectId, FONT_SIZE] as const,
  )

  // Render the text container into a texture whose frame reaches well above
  // and below the box, then scan the alpha channel for the inked rows. The
  // frame is in the container's own space, so row 0 of the scan is the box
  // top; the mask and the texture both apply, exactly as on the canvas.
  const scan = async (): Promise<Ink | null> =>
    page.evaluate((id) => {
      const sg = window.__narrative_scene_graph as unknown as
        | {
            app: {
              renderer: {
                extract: {
                  pixels: (o: { target: unknown; frame: unknown; resolution: number }) => {
                    pixels: Uint8ClampedArray
                    width: number
                    height: number
                  }
                }
              }
            }
            getContainer: (id: string) => unknown
          }
        | undefined
      const container = sg?.getContainer(id) as
        | {
            getLocalBounds: () => {
              rectangle: { x: number; y: number; width: number; height: number }
            }
          }
        | undefined
      if (sg === undefined || container === undefined) return null
      const REACH = 200
      const frame = container.getLocalBounds().rectangle
      frame.x = 0
      frame.y = -REACH
      frame.width = 1200
      frame.height = 400 + REACH * 2
      const { pixels, width, height } = sg.app.renderer.extract.pixels({
        target: container,
        frame,
        resolution: 1,
      })
      let top = -1
      let bottom = -1
      for (let row = 0; row < height; row++) {
        let inked = false
        for (let col = 0; col < width; col++) {
          if (pixels[(row * width + col) * 4 + 3]! > 64) {
            inked = true
            break
          }
        }
        if (!inked) continue
        if (top === -1) top = row
        bottom = row
      }
      if (top === -1) return null
      return { top: top - REACH, bottom: bottom - REACH }
    }, objectId)

  // HTMLText rasterises asynchronously; wait for ink, then for two identical
  // consecutive scans so a half-landed texture cannot be the measurement.
  // The text is added at the default 32px and patched to 160px a moment
  // later; a scan of the small face would settle just as well and prove
  // nothing, so only ink at least half an em tall counts.
  const settled = async (): Promise<Ink> => {
    let last: Ink | null = null
    for (let i = 0; i < 60; i++) {
      const now = await scan()
      if (
        now !== null &&
        last !== null &&
        now.top === last.top &&
        now.bottom === last.bottom &&
        now.bottom - now.top + 1 >= FONT_SIZE / 2
      ) {
        return now
      }
      last = now
      await page.waitForTimeout(250)
    }
    // Say where it got stuck: the data, the style, or the texture.
    const state = await page.evaluate((id) => {
      const o = window.__narrative_test_api!.getObject(id) as { fontSize?: number } | null
      const c = window.__narrative_scene_graph?.getContainer(id) as unknown as
        | {
            children?: {
              constructor?: { name?: string }
              style?: { fontSize?: number; padding?: number }
              texture?: { width?: number; height?: number }
            }[]
          }
        | undefined
      const tn = (c?.children ?? []).find((k) => k.constructor?.name === 'HTMLText')
      return {
        dataFontSize: o?.fontSize,
        styleFontSize: tn?.style?.fontSize,
        stylePadding: tn?.style?.padding,
        texture: `${tn?.texture?.width}×${tn?.texture?.height}`,
      }
    }, objectId)
    throw new Error(
      `the text never rendered to a stable set of pixels at the patched size: ${JSON.stringify(state)}, last scan ${JSON.stringify(last)}`,
    )
  }

  const roomy = await settled()
  console.log(`[overhang] line-height 1.5: ink rows ${roomy.top}..${roomy.bottom}`)
  expect(roomy.top, 'at a generous line height the ink sits inside the box').toBeGreaterThanOrEqual(
    0,
  )

  await page.evaluate((id) => {
    window.__narrative_test_api!.updateObject(id, { lineHeight: 0.5 })
  }, objectId)
  // The patch rebuilds the style and the texture; let the old pixels go
  // before we start looking for stable new ones.
  await page.waitForTimeout(500)

  const tight = await settled()
  console.log(`[overhang] line-height 0.5: ink rows ${tight.top}..${tight.bottom}`)
  expect(
    tight.top,
    'at half the font size the line box cannot hold the glyphs: the ink must start above the box',
  ).toBeLessThan(0)

  const roomyHeight = roomy.bottom - roomy.top + 1
  const tightHeight = tight.bottom - tight.top + 1
  expect(
    Math.abs(tightHeight - roomyHeight),
    `the ink is ${tightHeight}px tall at line-height 0.5 against ${roomyHeight}px at 1.5 — the line height cut the glyphs`,
  ).toBeLessThanOrEqual(INK_TOLERANCE_PX)
})
