/**
 * perf/harness.ts — the in-page half of the performance harness
 * (docs/plans/perf-harness.md → The counters, Measuring time precisely).
 *
 * A chunk of its own, loaded by perf/activation.ts only with `?perf=1` (any
 * build) or on demand in dev. Installs, once:
 *
 *   - GL counters: the WebGL prototypes are wrapped (the context wrap the
 *     crowded-slide probe used): draw calls, stencil toggles and clears,
 *     mipmap generations, texture uploads and their kilopixels, buffer
 *     uploads, framebuffer binds — `gl.*` for the editor's context,
 *     `gl.thumb.*` for every other (the thumbnail renderer);
 *   - network counters: every resource the page fetched, by route
 *     (`/api/media/:id/url`) and bucket (`net.mediaUrl`, `net.api`, …);
 *   - the editor frame hook: each `renderer.render` is timed, and while
 *     inputs or fences wait for it, followed by a 1-px `readPixels` — the GPU
 *     fence: the frame has been drawn when it returns;
 *   - input-to-pixel: pointer, wheel and key events, from `event.timeStamp`
 *     to the fenced editor frame that followed them (or, when no canvas frame
 *     followed, the next painted frame);
 *   - a frame recorder (rAF), long tasks and Event Timing where the engine
 *     has them (Chromium; WebKit has neither — CDP-free all the same).
 *
 * `window.__narrative_perf_harness` is the API Playwright drives
 * (apps/web/e2e/perf/). It reads; the only things it changes are the
 * selection (editor state, not the document) and, on request, the clip masks
 * (a diagnostic). React render counts come from a DevTools hook the driver
 * installs before the page loads (React reads the hook while its own chunk
 * evaluates, before any lazily loaded code could).
 */

import type { SlideObject } from '@narrative/shared'
import type { Application } from 'pixi.js'
import {
  editorGl,
  instrumentRender,
  mountedIds,
  objectData,
  pendingTextRestage,
  pendingThumbnailWork,
  renderNow,
  setKeepWarmEnabled,
  setKeepWarmFrame,
  setKeepWarmTarget,
  setPresentIdleFallback,
  stripMasks,
  type KeepWarmFrame,
  type KeepWarmTarget,
  type PresentIdleFallback,
  type RenderKind,
} from '../renderer/perfProbes.js'
import { getDefaultResourceManager } from '../renderer/ResourceManager.js'
import type { RenderScheduler } from '../renderer/RenderScheduler.js'
import type { SceneGraph } from '../renderer/SceneGraph.js'
import { forcePlaybackKind } from '../renderer/videoRendition.js'
import type { LoadTimings } from '../state/loadTimings.js'
import { COUNTS_KEY, onPerfCanvas } from './activation.js'
import { GlResidency, type GlResidencySnapshot } from './glResidency.js'
import {
  netBucket,
  routeOf,
  settleInputs,
  texUploadPixels,
  type InputLatency,
  type PendingInput,
} from './measure.js'

declare const __BUILD_MODE__: string

export interface PerfRecording {
  /** Recording length, ms. */
  durationMs: number
  /** `markInputEnd()` time from the start, ms (null: never marked). */
  inputEndMs: number | null
  /** rAF frame durations, ms, in order, with their start (ms from the recording's start). */
  frames: Array<{ at: number; ms: number }>
  /** Long tasks (Chromium); null where the engine has no Long Tasks API. */
  longTasks: Array<{ at: number; ms: number }> | null
  /** Events over 16 ms (Event Timing, Chromium); null where unsupported. */
  slowEvents: Array<{ name: string; ms: number }> | null
  /** Input-to-pixel per input event. */
  inputs: InputLatency[]
  /** The editor's frames: how many, their `render` time, the most draw calls one took. */
  renders: { count: number; ms: number; maxMs: number; drawsMax: number }
  /** When each zoom's text restaging finished (ms from the start). */
  restagesDone: number[]
  /**
   * `performance.now()` at the recording's start: the origin of every `at`.
   * Optional: a build's harness before 2026-10-19 (an A/B's older side) has none.
   */
  startedAt?: number
  /** Each on-screen editor render: its start (ms from the recording's start) and duration (optional as `startedAt`). */
  renderLog?: Array<{ at: number; ms: number }>
  /** Each keep-warm draw of the present canvas (no frame of its own; optional as `startedAt`). */
  keepWarmLog?: Array<{ at: number; ms: number }>
  /**
   * Each input fence (the 1-px `readPixels` after a frame that showed an
   * input): when it ran and how long the main thread waited in it — the GPU
   * work of that frame and the round trip (optional as `startedAt`).
   */
  fenceLog?: Array<{ at: number; ms: number }>
  /**
   * Main-thread gaps over `GAP_MS` seen by the gap probe (`setGapProbe`):
   * the main thread was busy (or not scheduled) that long. Empty unless the
   * probe was on; the CDP-free stand-in for long tasks in WebKit.
   */
  gapLog?: Array<{ at: number; ms: number }>
}

