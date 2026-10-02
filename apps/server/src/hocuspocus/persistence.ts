/**
 * hocuspocus/persistence.ts
 *
 * Custom Hocuspocus Extension pro Postgres persistence.
 * Implementuje onLoadDocument a onStoreDocument hooks.
 *
 * Strategy (PERF-2 — snapshot-compaction; supersedes the M4 append-only log):
 *   Every stored row is a *full, self-contained snapshot* of the doc — we call
 *   `Y.encodeStateAsUpdate(doc)` with NO target state vector, which encodes the
 *   entire document state, not a diff. The previous code appended one such
 *   snapshot per debounced flush and never deleted anything, so the updates
 *   table grew ~quadratically per editing session and cold-load replayed the
 *   whole history (O(total-edits × doc-size)).
 *
 *   onStoreDocument now, inside a single DB transaction:
 *     1. inserts the new full snapshot row, and
 *     2. deletes every OLDER row for that doc (id < the just-inserted id).
 *   This collapses storage and cold-load to O(doc-size) while keeping each row
 *   self-contained — there is no fragile diff chain to corrupt.
 *
 *   onLoadDocument still applies *all* remaining rows sequentially. Because
 *   each row is a full snapshot and Yjs updates are idempotent/commutative,
 *   applying one-or-many full snapshots always yields the same state. This is
 *   what makes the load backward-compatible: decks written by the old
 *   append-only code hold many full-snapshot rows today, and they load
 *   correctly; the FIRST store after deploy compacts them down to one row.
 *
 * Atomicity guarantee:
 *   The insert-new + delete-old pair runs in one `db.transaction`. The delete
 *   is keyed on `id < newId`, so it can never remove the row written in the
 *   same transaction. A crash (or rolled-back tx) at any point leaves either
 *   the full prior set of rows (tx never committed) or the prior set PLUS the
 *   new snapshot (delete portion is part of the same atomic commit). There is
 *   no window in which the doc has zero rows or an unloadable state.
 *
 * Hocuspocus volá onStoreDocument debounced (default 2s po posledním onChange),
 * takže při aktivní editaci neukladáme po každém znaku.
 *
 * Doc name routing (M16 P2):
 *   `deck:<id>`   → deck_updates table, deckId column
 *   `folder:<id>` → folder_updates table, folderId column
 *   `component:<id>` → component_updates table, componentId column
 *   Anything else is treated as a legacy bare deckId (backward compat).
 */

import type { Extension, onLoadDocumentPayload, onStoreDocumentPayload } from '@hocuspocus/server'
import * as Y from 'yjs'
import { and, eq, lt } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import {
  componentUpdates,
  components,
  deckUpdates,
  decks,
  folderUpdates,
  folders,
} from '../db/schema.js'
import { closeConnectionsForDocument } from './connections.js'
import { subsystemLogger } from '../observability/logger.js'

const log = subsystemLogger('persistence')

// ---------------------------------------------------------------------------
// DOS-1: per-document size cap.
//
// Any authenticated editor can stream unbounded updates, inflating both the
// persisted snapshot and server memory without bound. We cap the encoded doc
// size. The cap is on GROWTH, not absolute size, so we never lock an existing
// over-limit doc out of being saved/shrunk:
//
//   reject a store iff  size > MAX_DOC_BYTES  AND  size > lastStoredSize
//
// i.e. a doc already above the limit may still be persisted as long as it is
// not growing — an editor deleting content to get back under budget always
// succeeds. A doc under the limit is always fine. Only net growth past the
// limit is refused, and the offending connection(s) are disconnected.
// ---------------------------------------------------------------------------

function resolveMaxDocBytes(): number {
  const raw = process.env['MAX_DOC_BYTES']
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 32 * 1024 * 1024 // 32 MB default
}

// ---------------------------------------------------------------------------
// Internal: parse doc name to determine storage backend
// ---------------------------------------------------------------------------

type DocKind = 'deck' | 'folder' | 'component'

