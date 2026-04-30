/**
 * packages/animation/src/presets/moveTo.ts
 *
 * moveTo — animuje objekt z aktuální pozice na absolutní target (slide-px).
 *
 * params:
 *   targetX: number — cílová X souřadnice (slide-coord, levý horní roh).
 *   targetY: number — cílová Y souřadnice.
 *
 * Pixi target: animuje proxy.x/y (komponovatelné s ostatními kroky přes
 *              proxy/apply). DOM target: CSS translate na delta proti
 *              authored pozici objektu (best-effort, overlay layout
 *              netuší, takže zachová vlastní DOM pozici).
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

type Timeline = ReturnType<typeof gsap.timeline>

interface MoveToParams {
  targetX: number
  targetY: number
}

function resolveParams(step: AnimationStep, fallbackX: number, fallbackY: number): MoveToParams {
  const raw = step.params ?? {}
  const tx = raw['targetX']
  const ty = raw['targetY']
  return {
    targetX: typeof tx === 'number' && Number.isFinite(tx) ? tx : fallbackX,
    targetY: typeof ty === 'number' && Number.isFinite(ty) ? ty : fallbackY,
  }
}

export function moveTo(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  const ease = step.easing || 'power2.out'

  if (target.kind === 'pixi') {
    const proxy = target.proxy
    const applyFn = target.apply.bind(target)
    const { targetX, targetY } = resolveParams(step, proxy.x, proxy.y)

    tl.to(
      proxy,
      {
        x: targetX,
        y: targetY,
        duration: step.duration,
        delay: step.delay,
        ease,
        onUpdate: applyFn,
      },
      position,
    )
    return
  }

  // DOM target — overlay element occupies the authored object rect, so
  // we animate transform translate to (target - authored) delta. We do
  // not know the authored origin from the handle; use a relative
  // animation instead (translate by full target as if delta).
  const { targetX, targetY } = resolveParams(step, 0, 0)
  tl.to(
    target.element,
    {
      transform: `translate(${targetX}px, ${targetY}px)`,
      duration: step.duration,
      delay: step.delay,
      ease,
    },
    position,
  )
}
