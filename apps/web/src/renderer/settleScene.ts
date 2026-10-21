/**
 * renderer/settleScene.ts
 *
 * "The canvas shows this slide completely" — for the render page (agentic
 * A3, docs/plans/a3-render-worker.md), which the render worker screenshots.
 * A slide is settled when:
 *   1. every object of the slide is mounted in the scene graph;
 *   2. no tracked load is in flight (renderWork.ts: media URLs, textures,
 *      folder and bundled fonts) and `document.fonts` has finished loading;
 *   3. every HTMLText raster the latest frame started has landed and been
 *      drawn — a font that arrives re-rasterises its text, so this repeats
 *      until a frame starts no new raster;
 *   4. two animation frames later nothing new has started.
 * Then one last frame is rendered and the canvas holds the final pixels.
 * With `quick`, a scene the caller already saw settled, unchanged since as
 * far as it knows, is confirmed without those two frames when the first pass
 * finds nothing to wait for (otherwise it settles as usual). The
 * result says how many loads failed on the way (their objects paint an error
 * mark or a fallback face): settled is about the canvas being final, not
 * about every asset existing.
 */

import type { SceneGraph } from './SceneGraph.js'
import { collectHtmlTextRasters } from './htmlTextRaster.js'
import { failedRenderWork, pendingRenderWork, whenRenderWorkIdle } from './renderWork.js'

/** What settleScene reads from the scene graph. */
export type SettleScene = Pick<SceneGraph, 'getMountedIds' | 'getApp' | 'getRoot'>

export interface SettleOptions {
  /** The ids of the objects the slide holds now (top level); read on every pass. */
  expectedIds: () => readonly string[]
  /** Draw a frame synchronously (the render scheduler's `renderNow`). */
  renderNow: () => void
  /** Give up after this long (a load that never ends must not hang a render). */
  timeoutMs: number
  /** Stop early (the page moved on to another slide, or unmounted). */
  signal?: AbortSignal
  /**
   * The caller saw this scene settled and nothing it knows of has changed
   * since (the render page: no document update since that settle began).
   * Then a first pass with every object mounted, no load in flight, the
   * fonts loaded and no new raster after a draw is final at once — the two
   * quiet frames only catch work a change started, and there was none
   * (render page, performance.md R1: 2 frames of a slide switch).
   */
  quick?: boolean
}

export interface SettleResult {
  settled: boolean
  /** Why it is not settled, when it is not. */
  reason?: 'timeout' | 'aborted'
  /** Objects never mounted (still missing when it gave up). */
  missingIds: string[]
  /** Loads still in flight when it gave up. */
  pendingLoads: number
  /** Tracked loads that failed since the page loaded. */
  failedLoads: number
  elapsedMs: number
  /**
   * Where the time went, in milliseconds: waiting for loads and fonts,
   * waiting for text rasters (and how many), drawing frames synchronously,
   * waiting for animation frames; and how many passes it took.
   */
  phases: {
    loadsMs: number
    rastersMs: number
    rasters: number
    drawMs: number
    framesMs: number
    passes: number
  }
}

const TIMEOUT = Symbol('timeout')

/**
 * Raster promises some settle has waited for and seen settle, for every later
 * call: a text whose raster landed during the settle behind `ready` still
 * holds that promise, and a `quick` confirmation must not take it for new
 * work (it would wait two frames for nothing).
 */
const landedRasters = new WeakSet<Promise<unknown>>()

