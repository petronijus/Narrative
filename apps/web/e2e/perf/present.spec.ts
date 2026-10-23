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
 *   - video4k: the same deck with a 10 s 4K H.264 (~20 Mbit/s, uploaded through tus): present
 *     mode plays its 1080p rendition or the original (renderer/videoRendition.ts, P3);
 *   - videoLoop: the 4K video trimmed to 4.5–7 s and looped, held 8 s a visit.
 * The video passes also read the playing elements (`videoProbe`): video frames handed to the
 * canvas, frames never shown, decoder drops, the longest wait from `play` to a new frame, the
 * file's width; in Chromium the GPU and renderer processes' CPU time over the pass and the GPU
 * process's memory after it. PERF_VIDEO_IDLE_MS=<ms> holds the first slide that long before a
 * video pass (a buffered element paused for minutes before its slide).
 * `present.presenter.window` drives the text deck from the pop-out presenter window
 * (`?presenter=1`) and counts that window's work too.
 *
 * Diagnostics: every frame over 1.5 intervals goes into the details file
 * (`notes.slowFrames`: the advance it followed, the renders and long tasks
 * around it; printed with PERF_VERBOSE=1); PERF_TRACE=<dir> writes a Chromium
 * performance trace of each pass there; PERF_PRESENT_AB=<knob> runs one build
 * as two interleaved sides, the knob off and on — `keep-warm` (present
 * mode's keep-warm; PERF_KEEP_WARM_AB=1 too), `fence` (the harness's input
 * fence), `rendition` (off: every video plays its original file, on: present
 * mode chooses — renderer/videoRendition.ts) or `keep-warm-frame` /
 * `keep-warm-targets` (keep-warm's frame at the next animation frame / none;
 * PERF_KEEP_WARM_FRAME=now|frame|none sets it for every pass, the Tauri window too)
 * or `idle-after-frame` (present mode's idle turns in an engine without idle
 * callbacks: a 0-ms timer, or right after the next frame; PERF_PRESENT_IDLE);
 * use with PERF_STORE=0, neither side is the bench's series. WebKit has no profiler
 * here and no Long Tasks API, so the slow frames also say how long each input
 * fence waited (`fences`, the GPU work of that frame; the fence is off unless
 * PERF_INPUT_FENCE=on) and, with
 * PERF_GAP_PROBE=1, where the main thread was busy (`gaps`, a timer chain —
 * a wakeup every 4 ms, never for a stored run). PERF_IDLE_CONTROL_MS=<ms>
 * records that long of the ready presentation with no input before each pass
 * and prints its slow frames: the misses of a page that does nothing, in the
 * same window — what the display path drops without us.
 */

import { execFileSync } from 'node:child_process'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import type { BenchDef } from '@narrative/perf'
import { PRESENT_TRANSITIONS } from '@narrative/perf'
import { expect, test } from '../fixtures/test'
import {
  launchOptions,
  PERF,
  perfPage,
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

/** What PERF_PRESENT_AB can switch (see the scenarios). */
const AB_KNOBS = [
  'keep-warm',
  'fence',
  'rendition',
  'keep-warm-frame',
  'keep-warm-targets',
  'idle-after-frame',
]

const IDS = [
  'present.advance.text',
  'present.advance.paced',
  'present.advance.photo',
  'present.transition.all',
  'present.build.steps',
  'present.video.play',
  'present.video.4k',
  'present.video.loop',
  'present.jump.link',
  'present.presenter.window',
]
const VIEWPORT = { width: 1600, height: 900 }
/** Quiet after each advance: the transition and the builds are over, nothing else moves. */
const ADVANCE_QUIET_MS = 300
/** present.advance.paced: how many advances, and how long each slide is held before the next. */
const PACED_ADVANCES = 6
const PACED_HOLD_MS = 4000

/**
 * The slow frames of every pass so far, per bench and side (warm-ups
 * included, numbered in order): the details file holds the last pass's
 * capture only, and a miss in one pass of ten was lost with it.
 */
const slowFramesOfPasses = new Map<string, Array<{ pass: number; frames: unknown[] }>>()

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
  'present.video.4k': 'video4k',
  'present.video.loop': 'videoLoop',
  'present.jump.link': 'photo',
  'present.presenter.window': 'text',
}

