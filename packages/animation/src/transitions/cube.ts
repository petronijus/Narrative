/**
 * packages/animation/src/transitions/cube.ts
 *
 * 'cube' slide transition — 2D approximation of a 3D cube rotation.
 *
 * PRAGMATIC CHOICE (M9):
 * True CSS/WebGL 3D cube requires either CSS perspective on a DOM wrapper or a dedicated
 * Pixi 3D projection — both are deferred to M15 (Advanced Animations). For M9 we implement
 * an elegant 2D illusion that reads as a cube-like flip:
 *
 *   Outgoing: stays in place, scales 1.0 → 0.92, fades alpha 1 → 0.
 *   Incoming: starts at half-distance offset (direction-based) + scale 0.92 + alpha 0,
 *             animates to (0,0) + scale 1.0 + alpha 1.
 *   Ease: power2.inOut on both.
 *
 * The scale-down + fade of the outgoing combined with a scaled-up slide-in of incoming
 * creates a depth-shift illusion without requiring 3D transforms.
 *
 * True 3D cube (CSS perspective or Pixi3D plugin) → M15.
 *
 * Proxy pattern (Spike A): GSAP animates plain proxy objects, onUpdate applies to Pixi.
 */

import { gsap } from 'gsap'
import type { SlideTransitionTargets, CompiledTransition } from './types.js'
import { makeContainerProxy } from './types.js'
import type { SlideTransition, SlidePushDirection } from '@narrative/shared'

const CUBE_SCALE_SHRINK = 0.92
const CUBE_HALF_OFFSET = 0.5

function resolveIncomingOffset(
  direction: SlidePushDirection,
  slideWidth: number,
  slideHeight: number,
): { x: number; y: number } {
  switch (direction) {
    case 'left':
      return { x: slideWidth * CUBE_HALF_OFFSET, y: 0 }
    case 'right':
      return { x: -slideWidth * CUBE_HALF_OFFSET, y: 0 }
    case 'up':
      return { x: 0, y: slideHeight * CUBE_HALF_OFFSET }
    case 'down':
      return { x: 0, y: -slideHeight * CUBE_HALF_OFFSET }
  }
}

export function cubeTransition(
  targets: SlideTransitionTargets,
  transition: SlideTransition,
): CompiledTransition {
  const { outgoing, incoming, slideSize } = targets
  const durationSec = transition.durationMs / 1000
  const direction: SlidePushDirection = transition.direction ?? 'left'

  const { x: inStartX, y: inStartY } = resolveIncomingOffset(
    direction,
    slideSize.width,
    slideSize.height,
  )

  // Set initial state on actual containers before animation.
  outgoing.position.set(0, 0)
  outgoing.scale.set(1, 1)
  outgoing.alpha = 1
  incoming.position.set(inStartX, inStartY)
  incoming.scale.set(CUBE_SCALE_SHRINK, CUBE_SCALE_SHRINK)
  incoming.alpha = 0

  const tl = gsap.timeline({ paused: true })

  if (durationSec <= 0) {
    outgoing.alpha = 0
    outgoing.scale.set(CUBE_SCALE_SHRINK, CUBE_SCALE_SHRINK)
    incoming.position.set(0, 0)
    incoming.scale.set(1, 1)
    incoming.alpha = 1
    const sentinel = { _: 0 }
    tl.to(sentinel, { _: 1, duration: 0 })
    return { timeline: tl, dispose: () => tl.kill() }
  }

  // Outgoing proxy: in-place, scale 1→0.92, alpha 1→0
  const { proxy: outProxy, applyProxy: applyOut } = makeContainerProxy(outgoing, {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    alpha: 1,
  })

  // Incoming proxy: offset + scale 0.92 + alpha 0 → (0,0) + scale 1 + alpha 1
  const { proxy: inProxy, applyProxy: applyIn } = makeContainerProxy(incoming, {
    x: inStartX,
    y: inStartY,
    scaleX: CUBE_SCALE_SHRINK,
    scaleY: CUBE_SCALE_SHRINK,
    alpha: 0,
  })

  tl.to(
    outProxy,
    {
      scaleX: CUBE_SCALE_SHRINK,
      scaleY: CUBE_SCALE_SHRINK,
      alpha: 0,
      duration: durationSec,
      ease: 'power2.inOut',
      onUpdate: applyOut,
    },
    0,
  )

  tl.to(
    inProxy,
    {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      alpha: 1,
      duration: durationSec,
      ease: 'power2.inOut',
      onUpdate: applyIn,
    },
    0,
  )

  return { timeline: tl, dispose: () => tl.kill() }
}
