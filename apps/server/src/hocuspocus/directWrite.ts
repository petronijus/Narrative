/**
 * hocuspocus/directWrite.ts — a server-side write into a live document over
 * a direct connection, under the writer's own transaction origin, and the
 * store of that document.
 *
 * Hocuspocus 4's `DirectConnection.transact` wraps the callback in a
 * transaction of its own (origin `{ source: 'local', context }`), and a Yjs
 * transaction opened inside another takes the OUTER one's origin — so every
 * origin the server writes under would be lost: the run origins undo,
 * revert and attribution key on (services/runs.ts), the deck hydration
 * origin, the data-migration origin. It also no longer stores the document
 * after the write. So the callback here gets the live document itself, and
 * its own `doc.transact(…, origin)` keeps that origin.
 *
 * Two ways to persist what was written:
 *   - `writeDirect` leaves it to the sync server's debounce (2 s after the
 *     document's last change, at most 10 s after the first unstored one,
 *     hocuspocus/index.ts): the write's update reaches Hocuspocus's
 *     `onUpdate` like any editor's, whose origin is no Hocuspocus
 *     transaction origin, so the store hooks are scheduled for it. Many
 *     writes in a burst cost one snapshot store (the agent host, ADR 0011
 *     as amended in docs/plans/performance.md S3).
 *   - `transactDirect` = `writeDirect` + `storeDirect`: the store runs now
 *     and is awaited, as 2.x's `transact` did — for one-off server writes
 *     (services/liveDocs.ts, pptx/appendDeck.ts) whose caller wants the
 *     write persisted when it returns.
 * A store that fails is logged by Hocuspocus and leaves the document in
 * memory to be stored again; the write stands.
 */

import type { Document, Hocuspocus } from '@hocuspocus/server'

/** The connection `openDirectConnection` resolves to (the class, with its document). */
type DirectConnection = Awaited<ReturnType<Hocuspocus['openDirectConnection']>>

/**
 * Run `fn` against the live document (it opens its own transaction). The
 * document is stored on the sync server's debounce; see the module header.
 */
export function writeDirect(connection: DirectConnection, fn: (document: Document) => void): void {
  const document = connection.document
  if (document === null) throw new Error('direct connection closed')
  fn(document)
}

/**
 * Store the document now and wait for it: replaces a pending debounced
 * store of it, and waits for one already running before it starts. Resolves
 * also when the store failed (Hocuspocus logs that and keeps the document).
 */
export async function storeDirect(connection: DirectConnection): Promise<void> {
  const document = connection.document
  if (document === null) throw new Error('direct connection closed')
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

/** `writeDirect`, then the store at once (awaited). */
export async function transactDirect(
  connection: DirectConnection,
  fn: (document: Document) => void,
): Promise<void> {
  writeDirect(connection, fn)
  await storeDirect(connection)
}
