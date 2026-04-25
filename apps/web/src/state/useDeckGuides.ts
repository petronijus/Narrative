/**
 * state/useDeckGuides.ts
 *
 * P11: hook for subscribing to deck-level alignment guides (rulers UX).
 * Returns the live snapshot + a stable mutation context so callers can
 * call addGuide / updateGuide / removeGuide directly.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  getDeckGuidesCtx,
  listDeckGuides,
  subscribeToDeckGuides,
  type DeckGuidesContext,
} from '@narrative/slide-model'
import type { DeckGuide } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'

export interface UseDeckGuidesResult {
  guides: DeckGuide[]
  guidesCtx: DeckGuidesContext
}

export function useDeckGuides(): UseDeckGuidesResult {
  const { deckCtx } = useSlideDoc()
  const guidesCtx = useMemo(() => getDeckGuidesCtx(deckCtx.doc), [deckCtx.doc])
  const [guides, setGuides] = useState<DeckGuide[]>(() => listDeckGuides(guidesCtx))

  useEffect(() => {
    return subscribeToDeckGuides(guidesCtx, setGuides)
  }, [guidesCtx])

  return { guides, guidesCtx }
}
