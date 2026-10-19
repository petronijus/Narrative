/**
 * present-smooth.spec.ts — every advance in present mode shows its slide
 * whole from its first frame (docs/plans/performance.md → D): no text that
 * appears a frame later, no grey picture placeholder, no blink when a
 * transition hands over, nothing that lands after the transition is over.
 *
 * Each editor frame of an advance is read back and averaged over 40-px cells
 * (the perf harness's frame capture, `?perf=1`); a slide is compared with
 * itself fully drawn (`captureNow` once the scene is quiet):
 *   - without a transition, every frame shows either the outgoing slide or
 *     the incoming one complete — never something in between — and once the
 *     incoming one is there it stays;
 *   - with a transition, every frame from the transition's end on (its
 *     duration and two frames) shows the incoming slide complete.
 * The decks are the present benches' (e2e/perf/lib/presentDecks.ts): text in
 * a folder font, photos, every transition kind.
 */

import type { Page } from '@playwright/test'
import { PRESENT_TRANSITIONS } from '@narrative/perf'
import type { CapturedFrame } from '../src/perf/harness'
import { expect, test } from './fixtures/test'
import { openPresentation, seedDeck, type PresentDeck } from './perf/lib/presentDecks'

/** A cell's channel mean may differ this much between two frames of the same picture. */
const TOLERANCE = 2

function maxDiff(a: CapturedFrame, b: CapturedFrame): number {
  if (a.cols !== b.cols || a.rows !== b.rows) return 255
  let max = 0
  for (let i = 0; i < a.cells.length; i++) max = Math.max(max, Math.abs(a.cells[i]! - b.cells[i]!))
  return max
}

const same = (a: CapturedFrame, b: CapturedFrame): boolean => maxDiff(a, b) <= TOLERANCE

interface Advance {
  outgoing: CapturedFrame
  frames: CapturedFrame[]
  final: CapturedFrame
  startedAt: number
}

/** Press `key`, capture every frame until slide `target` is shown and quiet, then the slide whole. */
async function advance(page: Page, key: string, target: string): Promise<Advance> {
  const outgoing = await page.evaluate(() => window.__narrative_perf_harness!.captureNow()!)
  const startedAt = await page.evaluate(() => {
    window.__narrative_perf_harness!.startFrameCapture()
    return performance.now()
  })
  await page.keyboard.press(key)
  return page.evaluate(
    async ({ target, outgoing, startedAt }) => {
      const h = window.__narrative_perf_harness!
      await new Promise<void>((resolve, reject) => {
        const end = performance.now() + 30_000
        const tick = (): void => {
          const el = document.querySelector('[data-testid="slide-container"]')
          if (el?.getAttribute('data-active-slide-id') === target) return resolve()
          if (performance.now() > end) return reject(new Error(`slide ${target} never shown`))
          requestAnimationFrame(tick)
        }
        tick()
      })
      const r = await h.settle({ quietMs: 400, timeoutMs: 60_000 })
      if (!r.ok) throw new Error(`slide ${target} did not settle: ${r.reason}`)
      const frames = h.stopFrameCapture()
      return { outgoing, frames, final: h.captureNow()!, startedAt }
    },
    { target, outgoing, startedAt },
  )
}

/** Advance through every slide and back; check each advance with `check`. */
async function pass(
  page: Page,
  deck: PresentDeck,
  check: (a: Advance, to: number, label: string) => void,
): Promise<void> {
  const n = deck.slideIds.length
  const route: Array<{ key: string; to: number }> = []
  for (let i = 1; i < n; i++) route.push({ key: 'ArrowRight', to: i })
  for (let i = n - 2; i >= 0; i--) route.push({ key: 'ArrowLeft', to: i })
  for (const { key, to } of route) {
    const a = await advance(page, key, deck.slideIds[to]!)
    check(a, to, `${key} → slide ${to + 1}`)
  }
}

/** Without a transition: only the outgoing slide, then the incoming one whole. */
function checkCut(a: Advance, label: string): void {
  expect(a.frames.length, `${label}: no frame drawn`).toBeGreaterThan(0)
  let arrived = false
  for (const [i, f] of a.frames.entries()) {
    if (same(f, a.final)) {
      arrived = true
      continue
    }
    expect(
      !arrived && same(f, a.outgoing),
      `${label}: frame ${i} of ${a.frames.length} shows neither slide whole (${maxDiff(f, a.final)} off the incoming one)`,
    ).toBe(true)
  }
  expect(arrived, `${label}: the incoming slide was never drawn whole`).toBe(true)
}

/**
 * With a transition of `durationMs`: whole from its end on — timed from the
 * transition's first frame (the first one that no longer shows the outgoing
 * slide whole), not from the key press, which the page sees a little later.
 */
function checkTransition(a: Advance, durationMs: number, label: string): void {
  expect(a.frames.length, `${label}: no frame drawn`).toBeGreaterThan(0)
  const first = a.frames.find((f) => !same(f, a.outgoing))
  expect(first, `${label}: the transition never started`).toBeDefined()
  const due = first!.at + durationMs + 2 * 17
  for (const f of a.frames.filter((f) => f.at > due))
    expect(
      maxDiff(f, a.final),
      `${label}: a frame ${Math.round(f.at - first!.at)} ms into the transition (${durationMs} ms) differs from the slide whole`,
    ).toBeLessThanOrEqual(TOLERANCE)
}

test.describe('present mode shows every slide whole', () => {
  test.setTimeout(10 * 60_000)

  test.use({ viewport: { width: 1600, height: 900 } })

  for (const kind of ['text', 'photo'] as const)
    test(`${kind} deck: every cut shows the incoming slide complete on its first frame`, async ({
      context,
      page,
    }) => {
      const deck = await seedDeck(context, kind, 'e2e present-smooth')
      await openPresentation(page, deck)
      await pass(page, deck, (a, _to, label) => checkCut(a, label))
    })

  test('transitions deck: whole from the end of every transition on', async ({ context, page }) => {
    const deck = await seedDeck(context, 'transitions', 'e2e present-smooth')
    await openPresentation(page, deck)
    await pass(page, deck, (a, to, label) => {
      const t = PRESENT_TRANSITIONS[to]!
      if (t.kind === 'none') checkCut(a, label)
      else checkTransition(a, t.durationMs, label)
    })
  })
})
