/**
 * packages/animation/src/transitions/none.ts
 *
 * 'none' transition — instant swap, no animation.
 *
 * Sets outgoing.alpha = 0, incoming.alpha = 1 immediately.
 * Returns a zero-duration timeline for API uniformity — play() is effectively synchronous.
 */

import { gsap } from 'gsap'
import type { SlideTransitionTargets, CompiledTransition } from './types.js'
import type { SlideTransition } from '@narrative/shared'

export function noneTransition(
  targets: SlideTransitionTargets,
  _transition: SlideTransition,
): CompiledTransition {
  const { outgoing, incoming } = targets

  // Apply immediately — no tween needed.
  outgoing.alpha = 0
  outgoing.position.set(0, 0)
  outgoing.scale.set(1, 1)
  incoming.alpha = 1
  incoming.position.set(0, 0)
  incoming.scale.set(1, 1)

  // Zero-duration timeline for API uniformity.
  // play() on a zero-duration paused timeline resolves onComplete immediately.
  const tl = gsap.timeline({ paused: true })

  // A zero-duration tween so getChildren() is non-empty and onComplete fires.
  const proxy = { _: 0 }
  tl.to(proxy, { _: 1, duration: 0 })

  const dispose = () => {
    tl.kill()
  }

  return { timeline: tl, dispose }
}