/**
 * One editor frame as a coarse picture: the drawing buffer read back right
 * after `render` and averaged over `cell`-px squares (RGB means, row by row
 * from the bottom — GL's origin). Two frames that show the same slide fully
 * drawn are equal cell for cell; a text or picture still missing moves the
 * cells it covers.
 */
export interface CapturedFrame {
  /** `performance.now()` when the frame was drawn. */
  at: number
  /** The slide the present / editor container said was active then. */
  slideId: string | null
  cols: number
  rows: number
  /** cols × rows × 3 channel means, 0–255. */
  cells: number[]
}

export interface ReactStats {
  commits: number
  renders: number
  /** Renders and own time per component (names are minified in prod builds; dev and profiling keep them). */
  byName: Array<{ name: string; n: number; ms: number }>
}

export interface SettleResult {
  ok: boolean
  /** ms waited. */
  waitedMs: number
  /** Why not, when not. */
  reason?: string
}

export interface PerfHarnessApi {
  readonly version: 1
  /** The build this page runs: dev (Vite dev server), prod or profiling. */
  buildMode(): string
  gl(): { vendor: string; renderer: string } | null
  features(): { longTask: boolean; eventTiming: boolean }
  /** Every counter since the last reset: work counters, GL, network, React. */
  counters(): Record<string, number>
  /** Requests since the last reset, by route. */
  routes(): Record<string, number>
  react(): ReactStats | null
  reset(): void
  startRecording(): void
  markInputEnd(): void
  stopRecording(): PerfRecording
  /** Every long task seen since the harness loaded (buffered: from the page's start), page clock. */
  longTasks(): Array<{ at: number; ms: number }> | null
  /**
   * Fence every frame that shows an input (default on). Off for a CPU
   * profile: a `readPixels` per frame under the profiler stalls the page for
   * seconds and the profile shows the fence instead of the app; latencies
   * are then taken at the end of `render` (CPU side only).
   */
  setInputFence(on: boolean): void
  /** Resolves (with `performance.now()`) once the next editor frame has been drawn on the GPU. */
  fence(): Promise<number>
  /** Waits until nothing happens for `quietMs`: no frame, no counter moving, no load or raster in flight. */
  settle(opts?: {
    quietMs?: number
    timeoutMs?: number
    expectedIds?: string[]
    /**
     * Also wait until no released texture is still waiting out its unload
     * grace (ResourceManager.pendingUnloads): the memory benches count GPU
     * textures, and one on its way out is not growth.
     */
    unloads?: boolean
  }): Promise<SettleResult>
  mountedIds(): string[]
  object(id: string): SlideObject | null
  setSelection(ids: string[]): void
  loadTimings(): LoadTimings | null
  stripMasks(): number
  /**
   * Read back every editor frame from now on as a coarse picture
   * (`CapturedFrame`) — for the e2e specs that prove a slide is shown whole
   * on its first frame. Costs a full read-back per frame: never during a
   * timed run.
   */
  startFrameCapture(opts?: { cell?: number }): void
  /** Stop and hand over the frames captured since `startFrameCapture`. */
  stopFrameCapture(): CapturedFrame[]
  /** Draw a frame now and return it as a coarse picture (null without a GL canvas). */
  captureNow(opts?: { cell?: number }): CapturedFrame | null
  /**
   * What the editor's GL context holds now (never reset): textures created
   * and not deleted. Growth across repeated runs of the same pass is a leak
   * (performance.md → E8).
   */
  glLive(): { textures: number }
  /**
   * What the page holds now, for the growth benches (memory.spec.ts,
   * performance.md → E8): the editor context's textures and renderbuffers
   * with their bytes (glResidency.ts; bytes and renderbuffers only on a page
   * whose `window.__narrative_perf_residency` was true when the harness
   * loaded, 0 otherwise), the same summed over every live
   * context (thumbnails, offscreen renders), the contexts alive and not lost,
   * the elements in the document, the object URLs created and not revoked.
   * CDP-free: the JS heap and the listeners come from CDP (Chromium only).
   */
  memory(): PerfMemory
  /** Present mode's keep-warm draws since the harness loaded (renderer/presentSlides.ts → "Kept warm"). */
  keepWarmDraws(): number
  /**
   * A diagnostic: while recording, watch the main thread with a timer chain
   * and log every gap over `GAP_MS` (`PerfRecording.gapLog`). Costs a wakeup
   * every few milliseconds — never on in a stored run. A page whose
   * `window.__narrative_perf_gapProbe` is `true` when the harness loads
   * starts with it on.
   */
  setGapProbe(on: boolean): void
  /**
   * A diagnostic: switch present mode's keep-warm off (or on again). A page
   * whose `window.__narrative_perf_keepWarm` is `false` when the harness
   * loads starts with it off (present.spec.ts, PERF_KEEP_WARM_AB=1).
   */
  setKeepWarm(on: boolean): void
  /**
   * A diagnostic: how keep-warm presents its frame (renderer/presentKeepWarm.ts
   * → KeepWarmFrame). A page whose `window.__narrative_perf_keepWarmFrame` is
   * set when the harness loads starts with that mode (present.spec.ts,
   * PERF_PRESENT_AB).
   */
  setKeepWarmFrame(mode: KeepWarmFrame): void
  /**
   * A diagnostic: what present mode's idle turns wait for where the engine
   * has no idle callbacks (renderer/presentKeepWarm.ts → PresentIdleFallback).
   * A page whose `window.__narrative_perf_presentIdle` is set when the harness
   * loads starts with that mode.
   */
  setPresentIdleFallback(mode: PresentIdleFallback): void
  /** A diagnostic: what keep-warm draws into (renderer/presentKeepWarm.ts → KeepWarmTarget). */
  setKeepWarmTarget(mode: KeepWarmTarget): void
  /**
   * A diagnostic: from now on keep each texture upload of the editor's
   * context (its size, and the stack that made it) until read; null stops.
   * Which picture or text an unexpected upload was.
   */
  traceUploads(on: boolean): Array<{ w: number; h: number; stack: string }>
}

