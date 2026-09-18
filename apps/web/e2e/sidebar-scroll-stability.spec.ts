/**
 * e2e/sidebar-scroll-stability.spec.ts
 *
 * The slide panel must never move by itself.
 *
 * Reported as "when I scroll down the sidebar throws me back up". Nothing in
 * the app scrolls it: every thumbnail that finishes rendering replaces that
 * row's placeholder `<div>` with an `<img>`, and Chrome's scroll anchoring
 * reads the swap as content shifting under the reader and rewrites
 * `scrollTop` to compensate. No scroll event, no call into our code. On a
 * 47-slide deck whose thumbnails arrive over several seconds it accumulated
 * to ~535px of drift. The panel now sets `overflow-anchor: none`.
 *
 * Two guards, because they are worth different amounts:
 *
 *  1. The panel's computed `overflow-anchor` is `none`. Cheap, deterministic,
 *     and it is what stops someone deleting the class in a tidy-up.
 *  2. The panel does not move on its own while thumbnails arrive. This is the
 *     real property, but a generated deck does NOT reproduce the bug — a deck
 *     built from `addText` renders its thumbnails too fast and drifts 0px even
 *     with the fix reverted, which was measured, not assumed. The reproduction
 *     needs a deck heavy with real images and fonts: the reported one drifted
 *     535px with anchoring on and 0px with it off. So point DECK_ID at such a
 *     deck to get the strong check; without it this half is a smoke test.
 */

import { test, expect } from '@playwright/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const SLIDE_COUNT = 47
const OBJECTS_PER_SLIDE = 18
/** Where we park the list before watching it. */
const SCROLL_TO = 1500
/** Sub-pixel rounding is fine; anything a reader would notice is not. */
const MAX_DRIFT_PX = 2

interface Sample {
  t: number
  st: number
  sh: number
  ch: number
  rows: number
  imgs: number
  sumH: number
}

interface Mover {
  t: number
  kind: string
  idx?: number
  to?: number
}

