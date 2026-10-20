/**
 * present.spec.ts — present mode, layer I (docs/plans/performance.md → D,
 * P0). Each run opens the presentation, waits until it is ready (the
 * preparing overlay gone, the first slide fully shown and quiet), then
 * drives a pass — every slide forward, back to the first, a jump, a build,
 * a video — and records every frame of it. Smooth means: no frame missed,
 * no long task, and no work after ready — no text rasterised, no texture
 * uploaded, nothing mounted, no picture decoded, no request, no thumbnail
 * rendered (catalog/interaction.ts → PRESENT_WORK, budgeted).
 *
 * The decks (packages/perf/src/scenes.ts → present*Ops), seeded through the
 * command API once per side:
 *   - text: 12 slides in a folder font (the block font fixture), backgrounds, page numbers;
 *   - photo: 12 slides, 12 distinct 3000 × 2000 photos, three a slide, a link on slides 1 and 9;
 *   - transitions: none, fade, push ×4, cube, magic;
 *   - builds: afterPrevious chains, onClick steps (clicked), withPrevious groups, moveTo;
 *   - video: a 10 s 1080p H.264 between two text slides (transcoded by the dev video worker).
 * `present.presenter.window` drives the text deck from the pop-out presenter window
 * (`?presenter=1`) and counts that window's work too.
 *
 * Diagnostics: every frame over 1.5 intervals goes into the details file
 * (`notes.slowFrames`: the advance it followed, the renders and long tasks
 * around it; printed with PERF_VERBOSE=1); PERF_TRACE=<dir> writes a Chromium
 * performance trace of each pass there; PERF_KEEP_WARM_AB=1 runs one build as
 * two interleaved sides, present mode's keep-warm off and on (use with
 * PERF_STORE=0 — neither side is the bench's series).
 */

import type { BrowserContext, Page } from '@playwright/test'
import type { BenchDef } from '@narrative/perf'
import { PRESENT_TRANSITIONS } from '@narrative/perf'
import { expect, test } from '../fixtures/test'
import {
  launchOptions,
  PERF,
  runScenarios,
  selected,
  sideContext,
  type SideState,
} from './lib/driver'
import { assertPerfOff, capture, counterValues, type Captured } from './lib/page'
import {
  clickSlide,
  openPresentation,
  seedDeck,
  type DeckKind,
  type PresentDeck,
} from './lib/presentDecks'

const IDS = [
  'present.advance.text',
  'present.advance.paced',
  'present.advance.photo',
  'present.transition.all',
  'present.build.steps',
  'present.video.play',
  'present.jump.link',
  'present.presenter.window',
]
const VIEWPORT = { width: 1600, height: 900 }
/** Quiet after each advance: the transition and the builds are over, nothing else moves. */
const ADVANCE_QUIET_MS = 300
/** present.advance.paced: how many advances, and how long each slide is held before the next. */
const PACED_ADVANCES = 6
const PACED_HOLD_MS = 4000

interface PresentState extends SideState {
  context: BrowserContext
  decks: Map<DeckKind, PresentDeck>
}

const DECKS_OF: Record<string, DeckKind> = {
  'present.advance.text': 'text',
  'present.advance.paced': 'text',
  'present.advance.photo': 'photo',
  'present.transition.all': 'transitions',
  'present.build.steps': 'builds',
  'present.video.play': 'video',
  'present.jump.link': 'photo',
  'present.presenter.window': 'text',
}

if (PERF.gpu) test.use({ launchOptions: launchOptions() })
test.skip(!PERF.run, 'perf scenarios run through `just perf`')

/** The refresh interval of the display: the median rAF delta over half a second. */
async function refreshInterval(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const deltas: number[] = []
        let last = -1
        const tick = (t: number): void => {
          if (last >= 0) deltas.push(t - last)
          last = t
          if (deltas.length < 30) requestAnimationFrame(tick)
          else resolve([...deltas].sort((a, b) => a - b)[15]!)
        }
        requestAnimationFrame(tick)
      }),
  )
}

type Step =
  | { kind: 'key'; key: string; expect: number; holdMs?: number }
  | { kind: 'click'; expect: number; at?: { x: number; y: number }; holdMs?: number }

interface AdvanceRecord {
  step: string
  /** The input's `performance.now()` on the presentation's page. */
  t0: number
  /** Input to the incoming slide fully shown and quiet (or held for `holdMs`). */
  ms: number
}