if (PERF.gpu) test.use({ launchOptions: launchOptions() })
test.skip(!PERF.run, 'perf scenarios run through `just perf`')

/**
 * The JS heap still in use after a full collection, in bytes (0 where it
 * cannot be read: WebKit, the Tauri window). Not `performance.memory`:
 * without `--enable-precise-memory-info` Chromium rounds it into 100
 * logarithmic buckets from 10 MB to 4 GB (~6 % apart) and caches it per
 * thread for 20 minutes (blink `timing/memory_info.cc`), so a pass reported
 * the heap of some earlier moment of the page, in steps — 27.6 → 42.1 MB in
 * `present.build.steps` and `present.jump.link` alike, seven buckets
 * (2026-10-23). Read through CDP, after a GC: what the pass left behind,
 * not when V8 last collected.
 */
async function retainedHeap(page: Page): Promise<number> {
  if (PERF.shell !== 'browser') return 0
  if (page.context().browser()?.browserType().name() !== 'chromium') return 0
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('HeapProfiler.collectGarbage')
    const { usedSize } = await cdp.send('Runtime.getHeapUsage')
    return usedSize
  } finally {
    await cdp.detach()
  }
}

/**
 * The video probe of a video pass (performance.md → P3): every `<video>` of
 * the page (present mode's pool, renderer/presentVideos.ts) reports each
 * frame it hands on (requestVideoFrameCallback — Pixi's VideoSource uploads
 * on the same callback) and its decoder's drops. Started before the pass,
 * read after it.
 */
async function startVideoProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Meta = { mediaTime: number; width: number; height: number }
    type El = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: Meta) => void) => number
    }
    const probe = {
      stopped: false,
      frames: 0,
      steps: [] as number[],
      widths: [] as number[],
      dropped0: [] as Array<[HTMLVideoElement, number]>,
      /** From `play` (or a loop's `seeking`) to the next new frame, ms. */
      starts: [] as number[],
    }
    ;(window as unknown as { __narrative_videoProbe?: typeof probe }).__narrative_videoProbe = probe
    for (const v of document.querySelectorAll<El>('video')) {
      probe.dropped0.push([v, v.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0])
      if (typeof v.requestVideoFrameCallback !== 'function') continue
      let last = -1
      // A start: `play`, or a seek while playing (a trimmed loop's restart).
      let startedAt: number | null = null
      v.addEventListener('play', () => (startedAt = performance.now()))
      v.addEventListener('seeking', () => {
        if (!v.paused) startedAt = performance.now()
      })
      const onFrame = (now: number, meta: Meta): void => {
        if (probe.stopped) return
        if (startedAt !== null && meta.mediaTime !== last) {
          probe.starts.push(now - startedAt)
          startedAt = null
        }
        probe.frames++
        probe.widths.push(Math.max(meta.width, meta.height))
        // A step forward of the media time: one frame, or more never shown.
        // A rewind or a seek (a slide left, a loop) starts over.
        const step = meta.mediaTime - last
        if (last >= 0 && step > 0 && step < 1) probe.steps.push(step)
        last = meta.mediaTime
        v.requestVideoFrameCallback!(onFrame)
      }
      v.requestVideoFrameCallback(onFrame)
    }
  })
}

