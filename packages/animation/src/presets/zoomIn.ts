/**
 * packages/animation/src/presets/zoomIn.ts
 *
 * zoomIn — object grows from 2× to its natural size while fading in.
 * Reads like "zoomed in close, pulling back into place".
 *
 * Use `params.fromScale` to override the starting scale (default 2).
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

type Timeline = ReturnType<typeof gsap.timeline>

const DEFAULT_FROM_SCALE = 2

function resolveFromScale(step: AnimationStep): number {
  const raw = step.params?.['fromScale']
  if (typeof raw === 'number' && raw > 0) return raw
  return DEFAULT_FROM_SCALE
}

export function zoomIn(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  const ease = step.easing || 'power3.out'
  const fromScale = resolveFromScale(step)

  if (target.kind === 'pixi') {
    const proxy = target.proxy
    const applyFn = target.apply.bind(target)
    const baseScaleX = proxy.scaleX || 1
    const baseScaleY = proxy.scaleY || 1
    tl.fromTo(
      proxy,
      { alpha: 0, scaleX: baseScaleX * fromScale, scaleY: baseScaleY * fromScale },
      {
        alpha: 1,
        scaleX: baseScaleX,
        scaleY: baseScaleY,
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
      { opacity: 0, scale: fromScale },
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
