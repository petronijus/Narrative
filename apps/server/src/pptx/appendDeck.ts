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
 *   - Register the media (`registerDeckMedia`, shared with the import):
 *     every `media_assets` row committed, then every video's transcode
 *     enqueued.
 *   - Only then apply the slides to the live Y.Doc at `insertAt`.
 *
 * Why that order: the document write is the moment connected editors see the
 * slides, and they immediately ask for the assets those slides reference. A
 * row written after it is a window in which they render an asset the server
 * does not know about — and a crash inside that window leaves slides pointing
 * at nothing, for good. Rows first means the worst a crash can leave is rows
 * nothing points at, which is harmless (see the failure handling below).
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
import { deckUpdates } from '../db/schema.js'
import { getHocuspocusInstance } from '../hocuspocus/presence.js'
import { parsePptx, type ParsedPptx } from './parser.js'
import { buildDeckAppendUpdate } from './writer.js'
import type { WriteResult } from './writer.js'
import {
  discardDeckMedia,
  registerDeckMedia,
  uploadEmbeddedImagesAndPatchAssetIds,
  type ImportLogger,
  type StagedDeckMedia,
} from './importDeck.js'
import { hydrateSlideDoc } from '@narrative/slide-model'

/**
 * Standard result shape — kept in sync with `AppendPptxResult` on the client
 * side. Both upload paths surface this to the user.
 */
export interface AppendDeckResult {
  deckId: string
  /** Slides INSERTED, not the deck's new total. */
  appendedSlides: number
  /** Ids of the inserted slides, in file order. */
  slideIds: string[]
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
  /**
   * `documentTouched: false` — the deck is exactly as it was; retrying is
   * safe. `true` — the write started on the live document and failed part-way
   * or after it (Hocuspocus 2.15.3 runs the store hooks after the edit has
   * already been applied and broadcast, and rethrows their failure), so some
   * or all of the slides may be in the deck: retrying blindly can duplicate
   * them.
   */
  | { kind: 'writeFailed'; documentTouched: boolean }

/**
 * A parsed `.pptx` whose embedded media is stored in the bucket under the
 * target deck's namespace (and whose shapes point at the new asset ids),
 * but which is not registered and not written yet.
 */
export interface StagedPptxInsert {
  deckId: string
  ownerUserId: string
  parsed: ParsedPptx
  media: StagedDeckMedia
}

/**
 * Stage 1 of an insert: parse the bytes and store the embedded media under
 * the EXISTING deck's namespace — the deck's permission grants on
 * `mediaAssets.deckId` apply uniformly, and the deck's cascade delete and
 * bucket-prefix sweep reap them with the deck. Nothing is registered and the
 * document is not touched.
 */
export async function stagePptxInsert(args: {
  bytes: Buffer
  deckId: string
  ownerUserId: string
  log: ImportLogger
}): Promise<{ ok: true; staged: StagedPptxInsert } | { ok: false; error: AppendDeckError }> {
  const { bytes, deckId, ownerUserId, log } = args
  if (bytes.byteLength === 0) {
    return { ok: false, error: { kind: 'emptyBody' } }
  }
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
  const media = await uploadEmbeddedImagesAndPatchAssetIds(parsed, deckId, ownerUserId, log)
  return { ok: true, staged: { deckId, ownerUserId, parsed, media } }
}

/**
 * Stage 2 of an insert: write the staged slides into `doc` (the live deck
 * document, or a detached replay) at `insertAt`, synchronously. Register the
 * staged media BEFORE calling this (see the module header for why). Returns
 * the writer's result and where the first slide actually landed.
 */
export function writeStagedPptx(
  staged: StagedPptxInsert,
  doc: Y.Doc,
  insertAt: number | undefined,
): { written: WriteResult; insertedAt: number } {
  const insertedAt = resolveInsertedAt(doc, insertAt)
  const written = buildDeckAppendUpdate(staged.parsed, doc, insertAt)
  return { written, insertedAt }
}

/** The route / tus result for a finished insert. */
export function appendResultOf(
  staged: StagedPptxInsert,
  written: WriteResult,
  insertedAt: number,
): AppendDeckResult {
  const { parsed, media, deckId } = staged
  return {
    deckId,
    appendedSlides: written.slideCount,
    slideIds: written.slideIds,
    objectsCreated: written.objectsCreated,
    skipped: {
      images: written.skipped.images + media.skippedUnsupportedImages,
      unknownShapes: written.skipped.unknownShapes,
    },
    ignoredElements: parsed.ignoredElements,
    slideWidth: parsed.slideWidth,
    slideHeight: parsed.slideHeight,
    insertedAt,
  }
}

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