export interface PerfMemory {
  /** The editor's context (null: no canvas). */
  editor: GlResidencySnapshot | null
  /** Every WebGL context alive and not lost, summed. */
  all: GlResidencySnapshot
  contexts: number
  /** Elements in the document (attached). */
  domNodes: number
  canvases: number
  videos: number
  /** Object URLs created and not revoked (thumbnails, rasters, media). */
  blobUrls: number
}

interface ReactProbe {
  commits: number
  renders: number
  byName: Record<string, { n: number; ms: number }>
}

/**
 * The counters, for the harness chunk — the same record @narrative/shared's
 * `perfCount` writes, reached through the global so that the chunk does not
 * share (and split out) that module with the editor's chunks.
 */
const countsHolder = globalThis as { [COUNTS_KEY]?: Record<string, number> | null }
function counts(): Record<string, number> | null {
  return countsHolder[COUNTS_KEY] ?? null
}
function perfCount(key: string, n = 1): void {
  const c = counts()
  if (c !== null) c[key] = (c[key] ?? 0) + n
}
function startPerfCounters(): void {
  countsHolder[COUNTS_KEY] ??= {}
}
function resetPerfCounters(): void {
  if (counts() !== null) countsHolder[COUNTS_KEY] = {}
}
function readPerfCounters(): Record<string, number> {
  const c = counts()
  return c === null ? {} : { ...c }
}

const STENCIL_TEST = 0x0b90
const STENCIL_BUFFER_BIT = 0x400

let api: PerfHarnessApi | null = null

/** The gap probe's threshold: a timer that fired this much later than it could have, ms. */
const GAP_MS = 12

