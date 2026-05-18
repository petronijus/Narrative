/**
 * scripts/purgeComponentInstances.ts
 *
 * One-off cleanup: remove every SlideObject whose `type === 'componentInstance'`
 * from a deck's Y.Doc. These are legacy entries from the M16 "live component"
 * model — the schema (`packages/shared/src/slide.ts`) explicitly documents
 * them as no-ops the renderer ignores, but they still cause:
 *
 *   `[SceneGraph] No renderer for type: componentInstance`
 *
 * to spam the browser console every emission.
 *
 * Strategy:
 *   For each target deck:
 *     1. Read all deck_updates rows in order, apply to a fresh Y.Doc.
 *     2. Walk `slides[].objects` and remove every Y.Map with type==='componentInstance'.
 *     3. In a single transaction, replace the entire update log with one
 *        snapshot row containing `Y.encodeStateAsUpdate(doc)`. Compacting
 *        the log here is a freebie — the deck was already loaded so we
 *        have a canonical state in hand.
 *
 * IMPORTANT: Run with the dev server (Hocuspocus) STOPPED. Hocuspocus keeps
 * an in-memory Y.Doc per open deck and will overwrite our cleanup on the
 * next `onStoreDocument` debounce. The script aborts if it sees an active
 * connection to its target deck via the simple heuristic of refusing to
 * run when env says the server is up — actually, we just trust the caller
 * here: stop dev, run, restart.
 *
 * Usage:
 *   pnpm --filter @narrative/server db:purge-components               # all decks
 *   pnpm --filter @narrative/server db:purge-components <deck-id>     # single deck
 *   pnpm --filter @narrative/server db:purge-components <deck-id> --dry-run
 *
 * Idempotent: a deck with no componentInstance entries is left untouched
 * (no row rewrite, no log compaction — keeps history honest).
 */

import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import * as Y from 'yjs'
import * as schema from '../db/schema.js'

const { Pool } = pg

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const targetDeckId = args.find((a) => !a.startsWith('--')) ?? null

const postgresUrl =
  process.env['POSTGRES_URL'] ?? 'postgres://narrative:password@localhost:5432/narrative'

const pool = new Pool({ connectionString: postgresUrl })
const db = drizzle(pool, { schema })

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

interface DeckResult {
  deckId: string
  scannedSlides: number
  removed: number
  bytesBefore: number
  bytesAfter: number
  rewrittenRows: number
}

async function purgeDeck(deckId: string): Promise<DeckResult> {
  const rows = await db
    .select({ id: schema.deckUpdates.id, update: schema.deckUpdates.update })
    .from(schema.deckUpdates)
    .where(eq(schema.deckUpdates.deckId, deckId))
    .orderBy(schema.deckUpdates.id)

  const doc = new Y.Doc()
  let bytesBefore = 0
  for (const row of rows) {
    bytesBefore += row.update.byteLength
    Y.applyUpdate(doc, row.update)
  }

  const slides = doc.getArray<Y.Map<unknown>>('slides')
  let removed = 0

  doc.transact(() => {
    for (let s = 0; s < slides.length; s++) {
      const slide = slides.get(s)
      const objects = slide.get('objects') as Y.Array<Y.Map<unknown>> | undefined
      if (objects === undefined) continue

      // Delete from back to front so indices stay valid as we go.
      for (let i = objects.length - 1; i >= 0; i--) {
        const obj = objects.get(i)
        const type = obj.get('type')
        if (type === 'componentInstance') {
          objects.delete(i, 1)
          removed++
        }
      }
    }
  }, 'script:purgeComponentInstances')

  if (removed === 0 || dryRun) {
    return {
      deckId,
      scannedSlides: slides.length,
      removed,
      bytesBefore,
      bytesAfter: bytesBefore,
      rewrittenRows: rows.length,
    }
  }

  const snapshot = Y.encodeStateAsUpdate(doc)
  const bytesAfter = snapshot.byteLength

  await db.transaction(async (tx) => {
    await tx.delete(schema.deckUpdates).where(eq(schema.deckUpdates.deckId, deckId))
    await tx.insert(schema.deckUpdates).values({
      deckId,
      update: Buffer.from(snapshot),
    })
  })

  return {
    deckId,
    scannedSlides: slides.length,
    removed,
    bytesBefore,
    bytesAfter,
    rewrittenRows: rows.length,
  }
}

async function run(): Promise<void> {
  if (dryRun) {
    console.log('[purge-components] DRY RUN — no rows will be written.')
  }

  let deckIds: string[]
  if (targetDeckId !== null) {
    deckIds = [targetDeckId]
    console.log(`[purge-components] Target: deck=${targetDeckId}`)
  } else {
    const all = await db.select({ id: schema.decks.id }).from(schema.decks)
    deckIds = all.map((d) => d.id)
    console.log(`[purge-components] Target: all decks (${deckIds.length})`)
  }

  let totalRemoved = 0
  let touchedDecks = 0
  for (const id of deckIds) {
    try {
      const r = await purgeDeck(id)
      if (r.removed > 0) {
        touchedDecks++
        totalRemoved += r.removed
        const compaction =
          r.rewrittenRows > 1
            ? ` — compacted ${r.rewrittenRows} rows → 1 (${r.bytesBefore} → ${r.bytesAfter} bytes)`
            : ''
        console.log(
          `[purge-components]   ✓ ${r.deckId}: removed ${r.removed} componentInstance object(s) across ${r.scannedSlides} slide(s)${compaction}`,
        )
      } else {
        console.log(`[purge-components]   · ${r.deckId}: clean (${r.scannedSlides} slide(s))`)
      }
    } catch (err) {
      console.error(`[purge-components]   ✗ ${id}: ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log(
    `[purge-components] Done. ${touchedDecks} deck(s) touched, ${totalRemoved} object(s) removed${
      dryRun ? ' (dry run — no writes)' : ''
    }.`,
  )
}

run()
  .catch((err) => {
    console.error('[purge-components] Fatal:', err)
    process.exit(1)
  })
  .finally(() => pool.end())
