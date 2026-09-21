/**
 * e2e/sidebar-holds-position.spec.ts
 *
 * The slide panel must stay where the user put it.
 *
 * Reported as "scroll the previews to the end while they load and it throws
 * me back up; click slide 45 and it scrolls me to slide 20". Confirmed by
 * A/B: with the thumbnail renderer disabled the list holds at the end on the
 * first try; with it enabled the list walks back 2,546px in three steps that
 * trace a smooth-scroll curve — 49%, 79%, 100% — sampled through a main
 * thread the thumbnail renders keep blocking for hundreds of milliseconds at
 * a time. No script scrolls it; every scroll API was patched and stayed
 * silent. The browser does it, and it only does it while the page is jammed.
 *
 * So the check is direct: put the list at the end while the deck is still
 * rendering its thumbnails, and watch that it stays there.
 *
 * Needs a deck heavy enough to keep the renderer busy for several seconds.
 * The imported reference deck does; a generated one may not, so DECK_ID is
 * required rather than fabricated.
 */

import { test, expect } from '@playwright/test'

const DECK_ID = process.env['DECK_ID'] ?? ''
/** Rounding and momentum noise; a real jump is hundreds of pixels. */
const TOLERANCE_PX = 8

test.use({ viewport: { width: 2400, height: 2000 } })

test('the slide panel stays at the end while thumbnails are still rendering', async ({ page }) => {
  test.setTimeout(180_000)
  test.skip(DECK_ID === '', 'set DECK_ID to a deck whose thumbnails take seconds to render')

  await page.goto(`/deck/${DECK_ID}`)
  await page.waitForSelector('ul.scrollbar-narrative [data-slide-id]', { timeout: 30_000 })

  // While the renderer is still working through the deck.
  await page.waitForTimeout(2_000)
  const busy = await page.evaluate(
    () =>
      document.querySelectorAll('ul.scrollbar-narrative img[src^="data:image/png"]').length <
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
      imgs: document.querySelectorAll('ul.scrollbar-narrative img[src^="data:image/png"]').length,
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
