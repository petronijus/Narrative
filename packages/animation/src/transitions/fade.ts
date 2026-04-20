/**
 * packages/animation/src/transitions/fade.ts
 *
 * 'fade' slide transition — cross-fade between outgoing and incoming.
 *
 * Outgoing: alpha 1 → 0
 * Incoming: alpha 0 → 1
 * Both animate in parallel from t=0.
 *
 * Proxy pattern (Spike A): GSAP animates plain proxy objects.
 * onUpdate pushes values back to Pixi containers each frame.
 *
 * durationMs === 0 → immediate settle (no tween, just snap).
 */

import { gsap } from 'gsap'
import type { SlideTransitionTargets, CompiledTransition } from './types.js'
import { makeContainerProxy } from './types.js'
import type { SlideTransition } from '@narrative/shared'

export function fadeTransition(
  targets: SlideTransitionTargets,
  transition: SlideTransition,
): CompiledTransition {
  const { outgoing, incoming } = targets
  const durationSec = transition.durationMs / 1000

  // Ensure initial positions are correct before animating.
  outgoing.position.set(0, 0)
  incoming.position.set(0, 0)
  outgoing.scale.set(1, 1)
  incoming.scale.set(1, 1)

  const tl = gsap.timeline({ paused: true })

  if (durationMs_isZero(transition.durationMs)) {
    // Immediate settle — no tween.
    outgoing.alpha = 0
    incoming.alpha = 1
    // Zero-duration tween for API uniformity.
    const sentinel = { _: 0 }
    tl.to(sentinel, { _: 1, duration: 0 })
    return { timeline: tl, dispose: () => tl.kill() }
  }

  // Proxy for outgoing: alpha 1 → 0
  const { proxy: outProxy, applyProxy: applyOut } = makeContainerProxy(outgoing, { alpha: 1 })
  // Proxy for incoming: alpha 0 → 1
  const { proxy: inProxy, applyProxy: applyIn } = makeContainerProxy(incoming, { alpha: 0 })

  // Set incoming alpha to 0 on the actual container before the tween starts.
  incoming.alpha = 0

  tl.to(
    outProxy,
    {
      alpha: 0,
      duration: durationSec,
      ease: 'none',
      onUpdate: applyOut,
    },
    0,
  )

  tl.to(
    inProxy,
    {
      alpha: 1,
      duration: durationSec,
      ease: 'none',
      onUpdate: applyIn,
    },
    0,
  )

  return { timeline: tl, dispose: () => tl.kill() }
}

function durationMs_isZero(ms: number): boolean {
  return ms <= 0
}