/**
 * Run the steps on `page` (inputs on `driver`, the presenter window when it
 * drives): each input, then the expected slide active and the scene quiet
 * (or a fixed hold, for a playing video).
 */
async function runSteps(
  page: Page,
  driver: Page,
  deck: PresentDeck,
  steps: readonly Step[],
): Promise<AdvanceRecord[]> {
  const out: AdvanceRecord[] = []
  for (const step of steps) {
    const t0 = await page.evaluate(() => performance.now())
    if (step.kind === 'key') await driver.keyboard.press(step.key)
    else await clickSlide(driver, step.at ?? { x: 960, y: 540 })
    const done = await page.evaluate(
      async ({ target, quietMs, holdMs }) => {
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
        if (holdMs !== undefined) {
          await new Promise((r) => setTimeout(r, holdMs))
          return performance.now()
        }
        const r = await window.__narrative_perf_harness!.settle({ quietMs, timeoutMs: 60_000 })
        if (!r.ok) throw new Error(`slide ${target} did not settle: ${r.reason}`)
        return performance.now() - quietMs
      },
      {
        target: deck.slideIds[step.expect]!,
        quietMs: ADVANCE_QUIET_MS,
        holdMs: step.holdMs,
      },
    )
    out.push({
      step: `${step.kind === 'key' ? step.key : 'click'} → ${step.expect + 1}`,
      t0,
      ms: done - t0,
    })
  }
  return out
}

/** Forward through every slide, then back to the first. */
function forwardAndBack(n: number): Step[] {
  const steps: Step[] = []
  for (let i = 1; i < n; i++) steps.push({ kind: 'key', key: 'ArrowRight', expect: i })
  for (let i = n - 2; i >= 0; i--) steps.push({ kind: 'key', key: 'ArrowLeft', expect: i })
  return steps
}

function stepsFor(id: string, deck: PresentDeck): Step[] {
  const n = deck.slideIds.length
  switch (id) {
    case 'present.advance.text':
    case 'present.advance.photo':
    case 'present.presenter.window':
      return forwardAndBack(n)
    case 'present.advance.paced':
      // Held before each advance, as a presenter talks over a slide.
      return Array.from({ length: PACED_ADVANCES }, (_, i) => ({
        kind: 'key' as const,
        key: 'ArrowRight',
        expect: i + 1,
        holdMs: PACED_HOLD_MS,
      }))
    case 'present.transition.all':
      // Present mode plays the incoming slide's transition: forward plays
      // each slide's own, back the one of the slide it lands on.
      return forwardAndBack(PRESENT_TRANSITIONS.length)
    case 'present.build.steps': {
      const steps: Step[] = []
      const clicks = deck.clicks ?? []
      for (let s = 0; s < n; s++) {
        for (let c = 0; c < (clicks[s] ?? 0); c++) steps.push({ kind: 'click', expect: s })
        if (s < n - 1) steps.push({ kind: 'key', key: 'ArrowRight', expect: s + 1 })
      }
      for (let s = n - 2; s >= 0; s--) steps.push({ kind: 'key', key: 'ArrowLeft', expect: s })
      return steps
    }
    case 'present.video.play':
      return [
        { kind: 'key', key: 'ArrowRight', expect: 1, holdMs: 3000 },
        { kind: 'key', key: 'ArrowRight', expect: 2 },
        { kind: 'key', key: 'ArrowLeft', expect: 1, holdMs: 3000 },
        { kind: 'key', key: 'ArrowLeft', expect: 0 },
      ]
    case 'present.jump.link': {
      const link = { x: 1780, y: 110 }
      const steps: Step[] = []
      for (let i = 0; i < 3; i++) {
        steps.push({ kind: 'click', expect: 8, at: link })
        steps.push({ kind: 'click', expect: 0, at: link })
      }
      return steps
    }
    default:
      throw new Error(`no steps for ${id}`)
  }
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]!
}

/**
 * Every frame longer than 1.5 intervals, placed against the advance it
 * followed and the editor renders around it: where a missed frame's work
 * has to be looked for (the details file, `notes.slowFrames`).
 */
