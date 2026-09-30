/**
 * state/providerSaved.ts — waiting until the server holds every local change.
 *
 * Some writes run on the server and read a document live there — promoting
 * objects to a component reads the deck the objects are on. Such a request
 * must not overtake the edits the user made a moment before (naming the text
 * box, flagging the page number): the sync server acknowledges every update
 * a provider sends, and `hasUnsyncedChanges` turns false once each one was.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider'

/** How long a save may take before the waiting write gives up. */
export const SAVE_TIMEOUT_MS = 10_000

/**
 * Resolves once `provider` has synced and the server has acknowledged every
 * local update sent so far; rejects after `timeoutMs` (offline, or a server
 * that stopped answering), so the caller can tell the user instead of
 * writing from a stale document.
 */
export function whenProviderSaved(
  provider: HocuspocusProvider,
  timeoutMs = SAVE_TIMEOUT_MS,
): Promise<void> {
  const saved = (): boolean => provider.synced && !provider.hasUnsyncedChanges
  if (saved()) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const check = (): void => {
      if (!saved()) return
      cleanup()
      resolve()
    }
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('The server has not confirmed your latest changes yet; try again'))
    }, timeoutMs)
    const cleanup = (): void => {
      window.clearTimeout(timer)
      provider.off('unsyncedChanges', check)
      provider.off('synced', check)
    }
    provider.on('unsyncedChanges', check)
    provider.on('synced', check)
  })
}