type DocTarget = { kind: DocKind; id: string }

/** What a store's transaction answers when the document's owner is gone. */
const OWNER_DELETED = Symbol('owner deleted')

function parseDocName(name: string): DocTarget {
  if (name.startsWith('folder:')) {
    return { kind: 'folder', id: name.slice('folder:'.length) }
  }
  if (name.startsWith('component:')) {
    return { kind: 'component', id: name.slice('component:'.length) }
  }
  // deck:<id> prefix OR legacy bare deck id (backward compat)
  const id = name.startsWith('deck:') ? name.slice('deck:'.length) : name
  return { kind: 'deck', id }
}

// ---------------------------------------------------------------------------
// Internal: per-kind table binding. Each kind maps to its updates table plus
// the typed column accessors we need (the FK id column and the serial id).
// Collapsing the three near-identical branches into one config table keeps the
// load/store/compaction logic single-sourced — adding a fourth doc kind is one
// entry here, not three copy-pasted blocks.
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
type DbOrTx = Database | Tx

interface TableBinding {
  /**
   * Whether the document's owner (the deck, folder or component row) still
   * exists, locking it `FOR KEY SHARE` until the transaction ends — the lock
   * the snapshot's foreign key takes anyway — so it cannot be deleted
   * between this check and the insert.
   */
  lockOwner(db: DbOrTx, id: string): Promise<boolean>
  /** Run `fn` for the matching kind; returns its result. */
  insertRow(db: DbOrTx, id: string, update: Uint8Array): Promise<{ id: number }[]>
  selectRows(db: DbOrTx, id: string): Promise<{ update: Uint8Array }[]>
  /** Delete every row for this doc with serial id strictly less than `keepFromId`. */
  deleteOlder(db: DbOrTx, id: string, keepFromId: number): Promise<unknown>
}

const BINDINGS: Record<DocKind, TableBinding> = {
  deck: {
    lockOwner: async (db, id) =>
      (await db.select({ id: decks.id }).from(decks).where(eq(decks.id, id)).for('key share'))
        .length > 0,
    insertRow: (db, id, update) =>
      db.insert(deckUpdates).values({ deckId: id, update }).returning({ id: deckUpdates.id }),
    selectRows: (db, id) =>
      db
        .select({ update: deckUpdates.update })
        .from(deckUpdates)
        .where(eq(deckUpdates.deckId, id))
        .orderBy(deckUpdates.id),
    deleteOlder: (db, id, keepFromId) =>
      db.delete(deckUpdates).where(and(eq(deckUpdates.deckId, id), lt(deckUpdates.id, keepFromId))),
  },
  folder: {
    lockOwner: async (db, id) =>
      (await db.select({ id: folders.id }).from(folders).where(eq(folders.id, id)).for('key share'))
        .length > 0,
    insertRow: (db, id, update) =>
      db.insert(folderUpdates).values({ folderId: id, update }).returning({ id: folderUpdates.id }),
    selectRows: (db, id) =>
      db
        .select({ update: folderUpdates.update })
        .from(folderUpdates)
        .where(eq(folderUpdates.folderId, id))
        .orderBy(folderUpdates.id),
    deleteOlder: (db, id, keepFromId) =>
      db
        .delete(folderUpdates)
        .where(and(eq(folderUpdates.folderId, id), lt(folderUpdates.id, keepFromId))),
  },
  component: {
    lockOwner: async (db, id) =>
      (
        await db
          .select({ id: components.id })
          .from(components)
          .where(eq(components.id, id))
          .for('key share')
      ).length > 0,
    insertRow: (db, id, update) =>
      db
        .insert(componentUpdates)
        .values({ componentId: id, update })
        .returning({ id: componentUpdates.id }),
    selectRows: (db, id) =>
      db
        .select({ update: componentUpdates.update })
        .from(componentUpdates)
        .where(eq(componentUpdates.componentId, id))
        .orderBy(componentUpdates.id),
    deleteOlder: (db, id, keepFromId) =>
      db
        .delete(componentUpdates)
        .where(and(eq(componentUpdates.componentId, id), lt(componentUpdates.id, keepFromId))),
  },
}