test('the slide panel does not scroll itself while thumbnails load', async ({ page }) => {
  test.setTimeout(180_000)

  let deckId = process.env['DECK_ID'] ?? ''
  if (deckId === '') {
    const res = await page.request.post(`${API_BASE}/decks`, {
      data: { title: 'scroll-stability' },
    })
    expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
    deckId = ((await res.json()) as { id: string }).id

    await page.goto(`/deck/${deckId}`)
    await expect
      .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
      .toBe('object')

    // Text, not rectangles. Pixi rasterises HTMLText through an SVG
    // foreignObject, which is slow and asynchronous — that is what makes a
    // real deck's thumbnails arrive one at a time over several seconds, and
    // the drift only builds while they are still arriving.
    await page.evaluate(
      ({ count, per }) => {
        const api = window.__narrative_test_api!
        while (api.listSlideIds().length < count) api.addSlide()
        api.listSlideIds().forEach((sid, s) => {
          for (let i = 0; i < per; i++) {
            api.addText(
              {
                id: `t-${s}-${i}`,
                x: 40 + (i % 3) * 620,
                y: 40 + Math.floor(i / 3) * 170,
                w: 600,
                h: 160,
                text: `Slide ${s + 1} block ${i + 1} — the quick brown fox jumps over the lazy dog, twice over.`,
              },
              sid,
            )
          }
        })
      },
      { count: SLIDE_COUNT, per: OBJECTS_PER_SLIDE },
    )

    await expect
      .poll(() => page.evaluate(() => window.__narrative_test_api!.listSlideIds().length), {
        timeout: 90_000,
      })
      .toBe(SLIDE_COUNT)
  }

  // Cold load — this is the load the report is about.
  await page.goto(`/deck/${deckId}`)
  await page.waitForSelector('ul.scrollbar-narrative [data-slide-id]', { timeout: 30_000 })

  // Guard 1 — the property that makes the panel immune, whatever the deck.
  const anchor = await page.evaluate(
    () => getComputedStyle(document.querySelector('ul.scrollbar-narrative')!).overflowAnchor,
  )
  expect(anchor, 'the slide panel must opt out of browser scroll anchoring').toBe('none')

  await page.evaluate(() => {
    const w = window as unknown as {
      __probe: { samples: Sample[]; movers: Mover[]; t0: number; stop?: () => void }
    }
    const ul = document.querySelector('ul.scrollbar-narrative')! as HTMLElement
    w.__probe = { samples: [], movers: [], t0: performance.now() }

    // Record anything that could legitimately move the list, so a failure
    // says whether the app scrolled it or the browser did.
    const origSIV = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element, ...a: unknown[]) {
      const rows = [...document.querySelectorAll('[data-slide-id]')]
      w.__probe.movers.push({
        t: Math.round(performance.now() - w.__probe.t0),
        kind: 'scrollIntoView',
        idx: rows.indexOf(this),
      })
      // @ts-expect-error variadic pass-through to the native method
      return origSIV.apply(this, a)
    }
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
    Object.defineProperty(ul, 'scrollTop', {
      configurable: true,
      get() {
        return desc.get!.call(this)
      },
      set(v: number) {
        w.__probe.movers.push({
          t: Math.round(performance.now() - w.__probe.t0),
          kind: 'set scrollTop',
          to: v,
        })
        desc.set!.call(this, v)
      },
    })

    let running = true
    const tick = (): void => {
      if (!running) return
      const rows = document.querySelectorAll('[data-slide-id]')
      let sumH = 0
      rows.forEach((r) => {
        sumH += (r as HTMLElement).getBoundingClientRect().height
      })
      w.__probe.samples.push({
        t: Math.round(performance.now() - w.__probe.t0),
        st: Math.round(ul.scrollTop),
        sh: ul.scrollHeight,
        ch: ul.clientHeight,
        rows: rows.length,
        imgs: document.querySelectorAll('ul.scrollbar-narrative img').length,
        sumH: Math.round(sumH),
      })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    w.__probe.stop = () => {
      running = false
    }
  })

  await page.evaluate((to) => {
    document.querySelector('ul.scrollbar-narrative')!.scrollTop = to
  }, SCROLL_TO)

  // Hold still while the deck finishes rendering its thumbnails.
  await page.waitForTimeout(12_000)

  const { samples, movers } = await page.evaluate(() => {
    const w = window as unknown as {
      __probe: { samples: Sample[]; movers: Mover[]; stop: () => void }
    }
    w.__probe.stop()
    return { samples: w.__probe.samples, movers: w.__probe.movers }
  })

  const afterScroll = samples.filter((s) => s.st > 0)
  const start = afterScroll[0]
  expect(start, 'probe captured no frames after the scroll').toBeDefined()
  const last = afterScroll[afterScroll.length - 1]!

  // Guard 2 is only meaningful while thumbnails were still arriving.
  expect(
    last.imgs,
    'no thumbnails arrived during the watch window — nothing was exercised',
  ).toBeGreaterThan(4)

  let worst = start!
  for (const s of afterScroll) {
    if (Math.abs(s.st - start!.st) > Math.abs(worst.st - start!.st)) worst = s
  }
  const drift = Math.abs(worst.st - start!.st)

  console.log(
    `[scroll-stability] start=${start!.st} worst=${worst.st} drift=${drift} ` +
      `scrollHeight ${start!.sh}->${last.sh} rowHeightSum ${start!.sumH}->${last.sumH} ` +
      `thumbnails ${start!.imgs}->${last.imgs}`,
  )
  console.log('[scroll-stability] movers:', JSON.stringify(movers))

  expect(
    drift,
    `the panel moved ${drift}px on its own; movers recorded: ${JSON.stringify(movers)}`,
  ).toBeLessThanOrEqual(MAX_DRIFT_PX)
})