  // ─── Parse + upload images + patch assetIds ─────────────────────────────
  const stagedResult = await stagePptxInsert({ bytes, deckId, ownerUserId, log })
  if (!stagedResult.ok) return stagedResult
  const staged = stagedResult.staged
  const { media } = staged

  const hocuspocus = getHocuspocusInstance()
  let written: WriteResult | null = null
  let insertedAt = insertAt ?? -1

  if (hocuspocus !== null) {
    // ─── 1. Register the media: rows committed, transcodes enqueued ────────
    try {
      await registerDeckMedia({ db, deckId, ownerUserId, media, log })
    } catch (err) {
      // The transaction rolled back, so no row exists and nothing has
      // touched the document: the uploaded bytes are all that is left.
      log.warn({ err, deckId }, 'pptx-append: registering media failed, deck left untouched')
      await discardDeckMedia({ db, deckId, media, log })
      return { ok: false, error: { kind: 'writeFailed', documentTouched: false } }
    }

    // ─── 2. Write into the LIVE document ─────────────────────────────────
    // Set as the callback's first statement: until then the document is
    // provably unchanged, after it nothing is provable (the store hooks can
    // still reject after the write was applied and broadcast). The write is
    // ONE Yjs transaction, so editors receive the inserted slides as one
    // update instead of a burst of partial states.
    let documentTouched = false
    try {
      const connection = await hocuspocus.openDirectConnection(deckId)
      try {
        await connection.transact((doc) => {
          documentTouched = true
          doc.transact(() => {
            const out = writeStagedPptx(staged, doc, insertAt)
            insertedAt = out.insertedAt
            written = out.written
          })
        })
      } finally {
        await connection.disconnect()
      }
    } catch (err) {
      log.warn({ err, deckId, documentTouched }, 'pptx-append: live document write failed')
      // The rows registered in step 1 are now orphans or, if the document
      // took any of the slides, live references — and which one cannot be
      // told from here. Untouched: nothing can reference them, so they go.
      // Touched: they stay, because deleting a row a rendered slide points
      // at is the broken-asset bug this ordering exists to prevent, while an
      // unreferenced deck-scoped row is inert (nothing renders an asset its
      // document does not name) and dies with the deck (ON DELETE CASCADE +
      // the `decks/<deckId>/` prefix sweep).
      if (!documentTouched) await discardDeckMedia({ db, deckId, media, log })
      return { ok: false, error: { kind: 'writeFailed', documentTouched } }
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
    const out = writeStagedPptx(staged, doc, insertAt)
    insertedAt = out.insertedAt
    const detached = out.written
    written = detached
    // Rows and the document update commit together here, so there is no
    // ordering window at all; transcodes follow the commit as always.
    try {
      await registerDeckMedia({
        db,
        deckId,
        ownerUserId,
        media,
        log,
        alongside: async (tx) => {
          await tx.insert(deckUpdates).values({
            deckId,
            update: detached.state,
            createdAt: new Date(),
          })
        },
      })
    } catch (err) {
      log.warn({ err, deckId }, 'pptx-append: detached write failed, deck left untouched')
      await discardDeckMedia({ db, deckId, media, log })
      return { ok: false, error: { kind: 'writeFailed', documentTouched: false } }
    }
  }

  if (written === null) {
    // Unreachable in practice — `transact` resolving means its callback ran.
    // If it ever is reached, the callback did not run, so the document is
    // untouched while the media is registered: discard it like any other
    // untouched failure.
    log.warn({ deckId }, 'pptx-append: insert produced no result')
    await discardDeckMedia({ db, deckId, media, log })
    return { ok: false, error: { kind: 'writeFailed', documentTouched: false } }
  }
  const result = appendResultOf(staged, written as WriteResult, insertedAt)

  log.info(
    {
      deckId,
      appendedSlides: result.appendedSlides,
      insertedAt,
      objectsCreated: result.objectsCreated,
      skippedImages: result.skipped.images,
      skippedUnknown: result.skipped.unknownShapes,
      uploadedImages: media.uploadedImageCount,
      ignored: staged.parsed.ignoredElements,
    },
    'pptx-append: slides inserted',
  )

  return { ok: true, result }
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
