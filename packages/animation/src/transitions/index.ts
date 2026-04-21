/**
 * packages/animation/src/transitions/index.ts
 *
 * Slide transition registry + public entry points.
 *
 * compileSlideTransition — returns a CompiledTransition (paused timeline).
 * runSlideTransition     — compile + play + resolve Promise when complete; disposes on finish.
 */

import type { SlideTransition, SlideTransitionKind } from '@narrative/shared'
import type { SlideTransitionTargets, CompiledTransition, TransitionFactory } from './types.js'
import { noneTransition } from './none.js'
import { fadeTransition } from './fade.js'
import { pushTransition } from './push.js'
import { cubeTransition } from './cube.js'
import { magicTransition } from './magic.js'

// Re-export types for public API surface.
export type {
  SlideTransitionTargets,
  CompiledTransition,
  TransitionFactory,
  MagicMoveObjectPair,
} from './types.js'

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY: Record<SlideTransitionKind, TransitionFactory> = {
  none: noneTransition,
  fade: fadeTransition,
  push: pushTransition,
  cube: cubeTransition,
  magic: magicTransition,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compiles a slide transition into a paused GSAP timeline.
 * Caller is responsible for calling play() and dispose().
 */
export function compileSlideTransition(
  targets: SlideTransitionTargets,
  transition: SlideTransition,
): CompiledTransition {
  const factory = REGISTRY[transition.kind]
  return factory(targets, transition)
}

/**
 * High-level wrapper: compile + play + resolve when complete.
 *
 * Returns a Promise that resolves when the transition animation finishes.
 * Disposes the timeline on resolve (and on rejection if play() throws).
 *
 * For kind === 'none', the Promise resolves synchronously in the next microtask
 * (zero-duration timeline + immediate onComplete).
 */
export function runSlideTransition(
  targets: SlideTransitionTargets,
  transition: SlideTransition,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let compiled: CompiledTransition | undefined

    try {
      compiled = compileSlideTransition(targets, transition)
    } catch (err) {
      reject(err)
      return
    }

    const { timeline, dispose } = compiled

    timeline.eventCallback('onComplete', () => {
      dispose()
      resolve()
    })

    try {
      timeline.play()
    } catch (err) {
      dispose()
      reject(err)
    }
  })
}
