/**
 * packages/animation/src/presets/fadeIn.ts
 *
 * fadeIn preset factory.
 *
 * Pixi target: animuje proxy.alpha přes onUpdate → apply()
 * DOM target:  animuje CSS opacity přímo
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

// gsap.core.Timeline je ambient namespace type — přistupujeme přes ReturnType
type Timeline = ReturnType<typeof gsap.timeline>

export function fadeIn(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  const ease = step.easing || 'power2.out'

  if (target.kind === 'pixi') {
    const proxy = target.proxy
    const applyFn = target.apply.bind(target)
    tl.fromTo(
      proxy,
      { alpha: 0 },
      {
        alpha: 1,
        duration: step.duration,
        delay: step.delay,
        ease,
        onUpdate: applyFn,
      },
      position,
    )
  } else {
    tl.fromTo(
      target.element,
      { opacity: 0 },
      {
        opacity: 1,
        duration: step.duration,
        delay: step.delay,
        ease,
      },
      position,
    )
  }
}
