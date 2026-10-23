/**
 * renderer/presentKeepWarm.ts — the constants of present mode's keep-warm
 * draw (renderer/presentSlides.ts → "Kept warm"), apart so the perf harness
 * can recognise the draw without loading the slide cache.
 */

/** How often the slide shown and the slides one step away are drawn again while the presentation rests, ms. */
export const KEEP_WARM_MS = 500

/**
 * The label of the keep-warm target: a draw into it is maintenance, not a
 * frame and not work (the perf harness leaves it out of "quiet").
 */
export const KEEP_WARM_LABEL = 'present.keepWarm'

let inKeepWarmFrame = false

/** Run `draw` (a screen frame) as a keep-warm frame: the perf harness counts it as maintenance. */
export function asKeepWarmFrame<T>(draw: () => T): T {
  inKeepWarmFrame = true
  try {
    return draw()
  } finally {
    inKeepWarmFrame = false
  }
}

/** Whether the render under way is a keep-warm frame (renderer/perfProbes.ts). */
export function isKeepWarmFrame(): boolean {
  return inKeepWarmFrame
}

let enabled = true

/**
 * A diagnostic for the perf harness (`setKeepWarm`): switch keep-warm off to
 * measure an advance without it. On by default; nothing else turns it off.
 */
export function setKeepWarmEnabled(on: boolean): void {
  enabled = on
}

export function keepWarmEnabled(): boolean {
  return enabled
}

/**
 * How the keep-warm turn presents its frame of the canvas (a diagnostic for
 * the perf harness, `setKeepWarmFrame`; present.spec.ts PERF_PRESENT_AB):
 *   - `now`: drawn at once, in the idle turn that drew the targets (default);
 *   - `frame`: drawn at the start of the next animation frame, as any frame
 *     of the canvas is, unless a frame of the scheduler's draws it anyway;
 *   - `none`: no frame, the targets only.
 */
export type KeepWarmFrame = 'now' | 'frame' | 'none'

let frameMode: KeepWarmFrame = 'now'

export function setKeepWarmFrame(mode: KeepWarmFrame): void {
  frameMode = mode
}

export function keepWarmFrame(): KeepWarmFrame {
  return frameMode
}

/**
 * Where an engine has no idle callbacks (WebKit: Safari, the Tauri window —
 * `requestIdleCallback` is undefined there, 2026-10-23), what present mode's
 * idle turns (keep-warm, a slide prepared after ready) wait for:
 *   - `frame`: the moment right after the next frame has been rendered — the
 *     start of that frame's spare time (default);
 *   - `timer`: a 0-ms timer, wherever in the frame it lands (before
 *     2026-10-23; a diagnostic for the perf harness, `setPresentIdleFallback`).
 */
export type PresentIdleFallback = 'frame' | 'timer'

let idleFallback: PresentIdleFallback = 'frame'

export function setPresentIdleFallback(mode: PresentIdleFallback): void {
  idleFallback = mode
}

/**
 * An idle turn of present mode: an idle callback where the engine has them;
 * elsewhere (see PresentIdleFallback) right after the next rendered frame,
 * or a 0-ms timer. `timeout` ms at the latest either way — a hidden page
 * renders no frames. Returns a cancel.
 */
export function whenPresentIdle(cb: () => void, timeout: number): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(() => cb(), { timeout })
    return () => cancelIdleCallback(handle)
  }
  if (idleFallback === 'timer' || typeof requestAnimationFrame !== 'function') {
    const timer = setTimeout(cb, 0)
    return () => clearTimeout(timer)
  }
  let done = false
  let after: ReturnType<typeof setTimeout> | null = null
  const run = (): void => {
    if (done) return
    done = true
    cancel()
    cb()
  }
  // A task queued from a frame callback runs once that frame's rendering is
  // over: the frame's spare time starts there.
  const frame = requestAnimationFrame(() => {
    after = setTimeout(run, 0)
  })
  const latest = setTimeout(run, timeout)
  const cancel = (): void => {
    cancelAnimationFrame(frame)
    if (after !== null) clearTimeout(after)
    clearTimeout(latest)
  }
  return () => {
    done = true
    cancel()
  }
}

/**
 * What keep-warm draws the slides into (a diagnostic for the perf harness,
 * `setKeepWarmTarget`):
 *   - `pixel`: a 1 × 1 target — every texture is bound and sampled, at one
 *     texel each (default);
 *   - `eighth`: a target an eighth of the slide's size at the canvas's
 *     resolution, the slide scaled into it — every texture sampled every
 *     eight device pixels or so, across its whole area;
 *   - `full`: a slide-sized target at the canvas's resolution — every texel.
 */
export type KeepWarmTarget = 'pixel' | 'eighth' | 'full'

let targetMode: KeepWarmTarget = 'pixel'

export function setKeepWarmTarget(mode: KeepWarmTarget): void {
  targetMode = mode
}

export function keepWarmTarget(): KeepWarmTarget {
  return targetMode
}
