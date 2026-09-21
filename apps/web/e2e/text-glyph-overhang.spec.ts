/**
 * e2e/text-glyph-overhang.spec.ts
 *
 * A line box is `lineHeight` tall; the ink in it is `ascent + descent`. Set a
 * line height below that — a PowerPoint `<a:lnSpc><a:spcPct val="75000"/>`
 * does exactly this — and CSS lets the glyphs stick out above and below the
 * box. The clip mask started at y=0, so the overhang was shaved: the flat top
 * of a capital S, reported on an imported slide. It looked correct while
 * editing, because the DOM overlay draws without the mask.
 *
 * Underneath that was a worse one: `CanvasTextMetrics.measureFont` takes a
 * CSS font shorthand, and it was being handed a TextStyle object. The canvas
 * could not parse it and measured the default ~10px face, so every allowance
 * derived from the metrics — the descender room as well — was about a
 * fifteenth of what it should be, at any font size.
 */

import { test, expect } from '@playwright/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'

test.use({ viewport: { width: 1800, height: 1200 } })

test('glyphs overhanging a short line box are not shaved by the mask', async ({ page }) => {
  test.setTimeout(120_000)

  const res = await page.request.post(`${API_BASE}/decks`, { data: { title: 'overhang' } })
  expect(res.ok()).toBe(true)
  const { id: deckId } = (await res.json()) as { id: string }

  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')

  const objectId = 'tight-leading'
  await page.evaluate((id) => {
    const api = window.__narrative_test_api!
    const slide = api.listSlideIds()[0]!
    api.addText({ id, x: 100, y: 100, w: 1200, h: 400, text: 'Sell' }, slide)
    // A big face on a line box far shorter than its own ink — the shape the
    // reported slide is in.
    api.updateObject(id, { fontSize: 160, lineHeight: 0.9, vAlign: 'top' }, slide)
  }, objectId)

  const read = async (): Promise<{ maskTop: number; maskH: number } | null> =>
    page.evaluate((id) => {
      const c = window.__narrative_scene_graph?.getContainer(id) as unknown as
        | {
            children?: {
              constructor?: { name?: string }
              getLocalBounds?: () => { y: number; height: number }
            }[]
          }
        | undefined
      const mask = (c?.children ?? []).find((k) => k.constructor?.name === 'Graphics')
      const b = mask?.getLocalBounds?.()
      if (b === undefined) return null
      return { maskTop: Math.round(b.y), maskH: Math.round(b.height) }
    }, objectId)

  let m: Awaited<ReturnType<typeof read>> = null
  for (let i = 0; i < 40; i++) {
    m = await read()
    if (m !== null && m.maskH > 0) break
    await page.waitForTimeout(500)
  }
  expect(m, 'the mask was never built').not.toBeNull()

  console.log(`[overhang] mask top=${m!.maskTop} height=${m!.maskH}`)
  expect(
    m!.maskTop,
    'the mask must start above the box so glyphs overhanging a short line box survive',
  ).toBeLessThan(0)
})
