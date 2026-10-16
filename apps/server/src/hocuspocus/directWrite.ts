/**
 * hocuspocus/directWrite.ts — a server-side write into a live document over
 * a direct connection, under the writer's own transaction origin, stored
 * right after.
 *
 * Hocuspocus 4's `DirectConnection.transact` wraps the callback in a
 * transaction of its own (origin `{ source: 'local', context }`), and a Yjs
 * transaction opened inside another takes the OUTER one's origin — so every
 * origin the server writes under would be lost: the run origins undo,
 * revert and attribution key on (services/runs.ts), the deck hydration
 * origin, the data-migration origin. It also no longer stores the document
 * after the write. This does what 2.x's `transact` did: the callback gets
 * the live document, its own `doc.transact(…, origin)` keeps that origin,
 * and the store hooks run immediately (not on the debounce), so a write is
 * persisted as it happens. A store that fails is logged by Hocuspocus and
 * leaves the document in memory to be stored again; the write stands.
 */

import type { Document, Hocuspocus } from '@hocuspocus/server'

/** The connection `openDirectConnection` resolves to (the class, with its document). */
type DirectConnection = Awaited<ReturnType<Hocuspocus['openDirectConnection']>>

export async function transactDirect(
  connection: DirectConnection,
  fn: (document: Document) => void,
): Promise<void> {
  const document = connection.document
  if (document === null) throw new Error('direct connection closed')
  fn(document)
  await connection.instance.storeDocumentHooks(
    document,
    {
      clientsCount: document.getConnectionsCount(),
      lastContext: connection.context,
      lastTransactionOrigin: { source: 'local', context: connection.context },
      document,
      documentName: document.name,
      instance: connection.instance,
    },
    true,
  )
}
