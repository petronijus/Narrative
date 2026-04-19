/**
 * state/useAnimations.ts
 *
 * Hook pro subscribe na animations z Y.Doc.
 * Re-renderuje komponentu když se změní jakýkoliv AnimationStep.
 *
 * Full snapshot pattern — vrací celý seznam AnimationStep po každé změně.
 * Pořadí odpovídá Y.Array pořadí = play order animací na slide.
 *
 * Vrací:
 * - animations: AnimationStep[] — aktuální snapshot (v play order)
 * - mutationCtx: SlideMutationContext — pro volání animation mutations
 */

import { useState, useEffect } from 'react'
import { subscribeToAnimations } from '@narrative/slide-model'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { AnimationStep } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'

export interface UseAnimationsResult {
  animations: AnimationStep[]
  mutationCtx: SlideMutationContext
}

export function useAnimations(): UseAnimationsResult {
  const { mutationCtx } = useSlideDoc()
  const [animations, setAnimations] = useState<AnimationStep[]>([])

  useEffect(() => {
    // subscribeToAnimations inicializačně zavolá setAnimations se současným snapshotem,
    // pak na každou Y.Doc změnu
    const unsubscribe = subscribeToAnimations(mutationCtx, setAnimations)
    return unsubscribe
  }, [mutationCtx])

  return { animations, mutationCtx }
}
