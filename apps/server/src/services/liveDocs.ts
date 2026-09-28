/**
 * services/liveDocs.ts
 *
 * Reading and writing Yjs documents from server services, always against
 * the copy people see:
 *
 *   - A document someone has open lives in the Hocuspocus instance, and its
 *     persisted snapshot can be up to the store debounce (10 s) behind. Reads
 *     therefore take the LIVE copy when it is loaded and fall back to the
 *     stored rows only when nobody has it open.
 *   - Writes go through `openDirectConnection`, which loads the document if
 *     needed and makes the write an ordinary edit: connected editors receive
 *     it at once and it persists by the same path as every other change. A
 *     row written underneath a loaded document would be invisible to its
 *     editors and deleted by the next compacting store (see pptx/appendDeck.ts).
 *     The write runs in ONE `doc.transact(fn, origin)`, so it reaches clients
 *     as one update and — with an agent origin — is one step of the run's
 *     revert.
 *
 * Document names follow the sync server: a deck is its bare id (the editor's
 * provider name), folders are `folder:<id>`, component masters
 * `component:<id>`. Decks are also looked up under the `deck:<id>` alias
 * presence.ts knows about.
 *
 * Without a sync server in the process (route-only unit tests) reads replay
 * the stored rows and writes append one delta row, which is exact because
 * nothing holds the document in memory.
 */

import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import type { Hocuspocus } from '@hocuspocus/server'
import type { Database } from '../db/client.js'
import { componentUpdates, deckUpdates, folderUpdates } from '../db/schema.js'
import { getHocuspocusInstance } from '../hocuspocus/presence.js'
import type { ServiceDeps } from './deps.js'

export type DocKind = 'deck' | 'folder' | 'component'

/**
 * Origin of a document write a PERSON asked a server route for (pasting
 * slides from another deck, …) — as opposed to an agent run's
 * `agentOrigin(runId)`. It names the write in metrics and logs; editors
 * receive it as a remote change like any collaborator's edit.
 */
export const SERVER_EDIT_ORIGIN = Symbol('server-edit')

/** The sync-server document name of a deck, folder or component master. */
export function documentName(kind: DocKind, id: string): string {
  if (kind === 'folder') return `folder:${id}`
  if (kind === 'component') return `component:${id}`
  return id
}

function hocuspocusOf(deps: Pick<ServiceDeps, 'hocuspocus'>): Hocuspocus | null {
  return (deps.hocuspocus ?? getHocuspocusInstance)()
}

/** The live, loaded document, if someone has it open (or it has not unloaded yet). */
export function loadedDocument(
  deps: Pick<ServiceDeps, 'hocuspocus'>,
  kind: DocKind,
  id: string,
): Y.Doc | null {
  const hp = hocuspocusOf(deps)
  if (hp === null) return null
  const names = kind === 'deck' ? [id, `deck:${id}`] : [documentName(kind, id)]
  for (const name of names) {
    const doc = hp.documents.get(name)
    if (doc !== undefined) return doc
  }
  return null
}

async function storedRows(
  db: Database,
  kind: DocKind,
  id: string,
): Promise<Array<{ update: Uint8Array }>> {
  if (kind === 'folder') {
    return db
      .select({ update: folderUpdates.update })
      .from(folderUpdates)
      .where(eq(folderUpdates.folderId, id))
      .orderBy(folderUpdates.id)
  }
  if (kind === 'component') {
    return db
      .select({ update: componentUpdates.update })
      .from(componentUpdates)
      .where(eq(componentUpdates.componentId, id))
      .orderBy(componentUpdates.id)
  }
  return db
    .select({ update: deckUpdates.update })
    .from(deckUpdates)
    .where(eq(deckUpdates.deckId, id))
    .orderBy(deckUpdates.id)
}

/**
 * The document's current state as one update (`Y.encodeStateAsUpdate`):
 * live when loaded, else the stored rows merged. A corrupt stored row is
 * skipped (and logged), as the persistence extension does on load.
 */
export async function readDocState(
  deps: Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>,
  kind: DocKind,
  id: string,
): Promise<Uint8Array> {
  const live = loadedDocument(deps, kind, id)
  if (live !== null) return Y.encodeStateAsUpdate(live)
  const doc = new Y.Doc()
  try {
    for (const row of await storedRows(deps.db, kind, id)) {
      try {
        Y.applyUpdate(doc, row.update)
      } catch (err) {
        deps.log.warn({ err, kind, id }, 'skipping corrupt stored update row')
      }
    }
    return Y.encodeStateAsUpdate(doc)
  } finally {
    doc.destroy()
  }
}

/** A detached copy of the document (see `readDocState`). The caller destroys it. */
export async function readDocCopy(
  deps: Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>,
  kind: DocKind,
  id: string,
): Promise<Y.Doc> {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await readDocState(deps, kind, id))
  return doc
}

/**
 * Run `fn` against the live document in ONE transaction with `origin`, and
 * return its result. `fn` must be synchronous and must validate before its
 * first write: a Yjs transaction cannot be rolled back.
 *
 * `touched` reports whether `fn` started running (then the document may have
 * changed even if this rejects — e.g. a store hook refused the result).
 */
export async function writeLiveDoc<T>(
  deps: Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>,
  kind: DocKind,
  id: string,
  fn: (doc: Y.Doc) => T,
  origin?: unknown,
  touched?: { value: boolean },
): Promise<T> {
  const hp = hocuspocusOf(deps)
  let result: { value: T } | null = null
  if (hp !== null) {
    const connection = await hp.openDirectConnection(documentName(kind, id))
    try {
      await connection.transact((doc) => {
        if (touched !== undefined) touched.value = true
        doc.transact(() => {
          result = { value: fn(doc) }
        }, origin)
      })
    } finally {
      await connection.disconnect()
    }
  } else {
    const doc = await readDocCopy(deps, kind, id)
    try {
      const before = Y.encodeStateVector(doc)
      if (touched !== undefined) touched.value = true
      doc.transact(() => {
        result = { value: fn(doc) }
      }, origin)
      const delta = Y.encodeStateAsUpdate(doc, before)
      await insertRow(deps.db, kind, id, delta)
    } finally {
      doc.destroy()
    }
  }
  if (result === null) throw new Error(`writeLiveDoc(${kind}:${id}): the write did not run`)
  return (result as { value: T }).value
}

async function insertRow(db: Database, kind: DocKind, id: string, update: Uint8Array) {
  if (kind === 'folder') await db.insert(folderUpdates).values({ folderId: id, update })
  else if (kind === 'component')
    await db.insert(componentUpdates).values({ componentId: id, update })
  else await db.insert(deckUpdates).values({ deckId: id, update })
}
