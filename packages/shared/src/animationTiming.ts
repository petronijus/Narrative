/**
 * Where each animation step sits on a slide's timeline, in seconds from the
 * moment the slide appears — the times the editor's timeline draws and
 * `animation.retime` places steps at.
 *
 * It mirrors how the compiler (packages/animation/src/compiler.ts,
 * `resolvePosition`) positions steps:
 *   - the first step, and a legacy `onEnter` step → `delay`
 *   - `withPrevious`                   → the previous step's start + `delay`
 *   - `afterPrevious` and `onClick`    → the previous step's end + `delay`
 *
 * An `onClick` step is laid out as if the click came the moment the previous
 * step ended: the timeline has no "wait for input" gap.
 */

import type { AnimationStep } from './animation.js'

export interface TimedAnimationStep<S extends AnimationStep = AnimationStep> {
  step: S
  /** Seconds from the slide start. */
  start: number
}

export function layoutAnimationSteps<S extends AnimationStep>(
  steps: readonly S[],
): TimedAnimationStep<S>[] {
  const out: TimedAnimationStep<S>[] = []
  let prevStart = 0
  let prevEnd = 0
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (step === undefined) continue
    const delay = step.delay ?? 0
    let start: number
    if (i === 0 || step.trigger === 'onEnter') start = delay
    else if (step.trigger === 'withPrevious') start = prevStart + delay
    else start = prevEnd + delay
    out.push({ step, start })
    prevStart = start
    prevEnd = start + (step.duration ?? 0)
  }
  return out
}
