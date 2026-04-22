/**
 * packages/animation/src/presets/slideOut.ts
 *
 * slideOut preset factory — mirror of slideIn. Object leaves toward the
 * given direction while fading out.
 *
 * direction semantics (where the object goes):
 *   'up'    → objekt odchází nahoru   (toY = currentY - distance)
 *   'down'  → objekt odchází dolů     (toY = currentY + distance)
 *   'left'  → objekt odchází doleva   (toX = currentX - distance)
 *   'right' → objekt odchází doprava  (toX = currentX + distance)
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

type Timeline = ReturnType<typeof gsap.timeline>

const DEFAULT_DISTANCE = 100

interface SlideOutParams {
  direction: 'up' | 'down' | 'left' | 'right'
  distance: number
}

function resolveParams(step: AnimationStep): SlideOutParams {
  const raw = step.params ?? {}
  const direction = (raw['direction'] as string | undefined) ?? 'up'
  const distance = (raw['distance'] as number | undefined) ?? DEFAULT_DISTANCE
  if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
    console.warn(
      `[animation] slideOut: unknown direction '${String(direction)}', defaulting to 'up'`,
    )
    return { direction: 'up', distance }
  }
  return { direction, distance }
}

export function slideOut(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  const ease = step.easing || 'power2.in'
  const { direction, distance } = resolveParams(step)

  if (target.kind === 'pixi') {
    const proxy = target.proxy
    const applyFn = target.apply.bind(target)
    let dx = 0
    let dy = 0
    if (direction === 'up') dy = -distance
    else if (direction === 'down') dy = distance
    else if (direction === 'left') dx = -distance
    else dx = distance // 'right'
    tl.fromTo(
      proxy,
      { alpha: 1, x: proxy.x, y: proxy.y },
      {
        alpha: 0,
        x: proxy.x + dx,
        y: proxy.y + dy,
        duration: step.duration,
        delay: step.delay,
        ease,
        onUpdate: applyFn,
      },
      position,
    )
  } else {
    let dx = 0
    let dy = 0
    if (direction === 'up') dy = -distance
    else if (direction === 'down') dy = distance
    else if (direction === 'left') dx = -distance
    else dx = distance // 'right'
    tl.fromTo(
      target.element,
      { opacity: 1, x: 0, y: 0 },
      {
        opacity: 0,
        x: dx,
        y: dy,
        duration: step.duration,
        delay: step.delay,
        ease,
      },
      position,
    )
  }
}
