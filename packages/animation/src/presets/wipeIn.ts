/**
 * packages/animation/src/presets/wipeIn.ts
 *
 * wipeIn — simplified 2-D wipe: scales one axis from 0 to 1 without
 * changing alpha. A true "reveal mask" would need Pixi Graphics masks;
 * this approximation is close enough for slide presentations and stays
 * cheap on the CPU.
 *
 * Params:
 *   direction?: 'left' | 'right' | 'up' | 'down' — which edge the wipe
 *     emerges from. Defaults to 'left' (sweeps rightward).
 *
 * NOTE: Pixi scales from the container's pivot. Renderers set pivot to
 * geometry center, so the wipe appears to expand from the centre rather
 * than from the named edge. A future version can offset pivot + position
 * to emulate true edge-anchored wipes; for now the effect reads as a
 * quick scale reveal.
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

type Timeline = ReturnType<typeof gsap.timeline>

function resolveAxis(step: AnimationStep): 'x' | 'y' {
  const raw = step.params?.['direction']
  return raw === 'up' || raw === 'down' ? 'y' : 'x'
}

export function wipeIn(
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
      from,
      {
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
      from,
      {
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
