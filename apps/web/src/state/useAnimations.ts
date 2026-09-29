/**
 * state/useAnimations.ts
 *
 * Read-only subscription to the active slide's animation steps, in play
 * order (the Y.Array order). Full snapshot pattern — a new AnimationStep[]
 * on every change. Steps change only through the `animation.*` commands
 * (useCommand), so the hook hands out no mutation context.
 *
 * M9 update: scoped to active slide via ActiveSlideContext.
 */

import { useState, useEffect } from 'react'
import { subscribeToSlideAnimations } from '@narrative/slide-model'
import type { AnimationStep } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'
import { useActiveSlide } from './ActiveSlideContext.js'

export interface UseAnimationsResult {
  animations: AnimationStep[]
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

  return { animations }
}