async function readVideoProbe(page: Page): Promise<{
  frames: number
  skipped: number
  decoderDropped: number
  startMs: number
  width: number
}> {
  return page.evaluate(() => {
    const probe = (
      window as unknown as {
        __narrative_videoProbe?: {
          stopped: boolean
          frames: number
          steps: number[]
          widths: number[]
          dropped0: Array<[HTMLVideoElement, number]>
          starts: number[]
        }
      }
    ).__narrative_videoProbe
    if (probe === undefined)
      return { frames: 0, skipped: 0, decoderDropped: 0, startMs: 0, width: 0 }
    probe.stopped = true
    // The frame duration: the most common step (the median of them).
    const sorted = [...probe.steps].sort((a, b) => a - b)
    const frame = sorted[Math.floor(sorted.length / 2)] ?? 0
    const skipped =
      frame > 0 ? probe.steps.reduce((n, st) => n + Math.max(0, Math.round(st / frame) - 1), 0) : 0
    const decoderDropped = probe.dropped0.reduce(
      (n, [v, d0]) => n + (v.getVideoPlaybackQuality?.().droppedVideoFrames ?? d0) - d0,
      0,
    )
    return {
      frames: probe.frames,
      skipped,
      decoderDropped,
      startMs: Math.round(Math.max(0, ...probe.starts)),
      width: Math.max(0, ...probe.widths),
    }
  })
}

/**
 * CPU time (ms) of the browser's GPU processes and of its renderers so far,
 * and the GPU processes' resident memory (MB); null outside Chromium (CDP's
 * SystemInfo.getProcessInfo, `ps` for the memory).
 */
async function chromiumProcesses(
  browser: Browser,
): Promise<{ gpuCpuMs: number; rendererCpuMs: number; gpuRssMB: number } | null> {
  if (PERF.shell !== 'browser' || browser.browserType().name() !== 'chromium') return null
  const cdp = await browser.newBrowserCDPSession()
  try {
    const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as {
      processInfo: Array<{ type: string; id: number; cpuTime: number }>
    }
    const gpu = processInfo.filter((p) => p.type.toLowerCase() === 'gpu')
    const cpu = (list: typeof processInfo): number =>
      Math.round(list.reduce((a, p) => a + p.cpuTime * 1000, 0))
    let rssKb = 0
    for (const p of gpu)
      try {
        rssKb += Number(
          execFileSync('ps', ['-o', 'rss=', '-p', String(p.id)])
            .toString()
            .trim(),
        )
      } catch {
        // Gone meanwhile.
      }
    return {
      gpuCpuMs: cpu(gpu),
      rendererCpuMs: cpu(processInfo.filter((p) => p.type === 'renderer')),
      gpuRssMB: Math.round(rssKb / 102.4) / 10,
    }
  } finally {
    await cdp.detach()
  }
}

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

function keepWarmFrameOf(v: string | undefined): 'now' | 'frame' | 'none' | null {
  if (v === undefined || v === '') return null
  if (v === 'now' || v === 'frame' || v === 'none') return v
  throw new Error(`PERF_KEEP_WARM_FRAME=${v}: now, frame or none`)
}

/**
 * PERF_IDLE_CONTROL_MS: the ready presentation recorded for `ms` with no
 * input, its slow frames printed — the control for the misses of a pass.
 */
