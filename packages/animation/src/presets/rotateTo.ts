/**
 * packages/animation/src/presets/rotateTo.ts
 *
 * rotateTo — animuje rotaci na absolutní cílový úhel (degrees).
 *
 * params:
 *   angleDeg: number — cílový úhel v degrees (0 = výchozí orientace).
 *
 * Pixi target: animuje proxy.rotation (radians). DOM target: CSS rotate.
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

type Timeline = ReturnType<typeof gsap.timeline>

const DEG_TO_RAD = Math.PI / 180

function resolveAngleDeg(step: AnimationStep): number {
  const raw = step.params?.['angleDeg']
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  return 360
}

export function rotateTo(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  const ease = step.easing || 'power2.out'
  const angleDeg = resolveAngleDeg(step)

  if (target.kind === 'pixi') {
    const proxy = target.proxy
    const applyFn = target.apply.bind(target)
    tl.to(
      proxy,
      {
        rotation: angleDeg * DEG_TO_RAD,
        duration: step.duration,
        delay: step.delay,
        ease,
        onUpdate: applyFn,
      },
      position,
    )
    return
  }

  tl.to(
    target.element,
    {
      rotation: angleDeg,
      duration: step.duration,
      delay: step.delay,
      ease,
    },
    position,
  )
}
