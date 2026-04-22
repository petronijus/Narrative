/**
 * state/useSections.ts
 *
 * React hook — returns a live array of deck sections. Subscribes to
 * deck sections Y.Array deep-observer and updates on every change.
 */

import { useEffect, useState } from 'react'
import { subscribeToSections } from '@narrative/slide-model'
import type { DeckSection } from '@narrative/shared'
import { useDeckCtx } from './useDeckCtx.js'

export function useSections(): DeckSection[] {
  const deckCtx = useDeckCtx()
  const [sections, setSections] = useState<DeckSection[]>([])

  useEffect(() => {
    const unsubscribe = subscribeToSections(deckCtx, (next) => {
      setSections(next)
    })
    return unsubscribe
  }, [deckCtx])

  return sections
}