async function idleControl(
  page: Page,
  id: string,
  side: string,
  ms: number,
  interval: number,
): Promise<void> {
  const rec = await page.evaluate(async (holdMs) => {
    const h = window.__narrative_perf_harness!
    h.startRecording()
    await new Promise((r) => setTimeout(r, holdMs))
    return h.stopRecording()
  }, ms)
  const slow = rec.frames.filter((f) => f.ms > 1.5 * interval)
  const dropped = rec.frames.reduce((a, f) => a + Math.max(0, Math.round(f.ms / interval) - 1), 0)
  const near = (
    log: Array<{ at: number; ms: number }> | undefined,
    f: { at: number; ms: number },
  ) => (log ?? []).filter((r) => r.at >= f.at - interval && r.at <= f.at + f.ms).length
  console.log(
    `PERF idle control ${id} [${side}] ${Math.round(rec.durationMs)} ms, ${rec.frames.length} frames, ${dropped} dropped: ` +
      JSON.stringify(
        slow.map((f) => ({
          at: Math.round(f.at),
          ms: Math.round(f.ms),
          keepWarm: near(rec.keepWarmLog, f),
          renders: near(rec.renderLog, f),
        })),
      ),
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
    case 'present.video.loop':
      // 2.5 s of the file a loop: each hold plays it through about three times.
      return [
        { kind: 'key', key: 'ArrowRight', expect: 1, holdMs: 8000 },
        { kind: 'key', key: 'ArrowRight', expect: 2 },
        { kind: 'key', key: 'ArrowLeft', expect: 1, holdMs: 8000 },
        { kind: 'key', key: 'ArrowLeft', expect: 0 },
      ]
    case 'present.video.play':
    case 'present.video.4k':
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
        keepWarm: (rec.keepWarmLog ?? [])
          .filter((r) => r.at >= f.at - interval && r.at <= f.at + f.ms)
          .map((r) => `${Math.round(r.at - f.at)}+${r.ms.toFixed(1)}`),
        fences: (rec.fenceLog ?? [])
          .filter((r) => r.at >= f.at - interval && r.at <= f.at + f.ms)
          .map((r) => `${Math.round(r.at - f.at)}+${r.ms.toFixed(1)}`),
        gaps: (rec.gapLog ?? [])
          .filter((g) => g.at + g.ms >= f.at - interval && g.at <= f.at + f.ms)
          .map((g) => `${Math.round(g.at - f.at)}+${Math.round(g.ms)}`),
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
  'video.frames',
  'video.skipped',
  'video.decoderDropped',
  'video.startMs',
  'video.width',
  'proc.gpuCpuMs',
  'proc.rendererCpuMs',
  'proc.gpuRssMB',
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
  // PERF_PRESENT_AB=<knob>: one build as two interleaved sides, the knob off
  // (A) and on (B) — `keep-warm` (renderer/presentSlides.ts → "Kept warm";
  // PERF_KEEP_WARM_AB=1 is the same), `fence` (the harness's input fence),
  // `rendition` (a video's original file, or the one present mode chooses),
  // `keep-warm-frame` / `keep-warm-targets` (keep-warm's frame drawn at once,
  // or at the next animation frame / not at all: presentKeepWarm.ts →
  // KeepWarmFrame).
  const ab =
    process.env['PERF_KEEP_WARM_AB'] === '1' ? 'keep-warm' : (process.env['PERF_PRESENT_AB'] ?? '')
  if (ab !== '' && !AB_KNOBS.includes(ab))
    throw new Error(`PERF_PRESENT_AB=${ab}: one of ${AB_KNOBS.join(', ')}`)
  const sides =
    ab !== ''
      ? [
          { ...PERF.sides[0]!, name: `${ab} off` },
          { ...PERF.sides[0]!, name: `${ab} on` },
        ]
      : PERF.sides
  for (const side of sides) {
    const context = await sideContext(browser, side, VIEWPORT)
    if (ab !== '' && PERF.shell === 'tauri')
      throw new Error('PERF_PRESENT_AB runs in a browser: the Tauri window has one page')
    // `rendition`: off plays every video's original, on lets present mode
    // choose (renderer/videoRendition.ts; performance.md → P3).
    if (ab === 'rendition' && side.name === 'rendition off')
      await context.addInitScript(() => {
        ;(
          window as unknown as { __narrative_perf_videoRendition?: string }
        ).__narrative_perf_videoRendition = 'playback'
      })
    if (ab.startsWith('keep-warm-') && side.name.endsWith(' on'))
      await context.addInitScript(
        (m) => {
          ;(
            window as unknown as { __narrative_perf_keepWarmFrame?: string }
          ).__narrative_perf_keepWarmFrame = m
        },
        ab === 'keep-warm-frame' ? 'frame' : 'none',
      )
    // `idle-after-frame`: present mode's idle turns where the engine has no
    // idle callbacks — off a 0-ms timer, on right after the next frame
    // (renderer/presentKeepWarm.ts → PresentIdleFallback).
    if (ab === 'idle-after-frame')
      await context.addInitScript(
        (m) => {
          ;(
            window as unknown as { __narrative_perf_presentIdle?: string }
          ).__narrative_perf_presentIdle = m
        },
        side.name.endsWith(' on') ? 'frame' : 'timer',
      )
    if (ab === 'keep-warm' && side.name === 'keep-warm off')
      await context.addInitScript(() => {
        ;(window as unknown as { __narrative_perf_keepWarm?: boolean }).__narrative_perf_keepWarm =
          false
      })
    const page = await perfPage(context, side, VIEWPORT)
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
    // Keep-warm and the slide cache's idle work wait for idle callbacks
    // (textResolutionStaging.ts → idleCallbacks), a 0-ms timer where the
    // engine has none: which one this page gets.
    console.log(
      `PERF present page [${side.name}]: requestIdleCallback ${await page.evaluate(() => typeof requestIdleCallback)}`,
    )
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
        // A covered or hidden window is throttled (WebKit drew a headed page
        // every 765 ms behind another window, 2026-10-21): its frames say nothing.
        if (interval > 40)
          throw new Error(
            `the page draws every ${Math.round(interval)} ms — its window is covered or hidden and throttled; keep it in front`,
          )
        const idleControlMs = Number(process.env['PERF_IDLE_CONTROL_MS'] ?? 0)
        if (idleControlMs > 0) await idleControl(s.page, id, s.side.name, idleControlMs, interval)
        // The probes of this pass. No input fence by default: these benches
        // time frames, not input-to-pixel, and the fence's 1-px readPixels
        // makes the main thread wait for the GPU in the very frame it shows
        // (in WebKit one waited 66 ms inside a 145 ms frame of a transition,
        // 2026-10-23, F2) — PERF_INPUT_FENCE=on brings it back.
        await s.page.evaluate(
          ({ fence, gaps, keepWarmFrame, presentIdle, keepWarmTarget }) => {
            const h = window.__narrative_perf_harness!
            h.setInputFence(fence)
            if (keepWarmFrame !== null) h.setKeepWarmFrame(keepWarmFrame)
            if (presentIdle === 'frame' || presentIdle === 'timer')
              h.setPresentIdleFallback(presentIdle)
            if (
              keepWarmTarget === 'pixel' ||
              keepWarmTarget === 'eighth' ||
              keepWarmTarget === 'full'
            )
              h.setKeepWarmTarget(keepWarmTarget)
            // An older build's harness (an A/B's "before") has no gap probe.
            ;(h as Partial<typeof h>).setGapProbe?.(gaps)
          },
          {
            fence:
              ab === 'fence'
                ? s.side.name === 'fence on'
                : process.env['PERF_INPUT_FENCE'] === 'on',
            gaps: process.env['PERF_GAP_PROBE'] === '1',
            // PERF_KEEP_WARM_FRAME=now|frame|none: keep-warm's frame for every
            // pass (the Tauri window, which cannot run PERF_PRESENT_AB's sides).
            keepWarmFrame: keepWarmFrameOf(process.env['PERF_KEEP_WARM_FRAME']),
            // PERF_PRESENT_IDLE=frame|timer: the same for the idle turns (idle-after-frame).
            presentIdle: process.env['PERF_PRESENT_IDLE'] ?? null,
            // PERF_KEEP_WARM_TARGET=pixel|eighth|full: what keep-warm draws into.
            keepWarmTarget: process.env['PERF_KEEP_WARM_TARGET'] ?? null,
          },
        )
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
              // PERF_TRACE_CATEGORIES: more, comma-separated (`base,ipc,blink`).
              ...(process.env['PERF_TRACE_CATEGORIES'] ?? '').split(',').filter((c) => c !== ''),
            ],
          })
        const videoPass = DECKS_OF[id]!.startsWith('video')
        // PERF_VIDEO_IDLE_MS: the presentation sits on its first slide this long
        // before the pass, as a talk reaches its video minutes in (a diagnostic:
        // whether a buffered element paused that long starts late).
        const idleMs = Number(process.env['PERF_VIDEO_IDLE_MS'] ?? 0)
        if (videoPass && idleMs > 0) await s.page.waitForTimeout(idleMs)
        if (videoPass) await startVideoProbe(s.page)
        const procs0 = videoPass ? await chromiumProcesses(browser) : null
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
        const procs1 = videoPass ? await chromiumProcesses(browser) : null
        const video = videoPass ? await readVideoProbe(s.page) : null
        if (trace)
          for (const u of await s.page.evaluate(() =>
            window.__narrative_perf_harness!.traceUploads(false),
          ))
            console.log(`PERF upload ${id} ${u.w}×${u.h}\n${u.stack}`)
        const live = {
          textures: await s.page.evaluate(
            () => window.__narrative_perf_harness!.glLive?.().textures ?? 0,
          ),
          heap: await retainedHeap(s.page),
        }
        const extra =
          presenter === null
            ? undefined
            : await presenter.evaluate(() => window.__narrative_perf_harness!.counters())
        const slow = slowFrames(c, interval, advances)
        const passKey = `${id}@${s.side.name}`
        const passes = slowFramesOfPasses.get(passKey) ?? []
        slowFramesOfPasses.set(passKey, passes)
        const pass = (passes.at(-1)?.pass ?? 0) + 1
        passes.push({ pass, frames: slow })
        s.notes = {
          interval,
          advances: advances.map((a) => ({ step: a.step, ms: a.ms })),
          slowFrames: slow,
          slowFramesOfPasses: passes.filter((p) => p.frames.length > 0),
          presenterCounters: extra ?? null,
          live,
        }
        if (process.env['PERF_VERBOSE'] === '1') {
          for (const f of s.notes['slowFrames'] as Array<Record<string, unknown>>)
            console.log(`PERF slow frame ${id} [${s.side.name}] ${JSON.stringify(f)}`)
          // With PERF_INPUT_FENCE=on: how long the first fence after each
          // input waited — the GPU work of the frame that showed it.
          const fences = c.recording.fenceLog ?? []
          const start = c.recording.startedAt
          if (fences.length > 0 && start !== undefined)
            console.log(
              `PERF fences ${id} [${s.side.name}] ` +
                advances
                  .map((a) => {
                    const f = fences.find((x) => start + x.at >= a.t0)
                    return `${a.step}=${f === undefined ? '-' : f.ms.toFixed(0)}`
                  })
                  .join(' '),
            )
        }
        return {
          ...passValues(def, c, {
            readyMs,
            interval,
            advances,
            ...(extra !== undefined ? { extra } : {}),
          }),
          'present.glTextures': live.textures - texturesAtReady,
          'present.heapMB': Math.round(live.heap / 1e5) / 10,
          ...(video !== null
            ? {
                'video.frames': video.frames,
                'video.skipped': video.skipped,
                'video.decoderDropped': video.decoderDropped,
                'video.startMs': video.startMs,
                'video.width': video.width,
                'proc.gpuCpuMs':
                  procs0 !== null && procs1 !== null ? procs1.gpuCpuMs - procs0.gpuCpuMs : 0,
                'proc.rendererCpuMs':
                  procs0 !== null && procs1 !== null
                    ? procs1.rendererCpuMs - procs0.rendererCpuMs
                    : 0,
                'proc.gpuRssMB': procs1?.gpuRssMB ?? 0,
              }
            : {}),
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
