/**
 * e2e/perf/lib/page.ts — the Playwright side of the in-page harness
 * (apps/web/src/perf/harness.ts): open a deck with `?perf=1`, wait for the
 * scene to settle, record a gesture, and turn the recording and the counters
 * into a bench run's values (packages/perf/src/catalog/interaction.ts).
 *
 * CDP-free: everything here works in WebKit too (G6). Chromium extras (CPU
 * profile) are in driver.ts.
 */

import type { Page } from '@playwright/test'
import type { MetricSpec } from '@narrative/perf'
import type { PerfHarnessApi, PerfRecording, SettleResult } from '../../../src/perf/harness'
import { expect } from '../../fixtures/test'

declare global {
  interface Window {
    __narrative_perf_harness?: PerfHarnessApi
  }
}

/** Quiet long enough for the thumbnail debounce (500 ms) and the render behind it. */
export const QUIET_MS = 800

export async function openDeck(
  page: Page,
  deckId: string,
  expectedIds: readonly string[],
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  await page.goto(`/deck/${deckId}?perf=1`)
  await expect
    .poll(() => page.evaluate(() => window.__narrative_perf_harness?.version ?? 0), {
      timeout: 30_000,
      message: 'the perf harness did not load (?perf=1) — a revision before step 2 of the harness?',
    })
    .toBe(1)
  await expect
    .poll(
      () =>
        page.evaluate(
          (ids) => {
            const have = new Set(window.__narrative_perf_harness!.mountedIds())
            return ids.filter((id) => !have.has(id)).length
          },
          [...expectedIds],
        ),
      { timeout: opts.timeoutMs ?? 90_000, message: 'objects not mounted' },
    )
    .toBe(0)
  await settle(page, { timeoutMs: opts.timeoutMs ?? 90_000 })
}

export async function settle(
  page: Page,
  opts: { quietMs?: number; timeoutMs?: number; expectedIds?: readonly string[] } = {},
): Promise<SettleResult> {
  const r = await page.evaluate(
    (o) =>
      window.__narrative_perf_harness!.settle({
        quietMs: o.quietMs,
        timeoutMs: o.timeoutMs,
        ...(o.expectedIds !== undefined ? { expectedIds: o.expectedIds } : {}),
      }),
    {
      quietMs: opts.quietMs ?? QUIET_MS,
      timeoutMs: opts.timeoutMs ?? 30_000,
      expectedIds: opts.expectedIds === undefined ? undefined : [...opts.expectedIds],
    },
  )
  if (!r.ok)
    throw new Error(`the scene did not settle in ${Math.round(r.waitedMs)} ms: ${r.reason}`)
  return r
}

export interface Captured {
  recording: PerfRecording
  counters: Record<string, number>
  routes: Record<string, number>
  react: Awaited<ReturnType<PerfHarnessApi['react']>>
  /** From the end of input to quiet again, ms. */
  settleMs: number
  wallMs: number
}

/**
 * One measured gesture: settle, zero the counters, record, run the gesture
 * (which calls `inputEnd()` after its last input), settle again, collect.
 */
export async function capture(
  page: Page,
  gesture: (inputEnd: () => Promise<void>) => Promise<void>,
  opts: { quietMs?: number } = {},
): Promise<Captured> {
  const quietMs = opts.quietMs ?? QUIET_MS
  await settle(page, { quietMs })
  await page.evaluate(() => {
    const h = window.__narrative_perf_harness!
    h.reset()
    h.startRecording()
  })
  const t0 = Date.now()
  let marked = false
  const inputEnd = async (): Promise<void> => {
    marked = true
    await page.evaluate(() => window.__narrative_perf_harness!.markInputEnd())
  }
  await gesture(inputEnd)
  if (!marked) await inputEnd()
  const settled = await settle(page, { quietMs, timeoutMs: 60_000 })
  const wallMs = Date.now() - t0
  const out = await page.evaluate(() => {
    const h = window.__narrative_perf_harness!
    return {
      recording: h.stopRecording(),
      counters: h.counters(),
      routes: h.routes(),
      react: h.react(),
    }
  })
  return { ...out, settleMs: Math.max(0, settled.waitedMs - quietMs), wallMs }
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]!
}

/** A counter, or the sum of a family of them (`sg.mount` = every `sg.mount.<type>`). */
export function counterValue(counters: Readonly<Record<string, number>>, key: string): number {
  if (Object.hasOwn(counters, key) && !['sg.mount', 'sg.update', 'sg.destroy'].includes(key))
    return counters[key]!
  if (key === 'sg.mount' || key === 'sg.update' || key === 'sg.destroy') {
    let n = 0
    for (const [k, v] of Object.entries(counters)) if (k.startsWith(`${key}.`)) n += v
    return n
  }
  return 0
}

/** Every counter a bench declares, from a counter snapshot. */
export function counterValues(
  metrics: Readonly<Record<string, MetricSpec>>,
  counters: Readonly<Record<string, number>>,
  skip: ReadonlySet<string>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const name of Object.keys(metrics))
    if (!skip.has(name)) out[name] = counterValue(counters, name)
  return out
}

