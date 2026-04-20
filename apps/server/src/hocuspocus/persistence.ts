/**
 * hocuspocus/persistence.ts
 *
 * Custom Hocuspocus Extension pro Postgres persistence.
 * Implementuje onLoadDocument a onStoreDocument hooks.
 *
 * Strategy (M4 — append-only):
 *   onLoadDocument: načte všechny update rows pro deck, aplikuje sekvenčně
 *   onStoreDocument: uloží Y.encodeStateAsUpdate() jako nový row
 *
 * Hocuspocus volá onStoreDocument debounced (default 2s po posledním onChange),
 * takže při aktivní editaci neukladáme po každém znaku.
 *
 * TODO(M29): kompakce — po N updatech sloučit do jednoho snapshot row
 *            (loadDocument je teď O(N) updates, pro tisíce updates zpomalí)
 */

import type { Extension, onLoadDocumentPayload, onStoreDocumentPayload } from '@hocuspocus/server'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { deckUpdates } from '../db/schema.js'

export class PostgresPersistence implements Extension {
  private readonly db: Database

  constructor(opts: { db: Database }) {
    this.db = opts.db
  }

  async onLoadDocument(data: onLoadDocumentPayload): Promise<Y.Doc | void> {
    const deckId = data.documentName

    const rows = await this.db
      .select({ update: deckUpdates.update })
      .from(deckUpdates)
      .where(eq(deckUpdates.deckId, deckId))
      .orderBy(deckUpdates.id)

    if (rows.length === 0) {
      // Prázdný deck — vrátíme void, Hocuspocus použije fresh Y.Doc
      return
    }

    const doc = data.document
    for (const row of rows) {
      Y.applyUpdate(doc, row.update)
    }

    console.log(`[persistence] Loaded ${rows.length} updates for deck=${deckId}`)
    return doc
  }

  async onStoreDocument(data: onStoreDocumentPayload): Promise<void> {
    const deckId = data.documentName
    const ctx = data.context as { role?: string; userId?: string } | undefined

    // Defense-in-depth: skip persistence for viewer connections.
    // Primary enforcement is `readOnly: true` returned from onAuthenticate,
    // which prevents Hocuspocus from accepting update messages at protocol level.
    // This guard handles any edge-cases (e.g. server-side writes accidentally routed
    // through a viewer-context document).
    if (ctx?.role === 'viewer') {
      console.warn(
        `[persistence] Blocked write from viewer userId=${ctx.userId ?? 'unknown'} deck=${deckId}`,
      )
      return
    }

    const update = Y.encodeStateAsUpdate(data.document)

    await this.db.insert(deckUpdates).values({
      deckId,
      update,
    })

    console.log(`[persistence] Stored update for deck=${deckId} (${update.byteLength} bytes)`)
  }
}
