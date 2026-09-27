/**
 * agent/documents.ts
 *
 * How the agent host reaches live documents: through Hocuspocus direct
 * connections, so an agent write is an ordinary edit of the SAME in-memory
 * Y.Doc every open editor is synced to (the lesson of `pptx/appendDeck.ts`:
 * writing anywhere else is invisible to connected editors and gets
 * compacted away by the next snapshot).
 *
 * One direct connection per document, shared and reference-counted:
 *   - Every direct connection counts as a connection, so while a lease is
 *     held Hocuspocus cannot unload the document. An open agent run holds a
 *     lease for its whole life (runs.ts), which is what keeps its per-run
 *     undo history — which lives on the loaded Y.Doc — revertible while the
 *     agent works on a deck nobody has open.
 *   - `DirectConnection.transact` and `.disconnect` each persist a full
 *     snapshot immediately (Hocuspocus 2.15 runs the store hook with no
 *     debounce for direct connections). Sharing one connection and letting
 *     it linger briefly after the last release means a burst of agent reads
 *     and writes loads the document once and stores once per write, instead
 *     of load + store + store + unload per command.
 *
 * Connection context: `{ userId: 'agent-host', via: 'agent-host' }` and
 * deliberately NO `role`. `PostgresPersistence.onStoreDocument` skips the
 * store when the context says `viewer`, and the store a direct connection
 * triggers replaces any pending debounced store of the document — so a
 * viewer-flavoured context here would silently drop other people's
 * pending edits from that flush. Authorisation is the host's job
 * (serverHost.ts), done before a lease is ever taken.
 */

import type { Document, Hocuspocus } from '@hocuspocus/server'
import { subsystemLogger } from '../observability/logger.js'

const log = subsystemLogger('agent')

type DirectConnection = Awaited<ReturnType<Hocuspocus['openDirectConnection']>>

/** The context every agent-host direct connection carries (see the module header). */
export const AGENT_HOST_CONNECTION_CONTEXT = Object.freeze({
  userId: 'agent-host',
  via: 'agent-host',
})

export interface DocumentLease {
  readonly documentName: string
  /** The live document Hocuspocus holds for `documentName`. */
  readonly document: Document
  /**
   * Run `fn` against the live document and persist the result (one
   * immediate snapshot store). `fn` must be synchronous; it is where the
   * host opens its one Yjs transaction. Rejects only when `fn` throws; a
   * failed store after a successful write is logged, not thrown (the write
   * is already live, and the next store persists it).
   */
  transact(fn: (document: Document) => void): Promise<void>
  /** Give the lease back. Idempotent. */
  release(): void
}

export interface AgentDocuments {
  /** Take a lease on a document, loading it first if nobody has it open. */
  acquire(documentName: string): Promise<DocumentLease>
  /** The document if it is loaded and finished loading, else null. Never loads. */
  loaded(documentName: string): Document | null
  /** Disconnect every lingering connection now (shutdown, tests). */
  closeAll(): Promise<void>
}

interface Entry {
  connection: Promise<DirectConnection>
  refs: number
  linger: ReturnType<typeof setTimeout> | null
}

export interface AgentDocumentsOptions {
  /** How long a connection stays open after its last lease is released. */
  lingerMs?: number
}

export const DEFAULT_LINGER_MS = 30_000

export function createAgentDocuments(
  hocuspocus: Hocuspocus,
  opts: AgentDocumentsOptions = {},
): AgentDocuments {
  const lingerMs = opts.lingerMs ?? DEFAULT_LINGER_MS
  const entries = new Map<string, Entry>()

  const disconnect = async (documentName: string, entry: Entry): Promise<void> => {
    if (entries.get(documentName) === entry) entries.delete(documentName)
    try {
      const connection = await entry.connection
      await connection.disconnect()
    } catch (err) {
      log.error(
        { doc: documentName, err: err instanceof Error ? err.message : String(err) },
        'agent-host: disconnecting a direct connection failed',
      )
    }
  }

  const releaseEntry = (documentName: string, entry: Entry): void => {
    entry.refs -= 1
    if (entry.refs > 0) return
    if (lingerMs <= 0) {
      void disconnect(documentName, entry)
      return
    }
    entry.linger = setTimeout(() => {
      entry.linger = null
      if (entry.refs === 0) void disconnect(documentName, entry)
    }, lingerMs)
    entry.linger.unref?.()
  }

  return {
    async acquire(documentName) {
      let entry = entries.get(documentName)
      if (entry === undefined) {
        const created: Entry = {
          connection: hocuspocus.openDirectConnection(documentName, {
            ...AGENT_HOST_CONNECTION_CONTEXT,
          }),
          refs: 0,
          linger: null,
        }
        entries.set(documentName, created)
        // A failed open must not poison later attempts.
        created.connection.catch(() => {
          if (entries.get(documentName) === created) entries.delete(documentName)
        })
        entry = created
      }
      if (entry.linger !== null) {
        clearTimeout(entry.linger)
        entry.linger = null
      }
      entry.refs += 1
      const held = entry
      let connection: DirectConnection
      try {
        connection = await held.connection
      } catch (err) {
        held.refs -= 1
        throw err
      }
      const document = connection.document
      if (document === null) {
        held.refs -= 1
        throw new Error(`direct connection to '${documentName}' is closed`)
      }
      let released = false
      return {
        documentName,
        document,
        async transact(fn) {
          let applied = false
          try {
            await connection.transact((doc) => {
              fn(doc)
              applied = true
            })
          } catch (err) {
            // The write itself failed: nothing was applied (handlers check
            // every precondition before their first write), report it.
            if (!applied) throw err
            // The write was applied and broadcast, but the immediate store
            // after it failed. Reporting the op as failed would make the
            // agent retry and apply it twice; the change is live and is
            // persisted by the next store of the document.
            log.error(
              { doc: documentName, err: err instanceof Error ? err.message : String(err) },
              'agent-host: storing the document after a write failed',
            )
          }
        },
        release() {
          if (released) return
          released = true
          releaseEntry(documentName, held)
        },
      }
    },

    loaded(documentName) {
      const document = hocuspocus.documents.get(documentName)
      if (document === undefined || document.isLoading || document.isDestroyed) return null
      return document
    },

    async closeAll() {
      const all = [...entries.entries()]
      for (const [, entry] of all) {
        if (entry.linger !== null) clearTimeout(entry.linger)
      }
      await Promise.all(all.map(([name, entry]) => disconnect(name, entry)))
    },
  }
}