const GESTURE_KEYS = new Set([
  'input.p50',
  'input.p90',
  'input.max',
  'frame.p50',
  'frame.p90',
  'frame.max',
  'frame.over50',
  'longTask.total',
  'render.ms',
  'render.count',
  'settle',
  'wall',
])

/** A gesture bench's values: the gesture's time metrics, then its counters. */
export function gestureValues(
  metrics: Readonly<Record<string, MetricSpec>>,
  c: Captured,
): Record<string, number> {
  const r = c.recording
  const end = r.inputEndMs ?? r.durationMs
  const active = r.frames.filter((f) => f.at < end).map((f) => f.ms)
  const latencies = r.inputs.map((i) => i.ms)
  return {
    'input.p50': percentile(latencies, 0.5),
    'input.p90': percentile(latencies, 0.9),
    'input.max': percentile(latencies, 1),
    'frame.p50': percentile(active, 0.5),
    'frame.p90': percentile(active, 0.9),
    'frame.max': percentile(active, 1),
    'frame.over50': active.filter((f) => f > 50).length,
    'longTask.total': (r.longTasks ?? []).reduce((a, l) => a + l.ms, 0),
    'render.ms': r.renders.ms,
    'render.count': r.renders.count,
    settle: c.settleMs,
    wall: c.wallMs,
    ...counterValues(metrics, c.counters, GESTURE_KEYS),
  }
}

/**
 * The centre of an object on screen, from the artboard's box and the slide's
 * 1920 px width — a point the pointer reaches. The editor's panels lie over
 * the canvas (it centres the artboard in the channel between them), so at
 * 100 % in a window narrower than the slide an object near its edge sits
 * under a panel: then the canvas is scrolled until the point is at the
 * window's centre (transform.move.rect.light dragged the slides panel's
 * list, and the object never moved).
 */
export async function screenCentre(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
): Promise<{ x: number; y: number }> {
  const at = async () => {
    const a = (await page.locator('.artboard').boundingBox())!
    const k = a.width / 1920
    return { x: a.x + (box.x + box.width / 2) * k, y: a.y + (box.y + box.height / 2) * k }
  }
  const onArtboard = (p: { x: number; y: number }) =>
    page.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.closest('.artboard') != null,
      [p.x, p.y],
    )
  const p = await at()
  if (await onArtboard(p)) return p
  await page.evaluate(
    ([x, y]) => {
      // The canvas's scroll container: the artboard's nearest ancestor that scrolls.
      const scrolls = (e: Element) => /auto|scroll/.test(getComputedStyle(e).overflow)
      let el = document.querySelector('.artboard')?.parentElement ?? null
      while (el !== null && !scrolls(el)) el = el.parentElement
      el?.scrollBy({ left: x! - innerWidth / 2, top: y! - innerHeight / 2, behavior: 'instant' })
    },
    [p.x, p.y],
  )
  // The scroll lands on the next frame.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))))
  const q = await at()
  expect(await onArtboard(q), `object at (${box.x}, ${box.y}) is under the editor's panels`).toBe(
    true,
  )
  return q
}

/** The object's current position as the canvas has it. */
export async function objectXY(page: Page, id: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((i) => {
    const o = window.__narrative_perf_harness!.object(i) as { x: number; y: number } | null
    return o === null ? null : { x: o.x, y: o.y }
  }, id)
}

/**
 * The counter-off probe (perf-harness.md → Decisions): a production page
 * without `?perf=1` fetches no harness chunk and counts nothing — every
 * counter site is a call that returns at once. Run by each spec on prod and
 * profiling sides before it measures (dev counts always, by design).
 */
export async function assertPerfOff(page: Page, deckId: string, mode: string): Promise<void> {
  if (mode === 'dev') return
  const fetched: string[] = []
  const onRequest = (r: { url(): string }): void => {
    if (/\/assets\/harness-[^/]*\.js/.test(r.url())) fetched.push(r.url())
  }
  page.on('request', onRequest)
  await page.goto(`/deck/${deckId}`)
  await expect(page.locator('.artboard')).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(1500)
  const state = await page.evaluate(() => ({
    // PERF_COUNTS_KEY of @narrative/shared's perfCounters.ts.
    counts: (globalThis as Record<symbol, unknown>)[Symbol.for('narrative.perf.counts')] ?? null,
    harness: window.__narrative_perf_harness !== undefined,
    selectionHook:
      (window as unknown as { __narrative_selection_snapshot?: unknown })
        .__narrative_selection_snapshot !== undefined,
  }))
  page.off('request', onRequest)
  expect(fetched, 'the harness chunk was fetched without ?perf=1').toEqual([])
  expect(state, 'perf is off without ?perf=1').toEqual({
    counts: null,
    harness: false,
    selectionHook: false,
  })
}
