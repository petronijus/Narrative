/**
 * packages/animation/src/presets/fadeOut.ts
 *
 * fadeOut preset factory — alpha 1 → 0.
 *
 * Pixi target: animuje proxy.alpha přes onUpdate → apply()
 * DOM target:  animuje CSS opacity přímo
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

type Timeline = ReturnType<typeof gsap.timeline>

export function fadeOut(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  const ease = step.easing || 'power2.in'

  if (target.kind === 'pixi') {
    const proxy = target.proxy
    const applyFn = target.apply.bind(target)
    // Fade from the object's AUTHORED alpha (the proxy is seeded from the
    // container), not a hardcoded 1 — otherwise an object authored at
    // alpha < 1 visibly pops to full opacity before fading out.
    const baseAlpha = proxy.alpha
    tl.fromTo(
      proxy,
      { alpha: baseAlpha },
      { alpha: 0, duration: step.duration, delay: step.delay, ease, onUpdate: applyFn },
      position,
    )
  } else {
    tl.fromTo(
      target.element,
      { opacity: 1 },
      { opacity: 0, duration: step.duration, delay: step.delay, ease },
      position,
    )
  }
}
