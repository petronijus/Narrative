/**
 * state/frozenRenderDoc.ts — the document of a frozen render page
 * (`/deck/:id/render?frozen=1`, agentic A3.6): no live document behind it,
 * only the state the render worker hands it — a compare's "before", the
 * deck as it was at the start of an agent run (apps/render-worker
 * `drawBefore`). The worker calls `window.__narrativeRenderFreeze(state)`
 * with the base64 of `Y.encodeStateAsUpdate`, once, before anything else;
 * until then the page shows nothing, so it never reports a deck it does not
 * hold yet.
 */

import { useEffect, useState } from 'react'
import * as Y from 'yjs'

declare global {
  interface Window {
    /** A frozen render page's: the document state it is to show. */
    __narrativeRenderFreeze?: (state: string) => void
  }
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The frozen document once the worker handed it over; null before (and when not `enabled`). */
export function useFrozenRenderDoc(enabled: boolean): Y.Doc | null {
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  useEffect(() => {
    if (!enabled) return
    window.__narrativeRenderFreeze = (state: string) => {
      const next = new Y.Doc()
      Y.applyUpdate(next, decodeBase64(state))
      setDoc(next)
    }
    return () => {
      delete window.__narrativeRenderFreeze
    }
  }, [enabled])
  useEffect(() => () => doc?.destroy(), [doc])
  return doc
}