// ---------------------------------------------------------------------------
// PostgresPersistence
// ---------------------------------------------------------------------------

export class PostgresPersistence implements Extension {
  private readonly db: Database

  /** DOS-1 cap (bytes). Resolved once at construction from MAX_DOC_BYTES. */
  private readonly maxDocBytes: number

  /**
   * DOS-1: last successfully-persisted encoded size per document name. Drives
   * the growth check — a store larger than BOTH the cap AND the last stored
   * size is refused. Seeded on load (so a doc that was already over-limit when
   * loaded isn't treated as "growth" on its first save). Bounded by the live
   * document set: entries for unloaded docs are stale but harmless (a tiny
   * string→number map) and re-seeded on next load.
   */
  private readonly lastStoredBytes = new Map<string, number>()

  constructor(opts: { db: Database }) {
    this.db = opts.db
    this.maxDocBytes = resolveMaxDocBytes()
  }

  async onLoadDocument(data: onLoadDocumentPayload): Promise<Y.Doc | void> {
    const target = parseDocName(data.documentName)
    const doc = data.document
    const binding = BINDINGS[target.kind]

    // Apply rows individually wrapped in try/catch so a single corrupt
    // update buffer doesn't fail the entire load and drop the WS connection.
    // Corrupted rows are logged and skipped; the doc is still returned with
    // the largest possible recoverable state.
    //
    // Each row is a full, self-contained snapshot (see module header). After
    // the first store under the compaction strategy there is normally exactly
    // one row; old decks may still hold many. Applying all of them is always
    // correct — Yjs updates are idempotent and commutative, so replaying N
    // full snapshots yields the same state as replaying only the newest.
    const applyAll = (rows: ReadonlyArray<{ update: Uint8Array }>): number => {
      let applied = 0
      let skipped = 0
      for (const row of rows) {
        try {
          Y.applyUpdate(doc, row.update)
          applied++
        } catch (err) {
          skipped++
          log.error(
            { doc: data.documentName, err: err instanceof Error ? err.message : String(err) },
            'corrupt update row — skipping',
          )
        }
      }
      if (skipped > 0) {
        log.warn(
          { doc: data.documentName, applied, skipped },
          'applied with corrupt updates skipped',
        )
      }
      return applied
    }

    const rows = await binding.selectRows(this.db, target.id)

    if (rows.length === 0) {
      // Prázdný doc — vrátíme void, Hocuspocus použije fresh Y.Doc
      return
    }

    const applied = applyAll(rows)
    log.info(
      { kind: target.kind, id: target.id, applied, total: rows.length },
      'loaded snapshot rows',
    )

    // DOS-1: seed the growth baseline with the freshly-loaded size, so a doc
    // that is ALREADY over the cap at load time is not treated as "growth" on
    // its first store (only further net growth past the cap is refused).
    this.lastStoredBytes.set(data.documentName, Y.encodeStateAsUpdate(doc).byteLength)

    return doc
  }

