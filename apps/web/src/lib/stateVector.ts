/**
 * lib/stateVector.ts — has a Yjs document seen everything another one had?
 *
 * The editor asks the render page for a picture of a slide; the page holds
 * its own copy of the deck, fed through the sync server. Before it draws,
 * it waits until its copy covers the editor's state vector at the moment of
 * asking, so the picture shows the edits made a moment ago.
 */

import * as Y from 'yjs'

/** Does `doc` include every update `stateVector` (Y.encodeStateVector of another doc) names? */
export function coversStateVector(doc: Y.Doc, stateVector: Uint8Array): boolean {
  const mine = Y.decodeStateVector(Y.encodeStateVector(doc))
  for (const [client, clock] of Y.decodeStateVector(stateVector)) {
    if ((mine.get(client) ?? 0) < clock) return false
  }
  return true
}

/** Resolves once `doc` covers `stateVector`; rejects after `timeoutMs`. */
export function untilCoversStateVector(
  doc: Y.Doc,
  stateVector: Uint8Array,
  timeoutMs: number,
): Promise<void> {
  if (coversStateVector(doc, stateVector)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (!coversStateVector(doc, stateVector)) return
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('the latest edits did not arrive in time'))
    }, timeoutMs)
    const cleanup = (): void => {
      clearTimeout(timer)
      doc.off('update', check)
    }
    doc.on('update', check)
  })
}

/** Base64 for passing a state vector between windows as a string. */
export function encodeStateVectorBase64(doc: Y.Doc): string {
  let binary = ''
  for (const byte of Y.encodeStateVector(doc)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
