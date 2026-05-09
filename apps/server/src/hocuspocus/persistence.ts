/**
 * hocuspocus/persistence.ts
 *
 * Custom Hocuspocus Extension pro Postgres persistence.
 * Implementuje onLoadDocument a onStoreDocument hooks.
 *
 * Strategy (M4 — append-only):
 *   onLoadDocument: načte všechny update rows pro dokument, aplikuje sekvenčně
 *   onStoreDocument: uloží Y.encodeStateAsUpdate() jako nový row
 *
 * Hocuspocus volá onStoreDocument debounced (default 2s po posledním onChange),
 * takže při aktivní editaci neukladáme po každém znaku.
 *
 * Doc name routing (M16 P2):
 *   `deck:<id>`   → deck_updates table, deckId column
 *   `folder:<id>` → folder_updates table, folderId column
 *   Anything else is treated as a legacy bare deckId (backward compat).
 *
 * TODO(M29): kompakce — po N updatech sloučit do jednoho snapshot row
 *            (loadDocument je teď O(N) updates, pro tisíce updates zpomalí)
 */

import type { Extension, onLoadDocumentPayload, onStoreDocumentPayload } from '@hocuspocus/server'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { deckUpdates, folderUpdates, componentUpdates } from '../db/schema.js'

// ---------------------------------------------------------------------------
// Internal: parse doc name to determine storage backend
// ---------------------------------------------------------------------------

type DocTarget =
  | { kind: 'deck'; id: string }
  | { kind: 'folder'; id: string }
  | { kind: 'component'; id: string }

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
// PostgresPersistence
// ---------------------------------------------------------------------------

export class PostgresPersistence implements Extension {
  private readonly db: Database

  constructor(opts: { db: Database }) {
    this.db = opts.db
  }

  async onLoadDocument(data: onLoadDocumentPayload): Promise<Y.Doc | void> {
    const target = parseDocName(data.documentName)
    const doc = data.document

    // Apply rows individually wrapped in try/catch so a single corrupt
    // update buffer doesn't fail the entire load and drop the WS connection.
    // Corrupted rows are logged and skipped; the doc is still returned with
    // the largest possible recoverable state.
    const applyAll = (rows: ReadonlyArray<{ update: Uint8Array }>): number => {
      let applied = 0
      let skipped = 0
      for (const row of rows) {
        try {
          Y.applyUpdate(doc, row.update)
          applied++
        } catch (err) {
          skipped++
          console.error(
            `[persistence] Corrupt update row for doc=${data.documentName}: ${err instanceof Error ? err.message : String(err)} — skipping`,
          )
        }
      }
      if (skipped > 0) {
        console.warn(
          `[persistence] doc=${data.documentName}: applied=${applied} skipped=${skipped} (corrupt updates)`,
        )
      }
      return applied
    }

    if (target.kind === 'folder') {
      const rows = await this.db
        .select({ update: folderUpdates.update })
        .from(folderUpdates)
        .where(eq(folderUpdates.folderId, target.id))
        .orderBy(folderUpdates.id)

      if (rows.length === 0) return

      const applied = applyAll(rows)
      console.log(`[persistence] Loaded ${applied}/${rows.length} updates for folder=${target.id}`)
      return doc
    }

    if (target.kind === 'component') {
      const rows = await this.db
        .select({ update: componentUpdates.update })
        .from(componentUpdates)
        .where(eq(componentUpdates.componentId, target.id))
        .orderBy(componentUpdates.id)

      if (rows.length === 0) return

      const applied = applyAll(rows)
      console.log(
        `[persistence] Loaded ${applied}/${rows.length} updates for component=${target.id}`,
      )
      return doc
    }

    // deck (legacy bare id or deck:<id> prefix)
    const rows = await this.db
      .select({ update: deckUpdates.update })
      .from(deckUpdates)
      .where(eq(deckUpdates.deckId, target.id))
      .orderBy(deckUpdates.id)

    if (rows.length === 0) {
      // Prázdný deck — vrátíme void, Hocuspocus použije fresh Y.Doc
      return
    }

    const applied = applyAll(rows)
    console.log(`[persistence] Loaded ${applied}/${rows.length} updates for deck=${target.id}`)
    return doc
  }

  async onStoreDocument(data: onStoreDocumentPayload): Promise<void> {
    const target = parseDocName(data.documentName)
    const ctx = data.context as { role?: string; userId?: string } | undefined

    // Defense-in-depth: skip persistence for viewer connections.
    // Primary enforcement is `readOnly: true` returned from onAuthenticate,
    // which prevents Hocuspocus from accepting update messages at protocol level.
    // This guard handles any edge-cases (e.g. server-side writes accidentally routed
    // through a viewer-context document).
    if (ctx?.role === 'viewer') {
      console.warn(
        `[persistence] Blocked write from viewer userId=${ctx.userId ?? 'unknown'} doc=${data.documentName}`,
      )
      return
    }

    const update = Y.encodeStateAsUpdate(data.document)

    // Wrap the insert in try/catch so a transient DB error (network blip,
    // pool exhaustion, deadlock) doesn't propagate up to Hocuspocus and
    // tear down the WebSocket connection — clients then have to reconnect
    // and lose the in-flight transaction. We log loudly so failures are
    // visible; future TODO is to push the update to a DLQ for replay.
    try {
      if (target.kind === 'folder') {
        await this.db.insert(folderUpdates).values({
          folderId: target.id,
          update,
        })
        console.log(
          `[persistence] Stored update for folder=${target.id} (${update.byteLength} bytes)`,
        )
        return
      }

      if (target.kind === 'component') {
        await this.db.insert(componentUpdates).values({
          componentId: target.id,
          update,
        })
        console.log(
          `[persistence] Stored update for component=${target.id} (${update.byteLength} bytes)`,
        )
        return
      }

      await this.db.insert(deckUpdates).values({
        deckId: target.id,
        update,
      })

      console.log(`[persistence] Stored update for deck=${target.id} (${update.byteLength} bytes)`)
    } catch (err) {
      // CRITICAL: a swallowed persistence error means the in-memory Y.Doc
      // diverges from the database. Hocuspocus retries onStoreDocument on
      // the next debounce window, so a transient DB error usually self-
      // heals. A persistent error is still data loss — surface it loudly.
      console.error(
        `[persistence] FAILED to store update for ${target.kind}=${target.id} (${update.byteLength} bytes):`,
        err,
      )
    }
  }
}
