/**
 * e2e/sidebar-holds-position.spec.ts
 *
 * The slide panel must stay where the user put it.
 *
 * Reported as "scroll the previews to the end while they load and it throws
 * me back up; click slide 45 and it scrolls me to slide 20". The cause was
 * PixiJS text measurement: every `HTMLText` render appends an SVG with a
 * `<style>` to `document.body` for one layout, and that CSS used a bare
 * `div { font-size: …; line-height: …; width: … }` selector — document-global,
 * and stronger than any layered utility class. For that one layout every div
 * on the page was a heading, the panel's rows changed height, the list's
 * scrollHeight dropped, and with the list at its end the browser clamped the
 * scroll position to the new maximum. The style went away, the content came
 * back, the position did not. One clamp per text object rendered. Bisected:
 * thumbnails of empty slides held the position, of everything except text
 * held it, of text walked it back 3,216px. `renderer/pixiHtmlTextStyleScope`
 * scopes those selectors to Pixi's own SVG.
 *
 * Two guards. The panel opts out of scroll anchoring, so no transient row
 * change can ever be "compensated" into a move — cheap and deterministic.
 * And the real property: put the list at the end while the deck is still
 * rendering its thumbnails, and watch that it stays there.
 *
 * Needs a deck heavy enough to keep the renderer busy for several seconds
 * and with text on its slides. The imported reference deck does; a generated
 * one may not, so DECK_ID is required rather than fabricated.
 */

import { test, expect } from './fixtures/test'

const DECK_ID = process.env['DECK_ID'] ?? ''
/** Rounding and momentum noise; a real jump is hundreds of pixels. */
const TOLERANCE_PX = 8

test.use({ viewport: { width: 2400, height: 2000 } })

test('the slide panel stays at the end while thumbnails are still rendering', async ({ page }) => {
  test.setTimeout(180_000)
  test.skip(DECK_ID === '', 'set DECK_ID to a deck whose thumbnails take seconds to render')

  await page.goto(`/deck/${DECK_ID}`)
  await page.waitForSelector('ul.scrollbar-narrative [data-slide-id]', { timeout: 30_000 })

  const anchor = await page.evaluate(
    () => getComputedStyle(document.querySelector('ul.scrollbar-narrative')!).overflowAnchor,
  )
  expect(anchor, 'the slide panel must opt out of browser scroll anchoring').toBe('none')

  // While the renderer is still working through the deck.
  await page.waitForTimeout(2_000)
  const busy = await page.evaluate(
    () =>
      document.querySelectorAll('ul.scrollbar-narrative img[src^="blob:"]').length <
      document.querySelectorAll('ul.scrollbar-narrative [data-slide-id]').length,
  )
  expect(busy, 'thumbnails had already finished — the deck is too light to exercise this').toBe(
    true,
  )

  const trace = await page.evaluate(async () => {
    const u = document.querySelector('ul.scrollbar-narrative') as HTMLElement
    const events: { t: number; st: number }[] = []
    const t0 = performance.now()
    u.addEventListener(
      'scroll',
      () => events.push({ t: Math.round(performance.now() - t0), st: Math.round(u.scrollTop) }),
      {
        passive: true,
      },
    )
    u.scrollTop = u.scrollHeight
    const target = Math.round(u.scrollTop)
    let min = target
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 50))
      const st = Math.round(u.scrollTop)
      if (st < min) min = st
    }
    return {
      target,
      min,
      events,
      imgs: document.querySelectorAll('ul.scrollbar-narrative img[src^="blob:"]').length,
    }
  })

  console.log(
    `[hold] put at ${trace.target}, lowest seen ${trace.min} (drift ${trace.target - trace.min}px), ` +
      `thumbnails at end ${trace.imgs}, scroll events: ${trace.events.map((e) => `${e.t}:${e.st}`).join(' ')}`,
  )
  expect(
    trace.target - trace.min,
    `the panel walked back ${trace.target - trace.min}px on its own after being put at the end`,
  ).toBeLessThanOrEqual(TOLERANCE_PX)
})
