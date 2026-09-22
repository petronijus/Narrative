/**
 * pptx/appendDeck.ts
 *
 * Shared "insert a `.pptx` Buffer into an EXISTING deck" pipeline — the
 * sibling of `importDeck.ts`, which creates a new deck instead. Extracted
 * for the same reason: two upload paths have to converge on one
 * implementation.
 *   1. `POST /decks/:id/append-pptx` — synchronous buffered POST (the
 *      original M28 endpoint, kept for API callers and route-level tests).
 *   2. tus-based chunked upload — what the editor uses, because only tus
 *      reports upload progress and survives a dropped connection.
 *
 * Steps:
 *   - Parse pptx via `parsePptx`.
 *   - Upload every embedded image / video to MinIO under the EXISTING
 *     deck's namespace, patching the parsed shapes' `assetId` fields.
 *   - Apply the slides to the live Y.Doc at `insertAt`.
 *
 * Why the live document and not a `deck_updates` row: Hocuspocus holds the
 * deck in memory and its persistence writes a full snapshot and then deletes
 * every older row for that document, so a row written underneath it is both
 * invisible to everyone connected and deleted outright by the next store.
 * That was the "I uploaded it as append and nothing happened" bug (882d67c).
 * `openDirectConnection` makes the insert an ordinary edit of the live
 * document: connected editors get it over the wire at once and it persists by
 * the same path as every other change.
 *
 * Callers pass their own logger so the tus path can use the app logger while
 * the route path uses `request.log`.
 */

import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { deckUpdates, mediaAssets } from '../db/schema.js'
import { getHocuspocusInstance } from '../hocuspocus/presence.js'
import { parsePptx, type ParsedPptx } from './parser.js'
import { buildDeckAppendUpdate } from './writer.js'
import type { WriteResult } from './writer.js'
import { uploadEmbeddedImagesAndPatchAssetIds, type ImportLogger } from './importDeck.js'
import { hydrateSlideDoc } from '@narrative/slide-model'

/**
 * Standard result shape — kept in sync with `AppendPptxResult` on the client
 * side. Both upload paths surface this to the user.
 */
export interface AppendDeckResult {
  deckId: string
  /** Slides INSERTED, not the deck's new total. */
  appendedSlides: number
  objectsCreated: number
  skipped: { images: number; unknownShapes: number }
  ignoredElements: string[]
  slideWidth: number
  slideHeight: number
  /** Where the first imported slide landed, after clamping. Lets the client
   *  put the caret / active slide on what it just imported rather than
   *  guessing, which it would get wrong whenever the index was clamped. */
  insertedAt: number
}

/**
 * Failure outcome — a discriminated union so each caller maps the kind to
 * its own transport's error shape (HTTP status for the route, a tus body
 * string for the upload hook).
 */
export type AppendDeckError =
  | { kind: 'emptyBody' }
  | { kind: 'parseFailed'; message: string }
  | { kind: 'noSlides' }
  | { kind: 'writeFailed' }

/**
 * Run the full "buffer → slides in an open deck" pipeline. Pure server side;
 * no HTTP primitives. The caller has already established that this user may
 * edit this deck.
 *
 * `insertAt` is the index the first imported slide takes, in the deck's
 * pre-insert array; omitted means append. Out-of-range values are clamped by
 * the writer rather than rejected — by the time a chunked upload finishes,
 * the deck may legitimately have fewer slides than when the drop happened,
 * and throwing away a parsed deck over a stale index would be the wrong
 * answer to a race the user cannot even see.
 */
