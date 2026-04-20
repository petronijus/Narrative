/**
 * slide-model/src/slideMutationContext.ts
 *
 * Deck-level mutation context (M9 multi-slide schema).
 *
 * DeckMutationContext — primary context exported as SlideMutationContext for
 * consumer compatibility. Holds doc + slides Y.Array.
 *
 * Per-slide scoped contexts (ObjectsMutationContext, AnimationsMutationContext)
 * are obtained via getSlideObjectsCtx() / getSlideAnimationsCtx() in slides.ts.
 */

import type * as Y from 'yjs'

/**
 * Deck-level mutation context — wraps doc + top-level slides Y.Array.
 * Pass to slide CRUD functions in slides.ts.
 */
export interface DeckMutationContext {
  doc: Y.Doc
  slides: Y.Array<Y.Map<unknown>>
}

/**
 * SlideMutationContext — exported alias for DeckMutationContext.
 * Named SlideMutationContext for continuity with M6/M8 consumers.
 * Internally this is now the DECK context (holds slides, not objects/animations directly).
 *
 * Consumers using the old shape { doc, objects, animations } must migrate to:
 *   const objectsCtx = getSlideObjectsCtx(deckCtx, activeSlideId)
 *   const animationsCtx = getSlideAnimationsCtx(deckCtx, activeSlideId)
 */
export type SlideMutationContext = DeckMutationContext
