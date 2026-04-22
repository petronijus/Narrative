/**
 * packages/animation/src/presets/bounceIn.ts
 *
 * bounceIn — scale 0 → 1 with GSAP's bounce.out easing for a
 * squish-and-settle entrance. Alpha fades in on the rising flank so
 * the first bounce is already visible.
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

type Timeline = ReturnType<typeof gsap.timeline>

export function bounceIn(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  const ease = step.easing || 'bounce.out'

  if (target.kind === 'pixi') {
    const proxy = target.proxy
    const applyFn = target.apply.bind(target)
    tl.fromTo(
      proxy,
      { alpha: 0, scaleX: 0, scaleY: 0 },
      {
        alpha: 1,
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
