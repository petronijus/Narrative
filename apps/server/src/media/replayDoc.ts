/**
 * media/replayDoc.ts
 *
 * Shared helper: rehydrate a Y.Doc by applying a sequence of binary updates.
 *
 * Originally inlined in routes/tokens.ts (M16 P4). M16 P6 adds
 * routes/components.ts → /components/:id/instance-count which needs the
 * same primitive, so we extract it here.
 *
 * Returns a fresh Y.Doc — callers must `doc.destroy()` when done to
 * release Yjs subscribers / GC the internal CRDT state.
 *
 * No I/O happens here; the caller is responsible for fetching the
 * `update` rows from Postgres in primary-key order.
 */

import * as Y from 'yjs'

export interface UpdateRow {
  update: Uint8Array
}

export function replayUpdates(updateRows: ReadonlyArray<UpdateRow>): Y.Doc {
  const doc = new Y.Doc()
  for (const row of updateRows) {
    Y.applyUpdate(doc, row.update)
  }
  return doc
}