export async function settleScene(scene: SettleScene, opts: SettleOptions): Promise<SettleResult> {
  const started = performance.now()
  const deadline = started + opts.timeoutMs
  const drawn = new WeakSet<Promise<unknown>>()
  const phases = { loadsMs: 0, rastersMs: 0, rasters: 0, drawMs: 0, framesMs: 0, passes: 0 }
  const timed = async <T>(phase: 'loadsMs' | 'rastersMs' | 'framesMs', run: () => Promise<T>) => {
    const t = performance.now()
    try {
      return await run()
    } finally {
      phases[phase] += performance.now() - t
    }
  }
  const draw = (): void => {
    const t = performance.now()
    opts.renderNow()
    phases.drawMs += performance.now() - t
  }

  const missing = (): string[] => {
    const mounted = new Set(scene.getMountedIds())
    return opts.expectedIds().filter((id) => !mounted.has(id))
  }
  const freshRasters = (): Promise<unknown>[] =>
    collectHtmlTextRasters(scene.getRoot(), scene.getApp().renderer.uid).filter(
      (p) => !drawn.has(p),
    )
  const result = (settled: boolean, reason?: 'timeout' | 'aborted'): SettleResult => ({
    settled,
    ...(reason !== undefined ? { reason } : {}),
    missingIds: settled ? [] : missing(),
    pendingLoads: settled ? 0 : pendingRenderWork(),
    failedLoads: failedRenderWork(),
    elapsedMs: performance.now() - started,
    phases: {
      loadsMs: Math.round(phases.loadsMs),
      rastersMs: Math.round(phases.rastersMs),
      rasters: phases.rasters,
      drawMs: Math.round(phases.drawMs),
      framesMs: Math.round(phases.framesMs),
      passes: phases.passes,
    },
  })

  /** `promise`, or TIMEOUT once the deadline passes or the caller aborts; leaves no timer behind. */
  const bounded = <T>(make: (signal: AbortSignal) => Promise<T>): Promise<T | typeof TIMEOUT> => {
    const left = deadline - performance.now()
    if (left <= 0 || opts.signal?.aborted === true) return Promise.resolve(TIMEOUT)
    const stop = new AbortController()
    const onAbort = (): void => stop.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      make(stop.signal),
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), left)
        stop.signal.addEventListener('abort', () => resolve(TIMEOUT), { once: true })
      }),
    ]).finally(() => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      stop.abort()
    })
  }
  const nextFrame = (signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      const id = requestAnimationFrame(() => resolve())
      signal.addEventListener('abort', () => cancelAnimationFrame(id), { once: true })
    })
  const gaveUp = (): SettleResult =>
    result(false, opts.signal?.aborted === true ? 'aborted' : 'timeout')

  if (opts.quick === true && opts.signal?.aborted !== true) {
    if (missing().length === 0 && pendingRenderWork() === 0 && document.fonts.status === 'loaded') {
      phases.passes += 1
      draw()
      const fresh = freshRasters().filter((p) => !landedRasters.has(p))
      if (fresh.length === 0 && pendingRenderWork() === 0) return result(true)
    }
  }

  for (;;) {
    phases.passes += 1
    // 1. The slide's objects are in the scene.
    if (missing().length > 0) {
      if ((await timed('framesMs', () => bounded(nextFrame))) === TIMEOUT) return gaveUp()
      continue
    }

    // 2. Loads and fonts.
    const loads = await timed('loadsMs', async () =>
      (await bounded((signal) => whenRenderWorkIdle(signal))) === TIMEOUT
        ? TIMEOUT
        : bounded(() => document.fonts.ready),
    )
    if (loads === TIMEOUT) return gaveUp()

    // 3. Text rasters the latest frame started.
    draw()
    const fresh = freshRasters()
    if (fresh.length > 0) {
      phases.rasters += fresh.length
      if ((await timed('rastersMs', () => bounded(() => Promise.allSettled(fresh)))) === TIMEOUT) {
        return gaveUp()
      }
      for (const p of fresh) {
        drawn.add(p)
        landedRasters.add(p)
      }
      draw()
      continue
    }

    // 4. Quiet for two frames.
    if ((await timed('framesMs', () => bounded(nextFrame))) === TIMEOUT) return gaveUp()
    if ((await timed('framesMs', () => bounded(nextFrame))) === TIMEOUT) return gaveUp()
    if (pendingRenderWork() > 0 || missing().length > 0 || freshRasters().length > 0) continue

    draw()
    return result(true)
  }
}
