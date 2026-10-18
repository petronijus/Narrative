/**
 * state/useAnimations.ts
 *
 * Read-only view of the active slide's animation steps, in play order (the
 * Y.Array order), from the deck's shared store (state/useDeckStore.ts). The
 * array keeps its identity until a step changes. Steps change only through
 * the `animation.*` commands (useCommand), so the hook hands out no mutation
 * context.
 *
 * M9 update: scoped to active slide via ActiveSlideContext.
 */

import type { AnimationStep } from '@narrative/shared'
import { useActiveSlideAnimations } from './useDeckStore.js'

export interface UseAnimationsResult {
  animations: AnimationStep[]
}

export function useAnimations(): UseAnimationsResult {
  return { animations: useActiveSlideAnimations() }
}
