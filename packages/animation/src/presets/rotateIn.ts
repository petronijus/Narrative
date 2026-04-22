/**
 * packages/animation/src/presets/rotateIn.ts
 *
 * rotateIn — spins into place while fading in. Default is a quarter-turn
 * (-π/2) clockwise into current rotation.
 *
 * Params:
 *   angle?: number — starting offset in radians (default -Math.PI/2).
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

type Timeline = ReturnType<typeof gsap.timeline>

const DEFAULT_ANGLE_RAD = -Math.PI / 2

function resolveAngle(step: AnimationStep): number {
  const raw = step.params?.['angle']
  if (typeof raw === 'number') return raw
  return DEFAULT_ANGLE_RAD
}

export function rotateIn(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  const ease = step.easing || 'power2.out'
  const angleRad = resolveAngle(step)

  if (target.kind === 'pixi') {
    const proxy = target.proxy
    const applyFn = target.apply.bind(target)
    const baseRot = proxy.rotation ?? 0
    tl.fromTo(
      proxy,
      { alpha: 0, rotation: baseRot + angleRad },
      {
        alpha: 1,
        rotation: baseRot,
        duration: step.duration,
        delay: step.delay,
        ease,
        onUpdate: applyFn,
      },
      position,
    )
  } else {
    const deg = (angleRad * 180) / Math.PI
    tl.fromTo(
      target.element,
      { opacity: 0, rotation: deg },
      {
        opacity: 1,
        rotation: 0,
        duration: step.duration,
        delay: step.delay,
        ease,
        transformOrigin: '50% 50%',
      },
      position,
    )
  }
}
