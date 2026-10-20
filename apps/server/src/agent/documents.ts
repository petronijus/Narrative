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
 *   - Sharing one connection and letting it linger briefly after the last
 *     release means a burst of agent reads and writes loads the document
 *     once, instead of load + unload per command.
 *
 * Durability (performance.md S3, 2026-10-18). A write is NOT stored on its
 * own: `transact` applies it to the live document — every connected editor
 * receives it at once — and leaves the snapshot store to the sync server's
 * debounce, as for an editor's edits (2 s after the document's last change,
 * at most 10 s after the first unstored one; hocuspocus/index.ts). Each
 * store writes the whole document (ADR 0006), so storing per command made
 * an agent's build of a large deck write the deck once per command. What
 * is guaranteed:
 *   - when a command returns, its change is in the live document and
 *     broadcast, and its op is in `agent_ops` (serverHost.ts);
 *   - it is stored within the debounce window, and at once (awaited) when
 *     the run closes (`persist`, services/runs.ts `closeRun`) and after a
 *     revert; when the agent host lets go of its connection (`disconnect`
 *     stores before the document unloads); on graceful shutdown
 *     (`closeAll`, then Hocuspocus stores and unloads every document);
 *   - after a crash the document loses at most the writes of that window —
 *     the same window people's edits have. `agent_ops` keeps those ops (it
 *     records what was asked and answered), and the run's revert history
 *     lived in memory anyway (ADR 0011: a restart makes a run unrevertible).
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
import { storeDirect, writeDirect } from '../hocuspocus/directWrite.js'

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
   * Run `fn` against the live document. `fn` must be synchronous; it is
   * where the host opens its one Yjs transaction. The change is stored on
   * the sync server's debounce, not here (module header: Durability).
   * Rejects only when `fn` throws.
   */
  transact(fn: (document: Document) => void): Promise<void>
  /**
   * Store the document now and wait for it (a durability point: the end of
   * a run, a revert). Never rejects for a failed store: that is logged, the
   * document stays in memory, and the next store persists it.
   */
  persist(): Promise<void>
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
          // A throw here means the write did not happen (handlers check every
          // precondition before their first write); it propagates.
          writeDirect(connection, fn)
        },
        async persist() {
          try {
            await storeDirect(connection)
          } catch (err) {
            // Only a closed connection throws here (Hocuspocus catches store
            // failures itself); the document was then stored as it closed.
            log.error(
              { doc: documentName, err: err instanceof Error ? err.message : String(err) },
              'agent-host: storing the document failed',
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