export function installPerfHarness(): void {
  if (api !== null) return
  startPerfCounters()

  // --- the editor canvas -----------------------------------------------------
  let app: Application | null = null
  let sceneGraph: SceneGraph | null = null
  let scheduler: RenderScheduler | null = null
  let pendingLoads: (() => number) | null = null
  let editorContext: WebGL2RenderingContext | WebGLRenderingContext | null = null
  let unhookRender: (() => void) | null = null
  let editorDraws = 0
  let drawsAtLastRender = 0
  let lastRenderAt = -Infinity
  /** Keep-warm draws of the present canvas since the harness loaded (renderer/presentSlides.ts). */
  let keepWarmDraws = 0
  /** A keep-warm draw is under way: its GL calls are not counted. */
  let inKeepWarm = false

  // --- GL --------------------------------------------------------------------
  /**
   * What each context holds (glResidency.ts), fed from its calls, keep-warm
   * draws included (residency is state, not work). Contexts are held weakly:
   * a context the page dropped is collected as it would be without the probe.
   */
  const residency = new WeakMap<object, GlResidency>()
  /** memory.spec.ts sets `window.__narrative_perf_residency` in an init script. */
  const residencyBytes =
    (window as unknown as { __narrative_perf_residency?: boolean }).__narrative_perf_residency ===
    true
  const contexts = new Set<WeakRef<WebGL2RenderingContext | WebGLRenderingContext>>()
  const residencyOf = (ctx: WebGL2RenderingContext | WebGLRenderingContext): GlResidency => {
    let r = residency.get(ctx)
    if (r === undefined) {
      r = new GlResidency()
      residency.set(ctx, r)
      contexts.add(new WeakRef(ctx))
    }
    return r
  }
  let uploadTrace: Array<{ w: number; h: number; stack: string }> | null = null
  const readPixels = new Map<object, (...a: unknown[]) => unknown>()
  const wrapGl = (proto: Record<string, unknown>): void => {
    const wrap = (name: string, count: (prefix: string, args: unknown[]) => void): void => {
      const original = proto[name] as ((...a: unknown[]) => unknown) | undefined
      if (typeof original !== 'function') return
      proto[name] = function (this: unknown, ...args: unknown[]): unknown {
        const editor = this === editorContext
        // Present mode's keep-warm draw is maintenance: none of its GL calls is work.
        if (editor && inKeepWarm) return original.apply(this, args)
        count(editor ? 'gl' : 'gl.thumb', args)
        if (editor && name.startsWith('draw')) editorDraws++
        return original.apply(this, args)
      }
    }
    readPixels.set(proto, proto['readPixels'] as (...a: unknown[]) => unknown)
    for (const n of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced'])
      wrap(n, (p) => perfCount(`${p}.draw`))
    wrap('enable', (p, a) => {
      if (a[0] === STENCIL_TEST) perfCount(`${p}.stencil`)
    })
    wrap('disable', (p, a) => {
      if (a[0] === STENCIL_TEST) perfCount(`${p}.stencil`)
    })
    wrap('clear', (p, a) => {
      if (((a[0] as number) & STENCIL_BUFFER_BIT) !== 0) perfCount(`${p}.stencilClear`)
    })
    wrap('generateMipmap', (p) => perfCount(`${p}.mipmap`))
    for (const m of ['texImage2D', 'texSubImage2D'] as const)
      wrap(m, (p, a) => {
        const px = texUploadPixels(m, a)
        if (px === null) return
        perfCount(`${p}.texUpload`)
        perfCount(`${p}.texUploadKpx`, Math.round(px / 1000))
        if (uploadTrace !== null && p === 'gl') {
          const src = a.find((x) => typeof x === 'object' && x !== null) as
            { width?: number; height?: number } | undefined
          uploadTrace.push({
            w: src?.width ?? 0,
            h: src?.height ?? 0,
            stack: (new Error().stack ?? '').split('\n').slice(2, 14).join('\n'),
          })
        }
      })
    wrap('bufferData', (p) => perfCount(`${p}.bufferData`))
    wrap('bindFramebuffer', (p) => perfCount(`${p}.fbBind`))
    // Residency: every call, every context, keep-warm included. Creations
    // and deletions always (rare calls; glLive); bindings and allocations —
    // a wrap on every bindTexture of every frame — only for the growth
    // benches, which ask for it before the page loads (`residencyBytes`).
    const track = (
      name: string,
      follow: (r: GlResidency, args: unknown[], result: unknown) => void,
    ): void => {
      const original = proto[name] as ((...a: unknown[]) => unknown) | undefined
      if (typeof original !== 'function') return
      if (!residencyBytes && name !== 'createTexture' && name !== 'deleteTexture') return
      proto[name] = function (this: unknown, ...args: unknown[]): unknown {
        const result = original.apply(this, args)
        follow(residencyOf(this as WebGL2RenderingContext), args, result)
        return result
      }
    }
    track('createTexture', (r, _a, tex) => r.createTexture(tex))
    track('deleteTexture', (r, a) => r.deleteTexture(a[0]))
    track('activeTexture', (r, a) => r.activeTexture(a[0]))
    track('bindTexture', (r, a) => r.bindTexture(a[0], a[1]))
    track('texImage2D', (r, a) => r.texImage2D(a))
    track('texStorage2D', (r, a) => r.texStorage2D(a))
    track('generateMipmap', (r, a) => r.generateMipmap(a[0]))
    track('createRenderbuffer', (r, _a, rb) => r.createRenderbuffer(rb))
    track('deleteRenderbuffer', (r, a) => r.deleteRenderbuffer(a[0]))
    track('bindRenderbuffer', (r, a) => r.bindRenderbuffer(a[1]))
    track('renderbufferStorage', (r, a) => r.renderbufferStorage(a, false))
    track('renderbufferStorageMultisample', (r, a) => r.renderbufferStorage(a, true))
  }
  if (typeof WebGL2RenderingContext !== 'undefined')
    wrapGl(WebGL2RenderingContext.prototype as unknown as Record<string, unknown>)
  if (typeof WebGLRenderingContext !== 'undefined')
    wrapGl(WebGLRenderingContext.prototype as unknown as Record<string, unknown>)

  const pixel = new Uint8Array(4)
  const gpuFence = (): void => {
    const gl = editorContext
    if (gl === null) return
    const read = readPixels.get(Object.getPrototypeOf(gl) as object)
    const t = performance.now()
    read?.call(gl, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    if (recording) fenceLog.push({ at: t - recStart, ms: performance.now() - t })
  }

  // --- object URLs -------------------------------------------------------------
  const blobUrls = new Set<string>()
  const createObjectURL = URL.createObjectURL.bind(URL)
  const revokeObjectURL = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = (obj: Blob | MediaSource): string => {
    const url = createObjectURL(obj)
    blobUrls.add(url)
    return url
  }
  URL.revokeObjectURL = (url: string): void => {
    blobUrls.delete(url)
    revokeObjectURL(url)
  }

  // --- network ---------------------------------------------------------------
  let routes: Record<string, number> = {}
  try {
    performance.setResourceTimingBufferSize(10_000)
  } catch {
    /* not supported */
  }
  const supported = (type: string): boolean =>
    typeof PerformanceObserver !== 'undefined' &&
    (PerformanceObserver.supportedEntryTypes ?? []).includes(type)
  if (supported('resource')) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const route = routeOf(e.name, location.origin)
        routes[route] = (routes[route] ?? 0) + 1
        perfCount('net.requests')
        perfCount(netBucket(route))
      }
    }).observe({ type: 'resource', buffered: true })
  }

  // --- long tasks, event timing ------------------------------------------------
  const longTasks: Array<{ start: number; ms: number }> = []
  const slowEvents: Array<{ start: number; name: string; ms: number }> = []
  const hasLongTask = supported('longtask')
  const hasEventTiming = supported('event')
  if (hasLongTask)
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push({ start: e.startTime, ms: e.duration })
    }).observe({ type: 'longtask', buffered: true })
  if (hasEventTiming)
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        slowEvents.push({ start: e.startTime, name: e.name, ms: e.duration })
    }).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit)

  // --- recording ---------------------------------------------------------------
  let recording = false
  let recStart = 0
  let inputEnd: number | null = null
  let frames: Array<{ at: number; ms: number }> = []
  let inputs: InputLatency[] = []
  let pending: PendingInput[] = []
  let renders = { count: 0, ms: 0, maxMs: 0, drawsMax: 0 }
  let restagesDone: number[] = []
  let renderLog: Array<{ at: number; ms: number }> = []
  let keepWarmLog: Array<{ at: number; ms: number }> = []
  let fenceLog: Array<{ at: number; ms: number }> = []
  let gapLog: Array<{ at: number; ms: number }> = []
  let gapProbe =
    (window as unknown as { __narrative_perf_gapProbe?: boolean }).__narrative_perf_gapProbe ===
    true
  /** The pending tick of the gap probe (cleared when recording stops). */
  let gapTimer: ReturnType<typeof setTimeout> | null = null
  const gapTick = (scheduledAt: number): void => {
    gapTimer = null
    if (!recording || !gapProbe) return
    const now = performance.now()
    // A zero-delay timer runs within ~4 ms (nested timers are clamped to
    // that): one that ran over GAP_MS later than that found the main thread busy.
    if (now - scheduledAt - 4 > GAP_MS)
      gapLog.push({ at: scheduledAt - recStart, ms: now - scheduledAt })
    gapTimer = setTimeout(() => gapTick(now), 0)
  }
  let fenceWaiters: Array<(t: number) => void> = []
  let domCheckScheduled = false
  let inputFence = true

  // --- frame read-back (e2e only) -------------------------------------------
  let capture: { cell: number; frames: CapturedFrame[] } | null = null
  let readBuf: Uint8Array | null = null
  const grabFrame = (cell: number): CapturedFrame | null => {
    const gl = editorContext
    if (gl === null) return null
    const w = gl.drawingBufferWidth
    const h = gl.drawingBufferHeight
    if (readBuf === null || readBuf.length !== w * h * 4) readBuf = new Uint8Array(w * h * 4)
    const read = readPixels.get(Object.getPrototypeOf(gl) as object)
    read?.call(gl, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, readBuf)
    const cols = Math.floor(w / cell)
    const rows = Math.floor(h / cell)
    const cells = new Float64Array(cols * rows * 3)
    const buf = readBuf
    for (let y = 0; y < rows * cell; y++) {
      const row = Math.floor(y / cell)
      for (let x = 0; x < cols * cell; x++) {
        const i = (y * w + x) * 4
        const c = (row * cols + Math.floor(x / cell)) * 3
        cells[c] = cells[c]! + buf[i]!
        cells[c + 1] = cells[c + 1]! + buf[i + 1]!
        cells[c + 2] = cells[c + 2]! + buf[i + 2]!
      }
    }
    const n = cell * cell
    const means: number[] = Array.from(cells, (v) => Math.round(v / n))
    const el = document.querySelector('[data-active-slide-id]')
    return {
      at: performance.now(),
      slideId: el?.getAttribute('data-active-slide-id') ?? null,
      cols,
      rows,
      cells: means,
    }
  }

  const onRender = (startedAt: number, ms: number, kind: RenderKind): void => {
    // The present canvas keeping the slides around the presenter warm: no
    // frame, no work — "quiet" does not wait for it to stop (it never does).
    if (kind === 'keepWarm') {
      inKeepWarm = false
      keepWarmDraws++
      if (recording) keepWarmLog.push({ at: startedAt - recStart, ms })
      return
    }
    if (kind === 'offscreen') {
      // A slide prepared off stage drawn into its own texture: not a frame.
      perfCount('editor.render.offscreen')
      lastRenderAt = startedAt + ms
      return
    }
    if (capture !== null) {
      const f = grabFrame(capture.cell)
      if (f !== null) capture.frames.push(f)
    }
    lastRenderAt = startedAt + ms
    perfCount('editor.render')
    const draws = editorDraws - drawsAtLastRender
    drawsAtLastRender = editorDraws
    if (recording) {
      renderLog.push({ at: startedAt - recStart, ms })
      renders.count++
      renders.ms += ms
      renders.maxMs = Math.max(renders.maxMs, ms)
      renders.drawsMax = Math.max(renders.drawsMax, draws)
    }
    if (pending.length === 0 && fenceWaiters.length === 0) return
    if (inputFence || fenceWaiters.length > 0) gpuFence()
    const t = performance.now()
    if (pending.length > 0) {
      const { resolved, waiting } = settleInputs(pending, startedAt, t, 'canvas')
      inputs.push(...resolved)
      pending = waiting
    }
    const waiters = fenceWaiters
    fenceWaiters = []
    for (const w of waiters) w(t)
  }

  onPerfCanvas((canvas) => {
    unhookRender?.()
    unhookRender = null
    app = (canvas?.app as Application | undefined) ?? null
    sceneGraph = (canvas?.sceneGraph as SceneGraph | undefined) ?? null
    scheduler = (canvas?.scheduler as RenderScheduler | undefined) ?? null
    pendingLoads = canvas?.pendingLoads ?? null
    editorContext = app === null ? null : editorGl(app)
    if (app !== null)
      unhookRender = instrumentRender(app, onRender, (kind) => {
        inKeepWarm = kind === 'keepWarm'
      })
  })

  // A DOM-only input (typing into the text overlay, a panel) is shown by the
  // next painted frame: rAF, then a task after it (the paint happens between).
  const scheduleDomCheck = (): void => {
    if (domCheckScheduled) return
    domCheckScheduled = true
    requestAnimationFrame((frameStart) => {
      let paintedAt = -1
      const ch = new MessageChannel()
      ch.port1.onmessage = () => {
        paintedAt = performance.now()
      }
      ch.port2.postMessage(0)
      // One frame more for a canvas frame to claim the inputs first.
      requestAnimationFrame(() => {
        domCheckScheduled = false
        if (paintedAt < 0) paintedAt = performance.now()
        const { resolved, waiting } = settleInputs(pending, frameStart, paintedAt, 'dom')
        if (recording) inputs.push(...resolved)
        pending = waiting
        if (pending.length > 0) scheduleDomCheck()
      })
    })
  }
  const onInput = (e: Event): void => {
    if (!recording) return
    pending.push({ type: e.type, at: e.timeStamp })
    scheduleDomCheck()
  }
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown'])
    window.addEventListener(type, onInput, { capture: true, passive: true })

  let lastFrameAt = 0
  let wasRestaging = false
  const frameLoop = (now: number): void => {
    if (!recording) return
    frames.push({ at: lastFrameAt - recStart, ms: now - lastFrameAt })
    lastFrameAt = now
    const restaging = sceneGraph !== null && pendingTextRestage(sceneGraph) > 0
    if (wasRestaging && !restaging) restagesDone.push(now - recStart)
    wasRestaging = restaging
    requestAnimationFrame(frameLoop)
  }

  const reactProbe = (): ReactProbe | null =>
    (window as unknown as { __narrative_react_perf?: ReactProbe }).__narrative_react_perf ?? null

  // present.spec.ts's keep-warm A/B: this page measures without it.
  if (
    (window as unknown as { __narrative_perf_keepWarm?: boolean }).__narrative_perf_keepWarm ===
    false
  )
    setKeepWarmEnabled(false)
  const frameMode = (window as unknown as { __narrative_perf_keepWarmFrame?: KeepWarmFrame })
    .__narrative_perf_keepWarmFrame
  if (frameMode !== undefined) setKeepWarmFrame(frameMode)
  const idleMode = (window as unknown as { __narrative_perf_presentIdle?: PresentIdleFallback })
    .__narrative_perf_presentIdle
  if (idleMode !== undefined) setPresentIdleFallback(idleMode)
  // present.spec.ts's rendition A/B (PERF_VIDEO_RENDITION_AB): this page plays
  // one file of every video, whatever the screen (renderer/videoRendition.ts).
  const forcedRendition = (
    window as unknown as { __narrative_perf_videoRendition?: 'present' | 'playback' }
  ).__narrative_perf_videoRendition
  if (forcedRendition === 'present' || forcedRendition === 'playback')
    forcePlaybackKind(forcedRendition)

  const harness: PerfHarnessApi = {
    version: 1,
    buildMode() {
      const mode = typeof __BUILD_MODE__ === 'string' ? __BUILD_MODE__ : 'unknown'
      return mode === 'development' ? 'dev' : mode === 'production' ? 'prod' : mode
    },
    gl() {
      const gl = editorContext
      if (gl === null) return null
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      return {
        vendor: String(gl.getParameter(ext?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR)),
        renderer: String(gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)),
      }
    },
    features: () => ({ longTask: hasLongTask, eventTiming: hasEventTiming }),
    counters() {
      const out = readPerfCounters()
      const r = reactProbe()
      if (r !== null) {
        out['react.commits'] = r.commits
        out['react.renders'] = r.renders
      }
      return out
    },
    routes: () => ({ ...routes }),
    react() {
      const r = reactProbe()
      if (r === null) return null
      return {
        commits: r.commits,
        renders: r.renders,
        byName: Object.entries(r.byName)
          .map(([name, v]) => ({ name, n: v.n, ms: v.ms }))
          .sort((a, b) => b.n - a.n),
      }
    },
    reset() {
      resetPerfCounters()
      routes = {}
      const r = reactProbe()
      if (r !== null) {
        r.commits = 0
        r.renders = 0
        r.byName = {}
      }
    },
    startRecording() {
      recording = true
      recStart = performance.now()
      inputEnd = null
      frames = []
      inputs = []
      pending = []
      renders = { count: 0, ms: 0, maxMs: 0, drawsMax: 0 }
      restagesDone = []
      renderLog = []
      keepWarmLog = []
      fenceLog = []
      gapLog = []
      if (gapProbe && gapTimer === null) {
        const t = performance.now()
        gapTimer = setTimeout(() => gapTick(t), 0)
      }
      wasRestaging = false
      lastFrameAt = recStart
      slowEvents.length = 0
      requestAnimationFrame(frameLoop)
    },
    markInputEnd() {
      inputEnd = performance.now() - recStart
    },
    stopRecording() {
      recording = false
      if (gapTimer !== null) clearTimeout(gapTimer)
      gapTimer = null
      const end = performance.now()
      const inWindow = (t: number): boolean => t >= recStart && t <= end
      return {
        durationMs: end - recStart,
        inputEndMs: inputEnd,
        frames: frames.slice(1),
        longTasks: hasLongTask
          ? longTasks
              .filter((l) => inWindow(l.start))
              .map((l) => ({ at: l.start - recStart, ms: l.ms }))
          : null,
        slowEvents: hasEventTiming
          ? slowEvents.filter((e) => inWindow(e.start)).map((e) => ({ name: e.name, ms: e.ms }))
          : null,
        inputs: [...inputs],
        renders: { ...renders },
        restagesDone: [...restagesDone],
        startedAt: recStart,
        renderLog: [...renderLog],
        keepWarmLog: [...keepWarmLog],
        fenceLog: [...fenceLog],
        gapLog: [...gapLog],
      }
    },
    setInputFence(on) {
      inputFence = on
    },
    longTasks: () => (hasLongTask ? longTasks.map((l) => ({ at: l.start, ms: l.ms })) : null),
    fence() {
      return new Promise<number>((resolve) => {
        fenceWaiters.push(resolve)
        let waited = 0
        const tick = (): void => {
          if (!fenceWaiters.includes(resolve)) return
          if (++waited >= 2 && scheduler !== null) renderNow(scheduler)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    },
    settle(opts = {}) {
      const quietMs = opts.quietMs ?? 800
      const timeoutMs = opts.timeoutMs ?? 30_000
      const t0 = performance.now()
      return new Promise<SettleResult>((resolve) => {
        let lastKey = ''
        let quietSince = performance.now()
        const tick = (): void => {
          const now = performance.now()
          const c = readPerfCounters()
          const busy: string[] = []
          if ((c['text.raster.started'] ?? 0) > (c['text.raster.finished'] ?? 0))
            busy.push('text rasters')
          if ((c['thumb.text.raster.started'] ?? 0) > (c['thumb.text.raster.finished'] ?? 0))
            busy.push('thumbnail rasters')
          if (sceneGraph !== null && pendingTextRestage(sceneGraph) > 0) busy.push('text restage')
          if ((pendingLoads?.() ?? 0) > 0) busy.push('loads')
          if (opts.unloads === true && getDefaultResourceManager().pendingUnloads() > 0)
            busy.push('texture unloads')
          // Thumbnails queued for idle time, debouncing or retrying move no counter yet.
          if (pendingThumbnailWork() > 0) busy.push('thumbnails')
          if (opts.expectedIds !== undefined) {
            const have = new Set(sceneGraph === null ? [] : mountedIds(sceneGraph))
            if (!opts.expectedIds.every((id) => have.has(id))) busy.push('objects not mounted')
          }
          // Quiet: no counter moved, nothing in flight, no frame drawn, for quietMs.
          const key = JSON.stringify(c)
          if (key !== lastKey || busy.length > 0) quietSince = now
          lastKey = key
          if (now - quietSince >= quietMs && now - lastRenderAt >= quietMs)
            return resolve({ ok: true, waitedMs: now - t0 })
          if (now - t0 > timeoutMs)
            return resolve({
              ok: false,
              waitedMs: now - t0,
              reason: busy.join(', ') || 'counters or frames never stopped',
            })
          setTimeout(tick, 50)
        }
        tick()
      })
    },
    mountedIds: () => (sceneGraph === null ? [] : mountedIds(sceneGraph)),
    object: (id) => (sceneGraph === null ? null : objectData(sceneGraph, id)),
    setSelection(ids) {
      window.dispatchEvent(new CustomEvent('narrative:test-set-selection', { detail: { ids } }))
    },
    // On window (state/loadTimings.ts) — read there, so this chunk imports
    // nothing the editor's chunks would have to be split around.
    loadTimings: () =>
      (window as unknown as { __narrative_perf?: { loadTimings?: LoadTimings } }).__narrative_perf
        ?.loadTimings ?? null,
    startFrameCapture(opts = {}) {
      capture = { cell: opts.cell ?? 40, frames: [] }
    },
    stopFrameCapture() {
      const frames = capture?.frames ?? []
      capture = null
      return frames
    },
    captureNow(opts = {}) {
      if (scheduler === null) return null
      const saved = capture
      capture = { cell: opts.cell ?? 40, frames: [] }
      try {
        renderNow(scheduler)
        return capture.frames.at(-1) ?? null
      } finally {
        capture = saved
      }
    },
    glLive: () => ({
      textures: editorContext === null ? 0 : residencyOf(editorContext).snapshot().textures,
    }),
    memory() {
      const all: GlResidencySnapshot = {
        textures: 0,
        textureBytes: 0,
        renderbuffers: 0,
        renderbufferBytes: 0,
        collected: 0,
      }
      let live = 0
      for (const ref of contexts) {
        const ctx = ref.deref()
        if (ctx === undefined) {
          contexts.delete(ref)
          continue
        }
        if (ctx.isContextLost()) continue
        live++
        const r = residencyOf(ctx).snapshot()
        all.textures += r.textures
        all.textureBytes += r.textureBytes
        all.renderbuffers += r.renderbuffers
        all.renderbufferBytes += r.renderbufferBytes
        all.collected += r.collected
      }
      return {
        editor: editorContext === null ? null : residencyOf(editorContext).snapshot(),
        all,
        contexts: live,
        domNodes: document.getElementsByTagName('*').length,
        canvases: document.getElementsByTagName('canvas').length,
        videos: document.getElementsByTagName('video').length,
        blobUrls: blobUrls.size,
      }
    },
    keepWarmDraws: () => keepWarmDraws,
    setKeepWarm: (on) => setKeepWarmEnabled(on),
    setKeepWarmFrame: (mode) => setKeepWarmFrame(mode),
    setPresentIdleFallback: (mode) => setPresentIdleFallback(mode),
    setKeepWarmTarget: (mode) => setKeepWarmTarget(mode),
    setGapProbe(on) {
      gapProbe = on
    },
    traceUploads(on) {
      const out = uploadTrace ?? []
      uploadTrace = on ? [] : null
      return out
    },
    stripMasks() {
      if (sceneGraph === null) return 0
      const n = stripMasks(sceneGraph)
      if (scheduler !== null) renderNow(scheduler)
      return n
    },
  }
  api = harness
  ;(window as unknown as { __narrative_perf_harness?: PerfHarnessApi }).__narrative_perf_harness =
    harness
}
