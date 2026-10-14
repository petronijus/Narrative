/**
 * e2e/text-overflow-clip.spec.ts
 *
 * Text must never be cut off by its own box.
 *
 * A PowerPoint frame carrying `<a:spAutoFit/>` stores the height PowerPoint
 * computed for its own line spacing. We lay the same text out slightly taller
 * and used to mask away whatever did not fit, slicing the last line through
 * the middle of its glyphs — reported repeatedly on an imported deck.
 * PowerPoint never clips an overflowing text frame; it draws past the shape.
 *
 * Built here rather than taken from a fixture, so it tests the invariant
 * ("the mask follows the text") instead of one particular deck.
 */

import { test, expect } from '@playwright/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'

test.use({ viewport: { width: 1800, height: 1200 } })

test('text taller than its box is not clipped away', async ({ page }) => {
  test.setTimeout(120_000)

  const res = await page.request.post(`${API_BASE}/decks`, { data: { title: 'overflow-clip' } })
  expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
  const { id: deckId } = (await res.json()) as { id: string }

  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')

  // A box far too short for its text — the shape an spAutoFit import lands in.
  const objectId = 'overflowing-text'
  await page.evaluate((id) => {
    const api = window.__narrative_test_api!
    const slide = api.listSlideIds()[0]!
    api.addText(
      {
        id,
        x: 100,
        y: 100,
        w: 900,
        h: 60,
        text: 'Point of this analysis is to assess technical quality of second delivery, highlight potential development risks and evaluate our synergetic approach for both brands.',
      },
      slide,
    )
  }, objectId)

  const measure = async (): Promise<{ textH: number; maskH: number } | null> =>
    page.evaluate((id) => {
      const sg = window.__narrative_scene_graph
      const container = sg?.getContainer(id) as unknown as
        { children?: { height?: number; constructor?: { name?: string } }[] } | undefined
      const kids = container?.children ?? []
      const textNode = kids.find((c) => c.constructor?.name === 'HTMLText')
      const maskNode = kids.find((c) => c.constructor?.name === 'Graphics')
      if (textNode === undefined || maskNode === undefined) return null
      const textH = Math.round(textNode.height ?? 0)
      if (textH === 0) return null
      return { textH, maskH: Math.round(maskNode.height ?? 0) }
    }, objectId)

  let m: Awaited<ReturnType<typeof measure>> = null
  for (let i = 0; i < 40; i++) {
    m = await measure()
    if (m !== null) break
    await page.waitForTimeout(500)
  }
  expect(m, 'the text node was never measured').not.toBeNull()

  console.log(`[clip] box=60 text=${m!.textH} mask=${m!.maskH}`)
  expect(
    m!.textH,
    'the text should overflow this box — otherwise nothing is tested',
  ).toBeGreaterThan(60)
  expect(
    m!.maskH,
    `text is ${m!.textH}px tall but the mask is ${m!.maskH}px — the overflow is being cut off`,
  ).toBeGreaterThanOrEqual(m!.textH)
})