  async onStoreDocument(data: onStoreDocumentPayload): Promise<void> {
    const target = parseDocName(data.documentName)
    const binding = BINDINGS[target.kind]
    const ctx = data.context as { role?: string; userId?: string } | undefined

    // Defense-in-depth: skip persistence for viewer connections.
    // Primary enforcement is `readOnly: true` returned from onAuthenticate,
    // which prevents Hocuspocus from accepting update messages at protocol level.
    // This guard handles any edge-cases (e.g. server-side writes accidentally routed
    // through a viewer-context document).
    if (ctx?.role === 'viewer') {
      log.warn(
        { userId: ctx.userId ?? 'unknown', doc: data.documentName },
        'blocked write from viewer',
      )
      return
    }

    // Full self-contained snapshot of the doc (no target state vector → entire
    // state, not a diff). This is what makes snapshot-compaction safe: the row
    // we are about to write fully supersedes every older row.
    const update = Y.encodeStateAsUpdate(data.document)

    // DOS-1: refuse to persist net growth past the cap, and disconnect the
    // editor(s) flooding this doc. We compare against BOTH the cap and the
    // last persisted size so an already-over-limit doc can still be saved as
    // long as it isn't growing (shrinking edits always succeed). We do NOT
    // touch the existing rows — the doc stays loadable at its last good size.
    const size = update.byteLength
    const lastStored = this.lastStoredBytes.get(data.documentName)
    if (size > this.maxDocBytes && (lastStored === undefined || size > lastStored)) {
      log.error(
        {
          kind: target.kind,
          id: target.id,
          size,
          cap: this.maxDocBytes,
          lastStored: lastStored ?? null,
        },
        'DOS-1 size cap hit — refusing to persist growth and disconnecting connections on this doc',
      )
      // Kick the connection(s) on this doc so the flood stops. The client may
      // reconnect, but it loads the last GOOD (≤ last-stored) snapshot, so it
      // can't immediately re-flush the oversized state it just lost.
      try {
        closeConnectionsForDocument(data.documentName)
      } catch (err) {
        log.error({ doc: data.documentName, err }, 'DOS-1 disconnect failed')
      }
      return
    }

    // Wrap the whole store in try/catch so a transient DB error (network blip,
    // pool exhaustion, deadlock) doesn't propagate up to Hocuspocus and
    // tear down the WebSocket connection — clients then have to reconnect
    // and lose the in-flight transaction. We log loudly so failures are
    // visible; future TODO is to push the update to a DLQ for replay.
    try {
      // Atomic compaction: insert the new full snapshot, then delete every
      // OLDER row in the SAME transaction. The delete is bounded by
      // `id < newId`, so it can never remove the row we just inserted, and the
      // commit is all-or-nothing — there is no window where the doc has zero
      // rows. If the tx rolls back, the prior rows remain intact and the next
      // debounced store retries.
      const deletedOlder = await this.db.transaction(async (tx) => {
        // A document whose deck, folder or component was deleted while it
        // was still loaded (the debounced store runs after the delete): there
        // is nothing to keep, and its rows went with the owner.
        if (!(await binding.lockOwner(tx, target.id))) return OWNER_DELETED
        const inserted = await binding.insertRow(tx, target.id, update)
        const newId = inserted[0]?.id
        if (newId === undefined) {
          // Should never happen (RETURNING on a successful insert), but if the
          // driver gives us no id we must NOT run an unbounded delete — bail
          // out of compaction and keep the row we just wrote.
          throw new Error(`insert returned no id for ${target.kind}=${target.id}`)
        }
        const res = await binding.deleteOlder(tx, target.id, newId)
        // node-postgres exposes rowCount on the result; best-effort for logging.
        const count = (res as { rowCount?: number } | undefined)?.rowCount
        return typeof count === 'number' ? count : undefined
      })

      if (deletedOlder === OWNER_DELETED) {
        this.lastStoredBytes.delete(data.documentName)
        log.info(
          { kind: target.kind, id: target.id },
          'not stored: the document belongs to a deleted ' + target.kind,
        )
        return
      }

      // DOS-1: record the size we just persisted as the new growth baseline.
      this.lastStoredBytes.set(data.documentName, size)

      log.info(
        {
          kind: target.kind,
          id: target.id,
          bytes: update.byteLength,
          compactedOlderRows: deletedOlder ?? null,
        },
        'stored snapshot',
      )
    } catch (err) {
      // CRITICAL: a swallowed persistence error means the in-memory Y.Doc
      // diverges from the database. Hocuspocus retries onStoreDocument on
      // the next debounce window, so a transient DB error usually self-
      // heals. A persistent error is still data loss — surface it loudly.
      log.error(
        { kind: target.kind, id: target.id, bytes: update.byteLength, err },
        'FAILED to store snapshot',
      )
    }
  }
}