function slowFrames(
  c: Captured,
  interval: number,
  advances: readonly AdvanceRecord[],
): Array<Record<string, unknown>> {
  const rec = c.recording
  // An older build's harness (an A/B's "before") has neither field.
  const startedAt = rec.startedAt ?? Number.NaN
  const renderLog = rec.renderLog ?? []
  return rec.frames
    .filter((f) => f.ms > 1.5 * interval)
    .map((f) => {
      const abs = startedAt + f.at
      const prior = advances.filter((a) => a.t0 <= abs + f.ms).at(-1)
      return {
        at: Math.round(f.at),
        ms: Math.round(f.ms * 10) / 10,
        after: prior?.step ?? null,
        sinceInput: prior === undefined ? null : Math.round(abs - prior.t0),
        renders: renderLog
          .filter((r) => r.at >= f.at - interval && r.at <= f.at + f.ms)
          .map((r) => `${Math.round(r.at - f.at)}+${r.ms.toFixed(1)}`),
        longTasks: (rec.longTasks ?? [])
          .filter((l) => l.at + l.ms >= f.at && l.at <= f.at + f.ms)
          .map((l) => `${Math.round(l.at - f.at)}+${Math.round(l.ms)}`),
      }
    })
}

const PRESENT_KEYS = new Set([
  'present.ready',
  'present.frames',
  'present.dropped',
  'present.hitches',
  'frame.p50',
  'frame.p99',
  'frame.max',
  'advance.p50',
  'advance.max',
  'longTask.total',
  'longTask.max',
  'present.glTextures',
  'present.heapMB',
  'wall',
])

