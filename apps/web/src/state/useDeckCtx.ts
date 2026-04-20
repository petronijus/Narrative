/**
 * state/useDeckCtx.ts
 *
 * Hook for accessing the deck-level mutation context (M9).
 * Returns SlideMutationContext { doc, slides } — the deck root context.
 *
 * Use getSlideObjectsCtx(deckCtx, slideId) to obtain a slide-scoped objects ctx.
 * Use getSlideAnimationsCtx(deckCtx, slideId) to obtain a slide-scoped animations ctx.
 */

import { useSlideDoc } from './useSlideDoc.js'
import type { SlideMutationContext } from '@narrative/slide-model'

export function useDeckCtx(): SlideMutationContext {
  const { deckCtx } = useSlideDoc()
  return deckCtx
}
