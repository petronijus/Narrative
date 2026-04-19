/**
 * packages/animation/src/presets/slideIn.ts
 *
 * slideIn preset factory — animuje slide-fade-in z dané směru.
 *
 * direction semantics (odkud objekt přichází):
 *   'up'    → objekt vchází zespodu  (fromY = currentY + distance)
 *   'down'  → objekt vchází seshora  (fromY = currentY - distance)
 *   'left'  → objekt vchází zprava   (fromX = currentX + distance)
 *   'right' → objekt vchází zleva    (fromX = currentX - distance)
 *
 * Kombinuje pohyb s fade-in pro přirozený vizuální efekt.
 *
 * Pixi target: animuje proxy.x/y + proxy.alpha přes onUpdate → apply()
 * DOM target:  animuje CSS transform + opacity přímo
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'

// gsap.core.Timeline je ambient namespace type — přistupujeme přes ReturnType
type Timeline = ReturnType<typeof gsap.timeline>

const DEFAULT_DISTANCE = 100

interface SlideInParams {
  direction: 'up' | 'down' | 'left' | 'right'
  distance: number
}

function resolveParams(step: AnimationStep): SlideInParams {
  const raw = step.params ?? {}
  const direction = (raw['direction'] as string | undefined) ?? 'up'
  const distance = (raw['distance'] as number | undefined) ?? DEFAULT_DISTANCE

  if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
    console.warn(`[animation] slideIn: neznámý direction '${String(direction)}', fallback na 'up'`)
    return { direction: 'up', distance }
  }

  return { direction, distance }
}

export function slideIn(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  const ease = step.easing || 'power2.out'
  const { direction, distance } = resolveParams(step)

  if (target.kind === 'pixi') {
    const proxy = target.proxy
    const applyFn = target.apply.bind(target)

    // Výpočet from offset podle direction
    let fromX = 0
    let fromY = 0
    if (direction === 'up') fromY = distance
    else if (direction === 'down') fromY = -distance
    else if (direction === 'left') fromX = distance
    else fromX = -distance // 'right'

    tl.fromTo(
      proxy,
      { alpha: 0, x: proxy.x + fromX, y: proxy.y + fromY },
      {
        alpha: 1,
        x: proxy.x,
        y: proxy.y,
        duration: step.duration,
        delay: step.delay,
        ease,
        onUpdate: applyFn,
      },
      position,
    )
  } else {
    // DOM target — CSS transform
    let fromTransform = ''
    if (direction === 'up') fromTransform = `translateY(${distance}px)`
    else if (direction === 'down') fromTransform = `translateY(-${distance}px)`
    else if (direction === 'left') fromTransform = `translateX(${distance}px)`
    else fromTransform = `translateX(-${distance}px)` // 'right'

    tl.fromTo(
      target.element,
      { opacity: 0, transform: fromTransform },
      {
        opacity: 1,
        transform: 'translateX(0px) translateY(0px)',
        duration: step.duration,
        delay: step.delay,
        ease,
      },
      position,
    )
  }
}
