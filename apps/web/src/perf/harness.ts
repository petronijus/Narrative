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
  renderNow,
  stripMasks,
} from '../renderer/perfProbes.js'
import type { RenderScheduler } from '../renderer/RenderScheduler.js'
import type { SceneGraph } from '../renderer/SceneGraph.js'
import type { LoadTimings } from '../state/loadTimings.js'
import { COUNTS_KEY, onPerfCanvas } from './activation.js'
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
  }): Promise<SettleResult>
  mountedIds(): string[]
  object(id: string): SlideObject | null
  setSelection(ids: string[]): void
  loadTimings(): LoadTimings | null
  stripMasks(): number
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
function counts(): Record<string, number> | null {
  return (
    ((globalThis as Record<string, unknown>)[COUNTS_KEY] as
      Record<string, number> | null | undefined) ?? null
  )
}
function perfCount(key: string, n = 1): void {
  const c = counts()
  if (c !== null) c[key] = (c[key] ?? 0) + n
}
function startPerfCounters(): void {
  const g = globalThis as Record<string, unknown>
  g[COUNTS_KEY] ??= {}
}
function resetPerfCounters(): void {
  if (counts() !== null) (globalThis as Record<string, unknown>)[COUNTS_KEY] = {}
}
function readPerfCounters(): Record<string, number> {
  const c = counts()
  return c === null ? {} : { ...c }
}

const STENCIL_TEST = 0x0b90
const STENCIL_BUFFER_BIT = 0x400

let api: PerfHarnessApi | null = null

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

  // --- GL --------------------------------------------------------------------
  const readPixels = new Map<object, (...a: unknown[]) => unknown>()
  const wrapGl = (proto: Record<string, unknown>): void => {
    const wrap = (name: string, count: (prefix: string, args: unknown[]) => void): void => {
      const original = proto[name] as ((...a: unknown[]) => unknown) | undefined
      if (typeof original !== 'function') return
      proto[name] = function (this: unknown, ...args: unknown[]): unknown {
        const editor = this === editorContext
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
      })
    wrap('bufferData', (p) => perfCount(`${p}.bufferData`))
    wrap('bindFramebuffer', (p) => perfCount(`${p}.fbBind`))
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
    read?.call(gl, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
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
  let fenceWaiters: Array<(t: number) => void> = []
  let domCheckScheduled = false
  let inputFence = true

  const onRender = (startedAt: number, ms: number): void => {
    lastRenderAt = startedAt + ms
    perfCount('editor.render')
    const draws = editorDraws - drawsAtLastRender
    drawsAtLastRender = editorDraws
    if (recording) {
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
    if (app !== null) unhookRender = instrumentRender(app, onRender)
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