export async function appendPptxToDeck(args: {
  bytes: Buffer
  deckId: string
  ownerUserId: string
  insertAt?: number
  db: Database
  log: ImportLogger
}): Promise<{ ok: true; result: AppendDeckResult } | { ok: false; error: AppendDeckError }> {
  const { bytes, deckId, ownerUserId, insertAt, db, log } = args

  if (bytes.byteLength === 0) {
    return { ok: false, error: { kind: 'emptyBody' } }
  }

  // ─── Parse ───────────────────────────────────────────────────────────────
  let parsed: ParsedPptx
  try {
    parsed = await parsePptx(bytes)
  } catch (err) {
    log.warn({ err, deckId }, 'pptx-append: parse failed')
    return {
      ok: false,
      error: {
        kind: 'parseFailed',
        message: err instanceof Error ? err.message : 'unknown error',
      },
    }
  }
  if (parsed.slides.length === 0) {
    return { ok: false, error: { kind: 'noSlides' } }
  }

  // ─── Upload images + patch assetIds ──────────────────────────────────────
  // Images for inserted slides land under the SAME deckId namespace as the
  // existing deck's media — that matters because the deck's permission
  // grants on `mediaAssets.deckId` apply uniformly.
  const { mediaAssetRows, uploadedImageCount, skippedUnsupportedImages } =
    await uploadEmbeddedImagesAndPatchAssetIds(parsed, deckId, ownerUserId, log)

  // ─── Write into the LIVE document ────────────────────────────────────────
  const hocuspocus = getHocuspocusInstance()
  let written: WriteResult | null = null
  let insertedAt = insertAt ?? -1

  if (hocuspocus !== null) {
    const connection = await hocuspocus.openDirectConnection(deckId)
    try {
      await connection.transact((doc) => {
        insertedAt = resolveInsertedAt(doc, insertAt)
        written = buildDeckAppendUpdate(parsed, doc, insertAt)
      })
    } finally {
      await connection.disconnect()
    }
    if (mediaAssetRows.length > 0) {
      await db.insert(mediaAssets).values(mediaAssetRows)
    }
  } else {
    // No sync server in this process (route-only unit tests). Fall back to
    // the detached replay + insert; nothing is holding the document, so there
    // is no snapshot to be compacted against.
    const updates = await db
      .select({ update: deckUpdates.update })
      .from(deckUpdates)
      .where(eq(deckUpdates.deckId, deckId))
      .orderBy(deckUpdates.id)
    const doc = new Y.Doc()
    for (const row of updates) {
      try {
        Y.applyUpdate(doc, row.update)
      } catch (err) {
        log.warn({ err, deckId }, 'pptx-append: skipping corrupt deck_updates row')
      }
    }
    insertedAt = resolveInsertedAt(doc, insertAt)
    written = buildDeckAppendUpdate(parsed, doc, insertAt)
    await db.transaction(async (tx) => {
      if (mediaAssetRows.length > 0) {
        await tx.insert(mediaAssets).values(mediaAssetRows)
      }
      await tx.insert(deckUpdates).values({
        deckId,
        update: written!.state,
        createdAt: new Date(),
      })
    })
  }

  if (written === null) {
    log.warn({ deckId }, 'pptx-append: insert produced no result')
    return { ok: false, error: { kind: 'writeFailed' } }
  }
  const { slideCount, objectsCreated, skipped } = written as WriteResult

  log.info(
    {
      deckId,
      appendedSlides: slideCount,
      insertedAt,
      objectsCreated,
      skippedImages: skipped.images + skippedUnsupportedImages,
      skippedUnknown: skipped.unknownShapes,
      uploadedImages: uploadedImageCount,
      ignored: parsed.ignoredElements,
    },
    'pptx-append: slides inserted',
  )

  return {
    ok: true,
    result: {
      deckId,
      appendedSlides: slideCount,
      objectsCreated,
      skipped: {
        images: skipped.images + skippedUnsupportedImages,
        unknownShapes: skipped.unknownShapes,
      },
      ignoredElements: parsed.ignoredElements,
      slideWidth: parsed.slideWidth,
      slideHeight: parsed.slideHeight,
      insertedAt,
    },
  }
}

/**
 * The index the first imported slide will actually occupy, clamped the same
 * way the writer clamps it. Read before the insert, off the same document the
 * insert runs against, so a stale or out-of-range request reports where the
 * slides really went rather than where they were asked to go.
 */
function resolveInsertedAt(doc: Y.Doc, insertAt: number | undefined): number {
  // Through `hydrateSlideDoc` rather than `getArray('slides')` so a deck
  // still in the legacy single-slide shape is counted after its migration,
  // the same one the writer is about to trigger — not as an empty deck.
  const existingCount = hydrateSlideDoc(doc).slides.length
  if (insertAt === undefined) return existingCount
  return Math.max(0, Math.min(Math.trunc(insertAt), existingCount))
}
