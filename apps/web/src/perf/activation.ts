/**
 * perf/activation.ts — when the performance harness is on, and the one door
 * between the editor and it (docs/plans/perf-harness.md → Decisions).
 *
 * This module is in the editor's eager bundle; everything else of the harness
 * (`./harness.ts` and what it imports) is a chunk of its own, loaded only when
 * asked for:
 *
 *   - `?perf=1` in the URL the page was loaded with — in every build mode
 *     (dev, prod, profiling): the counters start before anything renders, the
 *     harness chunk loads, and the canvas waits for it before Pixi starts so
 *     its GL counters see the first frame;
 *   - dev builds: the counters always run (they are a no-op call per site
 *     otherwise, and a record update here), and `window.__narrative_perf_load()`
 *     loads the harness on demand for the test API.
 *
 * Without `?perf=1` in a production build nothing here does anything but read
 * `location.search` once: `perfCount()` sites stay no-op calls, the harness
 * chunk is never fetched, and `whenPerfHarnessReady()` is a resolved promise.
 */

/**
 * `PERF_COUNTS_KEY` of @narrative/shared's perfCounters.ts, by value: importing
 * that module here would put it in a chunk of its own on the critical path
 * (activation.test.ts pins the two together).
 */
export const COUNTS_KEY = '__narrative_perf_counts'

/** What the harness reads from the editor canvas (registered by renderer/Canvas.tsx). */
export interface PerfCanvas {
  /** The editor's Pixi Application. */
  app: unknown
  /** The editor's SceneGraph. */
  sceneGraph: unknown
  /** The editor's RenderScheduler. */
  scheduler: unknown
  /** Loads the renderer tracks (renderer/renderWork.ts) still in flight. */
  pendingLoads: () => number
}

type CanvasListener = (canvas: PerfCanvas | null) => void

let requested: boolean | null = null
let harness: Promise<void> | null = null
let canvas: PerfCanvas | null = null
const canvasListeners = new Set<CanvasListener>()

function readFlag(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('perf') === '1'
  } catch {
    return false
  }
}

/** Whether this page was loaded with `?perf=1` (read once, at boot). */
export function perfRequested(): boolean {
  requested ??= readFlag()
  return requested
}

/** Whether the harness may be used on this page: dev builds, or `?perf=1`. */
export function perfAvailable(): boolean {
  return import.meta.env.DEV || perfRequested()
}

/** Load and install the harness chunk (once). */
export function loadPerfHarness(): Promise<void> {
  harness ??= import('./harness.js').then((m) => m.installPerfHarness())
  return harness
}

/**
 * Called once from main.tsx before the app renders: starts the counters and
 * the harness where they are wanted.
 */
export function bootPerf(): void {
  if (perfAvailable()) {
    const g = globalThis as Record<string, unknown>
    g[COUNTS_KEY] ??= {}
  }
  if (perfRequested()) void loadPerfHarness().catch((err: unknown) => console.error('[perf]', err))
  if (import.meta.env.DEV) {
    ;(window as unknown as { __narrative_perf_load?: () => Promise<void> }).__narrative_perf_load =
      loadPerfHarness
  }
}

/**
 * Resolves when the harness is installed, if this page asked for it; at once
 * otherwise (and when it failed to load: the editor never waits on a probe).
 */
export function whenPerfHarnessReady(): Promise<void> {
  if (!perfRequested()) return Promise.resolve()
  return loadPerfHarness().catch(() => undefined)
}

/** The editor canvas registers itself (and `null` when it goes); a no-op without the harness. */
export function registerPerfCanvas(next: PerfCanvas | null): void {
  if (!perfAvailable()) return
  canvas = next
  for (const l of canvasListeners) l(next)
}

/** The harness follows the editor canvas: called now with the current one, then on every change. */
export function onPerfCanvas(listener: CanvasListener): () => void {
  canvasListeners.add(listener)
  listener(canvas)
  return () => canvasListeners.delete(listener)
}
