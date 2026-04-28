/**
 * state/useDeckFonts.ts
 *
 * P15: hook for subscribing to the deck's custom font registry.
 * Returns the live snapshot + a stable mutation context so callers
 * (the upload sheet, the font picker delete button) can call
 * addDeckFont / removeDeckFont directly without prop-drilling.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  getDeckFontsCtx,
  listDeckFonts,
  subscribeToDeckFonts,
  type DeckFontsContext,
} from '@narrative/slide-model'
import type { DeckFontEntry } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'

export interface UseDeckFontsResult {
  fonts: DeckFontEntry[]
  fontsCtx: DeckFontsContext
}

export function useDeckFonts(): UseDeckFontsResult {
  const { deckCtx } = useSlideDoc()
  const fontsCtx = useMemo(() => getDeckFontsCtx(deckCtx.doc), [deckCtx.doc])
  const [fonts, setFonts] = useState<DeckFontEntry[]>(() => listDeckFonts(fontsCtx))

  useEffect(() => {
    return subscribeToDeckFonts(fontsCtx, setFonts)
  }, [fontsCtx])

  return { fonts, fontsCtx }
}
