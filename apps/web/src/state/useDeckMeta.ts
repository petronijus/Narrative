/**
 * state/useDeckMeta.ts — the open deck's `meta` (A4.2d): its style variant,
 * footer field values and language, live. Outside a deck (the component
 * master editor) there is none.
 */

import { useContext, useEffect, useState } from 'react'
import { readDeckMeta, subscribeDeckMeta } from '@narrative/slide-model'
import type { DeckMeta } from '@narrative/shared'
import { SlideDocContext } from './slideDocContext.js'

const EMPTY: DeckMeta = {}

export function useDeckMeta(): DeckMeta {
  const ctx = useContext(SlideDocContext)
  const doc = ctx?.deckCtx.doc
  const [meta, setMeta] = useState<DeckMeta>(() => (doc === undefined ? EMPTY : readDeckMeta(doc)))
  useEffect(() => {
    if (doc === undefined) {
      setMeta(EMPTY)
      return
    }
    setMeta(readDeckMeta(doc))
    return subscribeDeckMeta(doc, setMeta)
  }, [doc])
  return meta
}

/** The deck's variant, stable while it does not change (it keys the colour resolver). */
export function useDeckVariant(): Readonly<Record<string, string>> | undefined {
  const variant = useDeckMeta().variant
  const key = variant === undefined ? '' : JSON.stringify(variant)
  const [stable, setStable] = useState(variant)
  const [stableKey, setStableKey] = useState(key)
  if (key !== stableKey) {
    setStableKey(key)
    setStable(variant)
  }
  return stable
}
