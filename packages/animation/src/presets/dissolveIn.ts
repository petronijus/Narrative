/**
 * packages/animation/src/presets/dissolveIn.ts
 *
 * dissolveIn — slow, smooth alpha fade from 0 → 1. Like fadeIn but with
 * a sine easing and intentionally slower default feel, suited for
 * "material emerges" transitions. No position or scale change.
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

type Timeline = ReturnType<typeof gsap.timeline>

export function dissolveIn(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  const ease = step.easing || 'sine.inOut'

  if (target.kind === 'pixi') {
    const proxy = target.proxy
    const applyFn = target.apply.bind(target)
    tl.fromTo(
      proxy,
      { alpha: 0 },
      { alpha: 1, duration: step.duration, delay: step.delay, ease, onUpdate: applyFn },
      position,
    )
  } else {
    tl.fromTo(
      target.element,
      { opacity: 0 },
      { opacity: 1, duration: step.duration, delay: step.delay, ease },
      position,
    )
  }
}
