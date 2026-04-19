/**
 * state/useSlideObjectChanges.ts
 *
 * Hook pro konzumaci incremental changes z Y.Doc.
 * Určen pro renderer (surgical updates) — ne pro UI komponenty.
 *
 * Pro UI komponenty co chtějí plain objects snapshot, použij useSlideObjects().
 * Pro renderer (surgical apply), použij tento hook s ObjectChangeSet callbackem.
 */

import { useEffect, useRef } from 'react'
import { subscribeToObjectChanges } from '@narrative/slide-model'
import type { ObjectChangeSet } from '@narrative/slide-model'
import { useSlideDoc } from './useSlideDoc.js'

/**
 * Subscribe na incremental changes s per-frame batching.
 *
 * Callback je uložen v ref — nezpůsobuje re-subscribe při každém re-renderu.
 * Re-subscribes pouze když se změní mutationCtx (nový Y.Doc).
 *
 * Initial call: callback je zavolán synchronně v rámci useEffect setup
 * s initial state { added: <všechny existující>, removed: [], updated: [], snapshot: [...] }.
 *
 * @param callback Funkce volaná při každém batched change setu
 */
export function useSlideObjectChanges(callback: (changes: ObjectChangeSet) => void): void {
  const { mutationCtx } = useSlideDoc()

  // Callback v ref — aby se neměnil subscribe při každém re-renderu
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    const unsubscribe = subscribeToObjectChanges(mutationCtx, (changes) =>
      callbackRef.current(changes),
    )
    return unsubscribe
  }, [mutationCtx])
}
