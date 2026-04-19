/**
 * slide-model/src/animationObserve.ts
 *
 * Observer helper pro animations Y.Array.
 * Full snapshot pattern — animace jsou typicky krátký seznam (< 30 na slide),
 * full snapshot je jednodušší než incremental diff a runtime engine tak jako tak
 * kompiluje celý timeline při play.
 *
 * Analogie k subscribeToObjects v observe.ts.
 */

import type { AnimationStep } from '@narrative/shared'
import { yMapToAnimationStep } from './animationBindings.js'
import type { AnimationMutationContext } from './animationMutations.js'

/**
 * Subscribeuje na změny animations array.
 * Callback je zavolán synchronně po subscribe se současným snapshotem,
 * pak na každou změnu (add/update/remove/reorder).
 *
 * Full snapshot pattern — callback vždy dostane celý aktuální seznam AnimationStep.
 *
 * @returns Unsubscribe funkce — zavolej při unmount.
 */
export function subscribeToAnimations(
  ctx: AnimationMutationContext,
  callback: (animations: AnimationStep[]) => void,
): () => void {
  const getSnapshot = (): AnimationStep[] => {
    const result: AnimationStep[] = []
    for (let i = 0; i < ctx.animations.length; i++) {
      result.push(yMapToAnimationStep(ctx.animations.get(i)))
    }
    return result
  }

  // observeDeep zachytí i nested Y.Map updates (updateAnimation patches)
  const observer = (): void => {
    callback(getSnapshot())
  }

  ctx.animations.observeDeep(observer)

  // Synchronní initial emission
  callback(getSnapshot())

  return (): void => {
    ctx.animations.unobserveDeep(observer)
  }
}
