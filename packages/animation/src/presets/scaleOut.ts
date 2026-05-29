/**
 * packages/animation/src/presets/scaleOut.ts
 *
 * scaleOut — shrinks from 1 to 0 with alpha fade-out.
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

type Timeline = ReturnType<typeof gsap.timeline>

export function scaleOut(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  const ease = step.easing || 'power2.in'

  if (target.kind === 'pixi') {
    const proxy = target.proxy
    const applyFn = target.apply.bind(target)
    // Shrink/fade from the AUTHORED alpha, not a hardcoded 1.
    const baseAlpha = proxy.alpha
    tl.fromTo(
      proxy,
      { alpha: baseAlpha, scaleX: proxy.scaleX || 1, scaleY: proxy.scaleY || 1 },
      {
        alpha: 0,
        scaleX: 0,
        scaleY: 0,
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
      { opacity: 1, scale: 1 },
      {
        opacity: 0,
        scale: 0,
        duration: step.duration,
        delay: step.delay,
        ease,
        transformOrigin: '50% 50%',
      },
      position,
    )
  }
}
