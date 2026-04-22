/**
 * packages/animation/src/presets/flipIn.ts
 *
 * flipIn — 2-D approximation of a "flip in from the edge": scaleX
 * sweeps 0 → 1 while scaleY stays at 1. Gives a card-flipping feel
 * without requiring a true 3-D matrix.
 *
 * Params:
 *   axis?: 'x' | 'y' — which axis is scaled. Default 'x' (horizontal flip).
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

type Timeline = ReturnType<typeof gsap.timeline>

function resolveAxis(step: AnimationStep): 'x' | 'y' {
  const raw = step.params?.['axis']
  return raw === 'y' ? 'y' : 'x'
}

export function flipIn(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  const ease = step.easing || 'power2.out'
  const axis = resolveAxis(step)

  if (target.kind === 'pixi') {
    const proxy = target.proxy
    const applyFn = target.apply.bind(target)
    const baseSx = proxy.scaleX || 1
    const baseSy = proxy.scaleY || 1
    const from = axis === 'x' ? { scaleX: 0, scaleY: baseSy } : { scaleX: baseSx, scaleY: 0 }
    tl.fromTo(
      proxy,
      { alpha: 0, ...from },
      {
        alpha: 1,
        scaleX: baseSx,
        scaleY: baseSy,
        duration: step.duration,
        delay: step.delay,
        ease,
        onUpdate: applyFn,
      },
      position,
    )
  } else {
    const from = axis === 'x' ? { scaleX: 0, scaleY: 1 } : { scaleX: 1, scaleY: 0 }
    tl.fromTo(
      target.element,
      { opacity: 0, ...from },
      {
        opacity: 1,
        scaleX: 1,
        scaleY: 1,
        duration: step.duration,
        delay: step.delay,
        ease,
        transformOrigin: '50% 50%',
      },
      position,
    )
  }
}
