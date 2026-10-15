/**
 * e2e/text-line-spacing-fidelity.spec.ts
 *
 * Imported text must be laid out at the height PowerPoint laid it out at.
 *
 * A frame carrying `<a:spAutoFit/>` stores the height PowerPoint computed
 * for its own line spacing, so the frame IS the reference measurement. On
 * slide 4 of the reference deck that frame is 600 units tall for 8 lines at
 * 60px with two 20px paragraph gaps: 8 × 60 × 1.162 + 40 = 597.8, where
 * 1.162 is Brand Sans's normal line height in ems. We rendered the same text
 * at a flat 1.2 and got 616 — 3% tall, and once clipping was removed it
 * simply spilled past the frame.
 *
 * The resolver in lib/fontLineMetrics uses the font file's own hhea metrics
 * (registered by the folder-font loader) — not the browser's `normal`, which
 * for this font is the 0.977 typo value because it sets USE_TYPO_METRICS —
 * and that brings the two into agreement. This spec pins it on the real deck,
 * so it needs DECK_ID and the deck's folder font; if that face never loads
 * here the measurement would be of a fallback and the spec skips.
 */

import { test, expect } from './fixtures/test'

const DECK_ID = process.env['DECK_ID'] ?? ''
/** PowerPoint's own number for the frame, and how far we allow ourselves. */
const POWERPOINT_FRAME_HEIGHT = 600
const TOLERANCE_PX = 6

test.use({ viewport: { width: 2200, height: 1400 } })

test('an spAutoFit frame renders at the height PowerPoint sized it to', async ({ page }) => {
  test.setTimeout(120_000)
  test.skip(DECK_ID === '', 'set DECK_ID to the imported reference deck')

  await page.goto(`/deck/${DECK_ID}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')

  // The frame's family is a folder webfont. Its declared metrics only exist
  // once the loader has installed it, and until then the text is laid out in
  // a fallback face — so wait for the face itself, not for a timeout.
  const family = await page.evaluate(() => {
    const api = window.__narrative_test_api!
    const sid = api.listSlideIds()[3]!
    for (const id of api.objectIds(sid)) {
      const o = api.getObject(id, sid) as {
        type?: string
        height?: number
        fontFamily?: string
      } | null
      if (o !== null && o.type === 'text' && Math.round(o.height ?? 0) === 600)
        return o.fontFamily ?? ''
    }
    return ''
  })
  expect(family, 'the 600-unit frame on slide 4 was not found').not.toBe('')
  const faceLoaded = await page
    .waitForFunction(
      (fam) =>
        [...document.fonts].some(
          (f) => f.family.replace(/^"|"$/g, '') === fam && f.status === 'loaded',
        ),
      family,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false)
  test.skip(
    !faceLoaded,
    `the folder font "${family}" never loaded here; the measurement would be of a fallback`,
  )

  await page
    .locator('[data-slide-id]')
    .nth(3)
    .click({ position: { x: 60, y: 20 } })
  // Let the post-load refresh rebuild the text with the declared metrics.
  await page.waitForTimeout(2500)

  const measure = async (): Promise<{ boxH: number; textH: number } | null> =>
    page.evaluate(() => {
      const api = window.__narrative_test_api
      const sg = window.__narrative_scene_graph
      if (api === undefined || sg === undefined) return null
      const sid = api.listSlideIds()[3]
      if (sid === undefined) return null
      // The one frame on that slide that is 600 tall.
      for (const id of api.objectIds(sid)) {
        const o = api.getObject(id, sid) as { type?: string; height?: number } | null
        if (o === null || o.type !== 'text' || Math.round(o.height ?? 0) !== 600) continue
        const c = sg.getContainer(id) as unknown as
          { children?: { height?: number; constructor?: { name?: string } }[] } | undefined
        const tn = (c?.children ?? []).find((k) => k.constructor?.name === 'HTMLText')
        const textH = Math.round(tn?.height ?? 0)
        if (textH === 0) return null
        return { boxH: Math.round(o.height ?? 0), textH }
      }
      return null
    })

  let m: Awaited<ReturnType<typeof measure>> = null
  for (let i = 0; i < 40; i++) {
    m = await measure()
    if (m !== null) break
    await page.waitForTimeout(500)
  }
  expect(m, 'the 600-unit frame on slide 4 was not found or never measured').not.toBeNull()

  console.log(`[fidelity] frame ${m!.boxH}, text laid out at ${m!.textH}`)
  expect(
    Math.abs(m!.textH - POWERPOINT_FRAME_HEIGHT),
    `text is ${m!.textH}px tall against PowerPoint's ${POWERPOINT_FRAME_HEIGHT}`,
  ).toBeLessThanOrEqual(TOLERANCE_PX)
})
