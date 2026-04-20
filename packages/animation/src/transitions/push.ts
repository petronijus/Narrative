/**
 * packages/animation/src/transitions/push.ts
 *
 * 'push' slide transition — both slides translate together in one direction.
 *
 * Direction semantics (which way slides move):
 *   left  — slides move left;  incoming starts at x=+slideWidth,  outgoing ends at x=-slideWidth
 *   right — slides move right; incoming starts at x=-slideWidth,  outgoing ends at x=+slideWidth
 *   up    — slides move up;    incoming starts at y=+slideHeight, outgoing ends at y=-slideHeight
 *   down  — slides move down;  incoming starts at y=-slideHeight, outgoing ends at y=+slideHeight
 *
 * End state: outgoing fully off-screen, incoming at (0,0).
 *
 * Proxy pattern (Spike A): GSAP animates plain proxy objects.
 */

import { gsap } from 'gsap'
import type { SlideTransitionTargets, CompiledTransition } from './types.js'
import { makeContainerProxy } from './types.js'
import type { SlideTransition, SlidePushDirection } from '@narrative/shared'

interface AxisOffset {
  outgoingEndX: number
  outgoingEndY: number
  incomingStartX: number
  incomingStartY: number
}

function resolveAxisOffset(
  direction: SlidePushDirection,
  slideWidth: number,
  slideHeight: number,
): AxisOffset {
  switch (direction) {
    case 'left':
      return {
        outgoingEndX: -slideWidth,
        outgoingEndY: 0,
        incomingStartX: slideWidth,
        incomingStartY: 0,
      }
    case 'right':
      return {
        outgoingEndX: slideWidth,
        outgoingEndY: 0,
        incomingStartX: -slideWidth,
        incomingStartY: 0,
      }
    case 'up':
      return {
        outgoingEndX: 0,
        outgoingEndY: -slideHeight,
        incomingStartX: 0,
        incomingStartY: slideHeight,
      }
    case 'down':
      return {
        outgoingEndX: 0,
        outgoingEndY: slideHeight,
        incomingStartX: 0,
        incomingStartY: -slideHeight,
      }
  }
}

export function pushTransition(
  targets: SlideTransitionTargets,
  transition: SlideTransition,
): CompiledTransition {
  const { outgoing, incoming, slideSize } = targets
  const durationSec = transition.durationMs / 1000
  const direction: SlidePushDirection = transition.direction ?? 'left'

  const { outgoingEndX, outgoingEndY, incomingStartX, incomingStartY } = resolveAxisOffset(
    direction,
    slideSize.width,
    slideSize.height,
  )

  // Position incoming container at its start offset before animation.
  incoming.position.set(incomingStartX, incomingStartY)
  incoming.alpha = 1
  outgoing.position.set(0, 0)
  outgoing.alpha = 1

  const tl = gsap.timeline({ paused: true })

  if (durationSec <= 0) {
    outgoing.position.set(outgoingEndX, outgoingEndY)
    incoming.position.set(0, 0)
    const sentinel = { _: 0 }
    tl.to(sentinel, { _: 1, duration: 0 })
    return { timeline: tl, dispose: () => tl.kill() }
  }

  const { proxy: outProxy, applyProxy: applyOut } = makeContainerProxy(outgoing, {
    x: 0,
    y: 0,
    alpha: 1,
  })
  const { proxy: inProxy, applyProxy: applyIn } = makeContainerProxy(incoming, {
    x: incomingStartX,
    y: incomingStartY,
    alpha: 1,
  })

  tl.to(
    outProxy,
    {
      x: outgoingEndX,
      y: outgoingEndY,
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
      duration: durationSec,
      ease: 'power2.inOut',
      onUpdate: applyIn,
    },
    0,
  )

  return { timeline: tl, dispose: () => tl.kill() }
}
