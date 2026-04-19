/**
 * state/useSlideObjects.ts
 *
 * Hook pro subscribe na slide objects z Y.Doc.
 * Re-renderuje komponentu když se změní jakýkoliv objekt.
 *
 * Vrací:
 * - objects: SlideObject[] — aktuální snapshot
 * - mutationCtx: MutationContext — pro volání mutations
 */

import { useState, useEffect } from 'react'
import { subscribeToObjects } from '@narrative/slide-model'
import type { MutationContext } from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'

export interface UseSlideObjectsResult {
  objects: SlideObject[]
  mutationCtx: MutationContext
}

export function useSlideObjects(): UseSlideObjectsResult {
  const { mutationCtx } = useSlideDoc()
  const [objects, setObjects] = useState<SlideObject[]>([])

  useEffect(() => {
    // subscribeToObjects inicializačně zavolá setObjects se současným snapshotem,
    // pak na každou Y.Doc změnu
    const unsubscribe = subscribeToObjects(mutationCtx, setObjects)
    return unsubscribe
  }, [mutationCtx])

  return { objects, mutationCtx }
}