function passValues(
  def: BenchDef<never>,
  c: Captured,
  o: {
    readyMs: number
    interval: number
    advances: AdvanceRecord[]
    extra?: Record<string, number>
  },
): Record<string, number> {
  const frames = c.recording.frames.map((f) => f.ms)
  const long = c.recording.longTasks ?? []
  const counters = { ...c.counters }
  for (const [k, v] of Object.entries(o.extra ?? {})) counters[k] = (counters[k] ?? 0) + v
  return {
    'present.ready': o.readyMs,
    'present.frames': frames.length,
    'present.dropped': frames.reduce(
      (a, ms) => a + Math.max(0, Math.round(ms / o.interval) - 1),
      0,
    ),
    'present.hitches': frames.filter((ms) => ms > 2 * o.interval).length,
    'frame.p50': percentile(frames, 0.5),
    'frame.p99': percentile(frames, 0.99),
    'frame.max': percentile(frames, 1),
    'advance.p50': percentile(
      o.advances.map((a) => a.ms),
      0.5,
    ),
    'advance.max': percentile(
      o.advances.map((a) => a.ms),
      1,
    ),
    'longTask.total': long.reduce((a, l) => a + l.ms, 0),
    'longTask.max': long.reduce((a, l) => Math.max(a, l.ms), 0),
    wall: c.wallMs,
    ...counterValues(def.metrics, counters, PRESENT_KEYS),
  }
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

test('present mode', async ({ browser }) => {
  const ids = selected(IDS)
  test.skip(ids.length === 0, 'no bench of this spec selected')
  test.setTimeout(180 * 60_000)

  const kinds = new Set(ids.map((id) => DECKS_OF[id]!))
  const states: PresentState[] = []
  // PERF_KEEP_WARM_AB=1: one build as two interleaved sides, present mode's
  // keep-warm off (A) and on (B) — renderer/presentSlides.ts → "Kept warm".
  const keepWarmAb = process.env['PERF_KEEP_WARM_AB'] === '1'
  const sides = keepWarmAb
    ? [
        { ...PERF.sides[0]!, name: 'keep-warm off' },
        { ...PERF.sides[0]!, name: 'keep-warm on' },
      ]
    : PERF.sides
  for (const side of sides) {
    const context = await sideContext(browser, side, VIEWPORT)
    if (keepWarmAb && side.name === 'keep-warm off')
      await context.addInitScript(() => {
        ;(window as unknown as { __narrative_perf_keepWarm?: boolean }).__narrative_perf_keepWarm =
          false
      })
    const page = await context.newPage()
    const decks = new Map<DeckKind, PresentDeck>()
    for (const kind of kinds) {
      const t = Date.now()
      decks.set(kind, await seedDeck(context, kind, side.name))
      console.log(`PERF scene present ${kind} [${side.name}] seeded in ${Date.now() - t} ms`)
    }
    const first = [...decks.values()][0]!
    await assertPerfOff(page, first.id, PERF.mode)
    // A page with the harness, for the fingerprint.
    await openPresentation(page, first)
    states.push({ side, page, context, decks })
  }

  const pass =
    (id: string) =>
    async (s: PresentState, def: BenchDef<never>): Promise<Record<string, number>> => {
      const deck = s.decks.get(DECKS_OF[id]!)!
      const steps = stepsFor(id, deck)
      let presenter: Page | null = null
      try {
        if (id === 'present.presenter.window') {
          presenter = await s.context.newPage()
          await presenter.goto(`/deck/${deck.id}/present?presenter=1&perf=1`)
          await expect(presenter.getByRole('region', { name: 'Presenter view' })).toBeVisible({
            timeout: 60_000,
          })
        }
        const readyMs = await openPresentation(s.page, deck)
        if (presenter !== null) {
          // The presenter window shows the next slide's picture before it drives.
          await expect(presenter.getByAltText('Slide 2 preview')).toBeVisible({ timeout: 60_000 })
          await presenter.evaluate(async () => {
            const h = window.__narrative_perf_harness!
            await h.settle({ quietMs: 800, timeoutMs: 60_000 })
            h.reset()
          })
        }
        const interval = await refreshInterval(s.page)
        let advances: AdvanceRecord[] = []
        // An older build's harness (an A/B's "before") has no glLive: 0.
        const texturesAtReady = await s.page.evaluate(
          () => window.__narrative_perf_harness!.glLive?.().textures ?? 0,
        )
        const trace = process.env['PERF_TRACE_UPLOADS'] === '1'
        // PERF_TRACE=<dir>: a Chromium performance trace of the pass (open it in
        // DevTools → Performance), for finding the work in a missed frame.
        const traceDir = process.env['PERF_TRACE']
        if (traceDir !== undefined && traceDir !== '')
          await browser.startTracing(s.page, {
            path: `${traceDir}/${id}-${s.side.name}-${Date.now()}.json`,
            categories: [
              'devtools.timeline',
              'disabled-by-default-devtools.timeline',
              'disabled-by-default-devtools.timeline.frame',
              'v8.execute',
              'blink.user_timing',
              'gpu',
              'viz',
              'cc',
              'benchmark',
              'toplevel',
              'gpu.angle',
              'gpu.service',
              'gpu.decoder',
              'disabled-by-default-gpu.angle',
              'disabled-by-default-gpu.service',
              'disabled-by-default-gpu.decoder',
              'disabled-by-default-gpu.device',
            ],
          })
        const c = await capture(s.page, async (inputEnd) => {
          if (trace)
            await s.page.evaluate(() => window.__narrative_perf_harness!.traceUploads(true))
          if (presenter !== null)
            await presenter.evaluate(() => window.__narrative_perf_harness!.reset())
          advances = await runSteps(s.page, presenter ?? s.page, deck, steps)
          await inputEnd()
        })
        if (traceDir !== undefined && traceDir !== '') await browser.stopTracing()
        s.last = c
        if (trace)
          for (const u of await s.page.evaluate(() =>
            window.__narrative_perf_harness!.traceUploads(false),
          ))
            console.log(`PERF upload ${id} ${u.w}×${u.h}\n${u.stack}`)
        const live = await s.page.evaluate(() => ({
          textures: window.__narrative_perf_harness!.glLive?.().textures ?? 0,
          heap:
            (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
              ?.usedJSHeapSize ?? 0,
        }))
        const extra =
          presenter === null
            ? undefined
            : await presenter.evaluate(() => window.__narrative_perf_harness!.counters())
        s.notes = {
          interval,
          advances: advances.map((a) => ({ step: a.step, ms: a.ms })),
          slowFrames: slowFrames(c, interval, advances),
          presenterCounters: extra ?? null,
          live,
        }
        if (process.env['PERF_VERBOSE'] === '1')
          for (const f of s.notes['slowFrames'] as Array<Record<string, unknown>>)
            console.log(`PERF slow frame ${id} [${s.side.name}] ${JSON.stringify(f)}`)
        return {
          ...passValues(def, c, {
            readyMs,
            interval,
            advances,
            ...(extra !== undefined ? { extra } : {}),
          }),
          'present.glTextures': live.textures - texturesAtReady,
          'present.heapMB': Math.round(live.heap / 1e5) / 10,
        }
      } finally {
        await presenter?.close()
      }
    }

  await runScenarios<PresentState>({
    browser,
    ids,
    states,
    sceneIsDefault: true,
    runs: Object.fromEntries(IDS.map((id) => [id, pass(id)])),
  })
})
