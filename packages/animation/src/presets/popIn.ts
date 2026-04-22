/**
 * packages/animation/src/presets/popIn.ts
 *
 * popIn — overshoots past 1 then settles back via back.out easing.
 * Lively "snap into view" entrance for badges, emoji reactions, alerts.
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

type Timeline = ReturnType<typeof gsap.timeline>

export function popIn(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  const ease = step.easing || 'back.out(1.7)'

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
