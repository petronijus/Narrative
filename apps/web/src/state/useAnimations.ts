/**
 * state/useAnimations.ts
 *
 * Hook for subscribing to animations from the active slide in Y.Doc.
 * Full snapshot pattern — returns complete AnimationStep[] on every change.
 * Play order corresponds to Y.Array order.
 *
 * M9 update: scoped to active slide via ActiveSlideContext.
 *
 * Returns:
 * - animations: AnimationStep[] — current snapshot (in play order)
 * - animationsCtx: AnimationsMutationContext | null — for calling animation mutations
 */

import { useState, useEffect } from 'react'
import { subscribeToSlideAnimations, getSlideAnimationsCtx } from '@narrative/slide-model'
import type { AnimationsMutationContext } from '@narrative/slide-model'
import type { AnimationStep } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'
import { useActiveSlide } from './ActiveSlideContext.js'

export interface UseAnimationsResult {
  animations: AnimationStep[]
  /** AnimationsMutationContext scoped to the active slide. Null if no active slide. */
  animationsCtx: AnimationsMutationContext | null
  /**
   * @deprecated Use animationsCtx. Kept for backward compat with consumers expecting mutationCtx.
   * Removed in M10.
   */
  mutationCtx: AnimationsMutationContext | null
}

export function useAnimations(): UseAnimationsResult {
  const { deckCtx } = useSlideDoc()
  const { activeSlideId } = useActiveSlide()
  const [animations, setAnimations] = useState<AnimationStep[]>([])

  useEffect(() => {
    if (activeSlideId === null) {
      setAnimations([])
      return
    }

    const unsubscribe = subscribeToSlideAnimations(deckCtx, activeSlideId, setAnimations)
    return unsubscribe
  }, [deckCtx, activeSlideId])

  const animationsCtx =
    activeSlideId !== null ? getSlideAnimationsCtx(deckCtx, activeSlideId) : null

  return { animations, animationsCtx, mutationCtx: animationsCtx }
}
