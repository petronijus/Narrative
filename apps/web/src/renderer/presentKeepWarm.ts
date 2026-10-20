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
