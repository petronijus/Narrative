/**
 * packages/animation/src/presets/scaleIn.ts
 *
 * scaleIn — grows from 0 to 1 with alpha fade-in. Centred scale around
 * the Pixi container's existing pivot (the renderer is responsible for
 * setting pivot = geometry center so scaling feels natural).
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

type Timeline = ReturnType<typeof gsap.timeline>

export function scaleIn(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  const ease = step.easing || 'power2.out'

  if (target.kind === 'pixi') {
    const proxy = target.proxy
    const applyFn = target.apply.bind(target)
    // Grow/fade IN to the AUTHORED alpha, not a hardcoded 1 — an object
    // authored at alpha < 1 must settle at that alpha, not overshoot to full.
    const baseAlpha = proxy.alpha
    tl.fromTo(
      proxy,
      { alpha: 0, scaleX: 0, scaleY: 0 },
      {
        alpha: baseAlpha,
        scaleX: proxy.scaleX || 1,
        scaleY: proxy.scaleY || 1,
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
      { opacity: 0, scale: 0 },
      {
        opacity: 1,
        scale: 1,
        duration: step.duration,
        delay: step.delay,
        ease,
        transformOrigin: '50% 50%',
      },
      position,
    )
  }
}
