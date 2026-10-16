/**
 * services/pptx.ts — server implementation of `PptxService`
 * (packages/commands/src/services/pptx.ts).
 *
 *   - `importPptx`: POST /folders/:id/import-pptx and `deck.importPptx`
 *     (pptx/importDeck.ts, which the tus .pptx path runs too).
 *   - `prepareInsert` + `appendPptx`: POST /decks/:id/append-pptx and
 *     `deck.insertFrom` share pptx/appendDeck.ts's staging and writer; a deck
 *     source goes through services/deckInsert.ts.
 *   - `exportPptx` / `exportBytes`: GET /decks/:id/export.pptx and
 *     `deck.exportPptx` share pptx/exportDeck.ts, which reads the LIVE deck.
 *
 * Export delivery for agents. `url` (the default): the package is stored
 * under the deck's own prefix (`decks/<id>/exports/…`, so it is reaped with
 * the deck) and handed out as a presigned GET that expires after 15 minutes
 * and downloads with the deck's name — a tool result stays a few hundred
 * bytes however large the deck, and the model can pass the link to the
 * user or to a download tool. Exports older than an hour are swept on the
 * next export of the same deck. `base64` returns the bytes inline for
 * clients that cannot fetch a URL, capped at 8 MiB (about 11 MB of base64 —
 * larger payloads would swamp a model's context and the transports).
 */

import { nanoid } from 'nanoid'
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3'
import type {
  BinarySource,
  ImportPptxResult,
  PptxExportResult,
  PptxService,
  PreparedSlideInsert,
  SlideInsertResult,
  SlideInsertSource,
} from '@narrative/commands'
import { importDeckFromPptxBytes } from '../pptx/importDeck.js'
import {
  appendPptxToDeck,
  stagePptxInsert,
  writeStagedPptx,
  type AppendDeckError,
  type AppendDeckResult,
} from '../pptx/appendDeck.js'
import { discardDeckMedia, registerDeckMedia } from '../pptx/importDeck.js'
import { attachmentDisposition, exportDeckToPptx, PPTX_CONTENT_TYPE } from '../pptx/exportDeck.js'
import { buildS3Client, MEDIA_BUCKET, presignGetUrl } from '../media/s3Client.js'
import { MAX_PPTX_UPLOAD_SIZE } from '../media/uploadPolicy.js'
import type { ServiceDeps } from './deps.js'
import { badRequest, failed, forbidden, notFound, tooLarge, type ServiceError } from './errors.js'
import { LARGE_DOWNLOAD_TIMEOUT_MS, resolveBinarySource } from './binarySource.js'
import { requireFolderRole } from './shared.js'
import { stageDeckInsert } from './deckInsert.js'
import { SERVER_EDIT_ORIGIN, writeLiveDoc } from './liveDocs.js'

/** Largest .pptx accepted through an upload route (the tus / route limit). */
export const MAX_PPTX_BYTES = Number(process.env['MAX_PPTX_BYTES'] ?? MAX_PPTX_UPLOAD_SIZE)
/**
 * Largest .pptx the server fetches from a URL or decodes from base64 on a
 * caller's behalf (`deck.importPptx`, `deck.insertFrom`). Far below the
 * upload limit: the parser needs the whole package in memory, and a URL
 * download is the server's cost rather than a resumable upload the client
 * pays for. Larger decks go through the tus upload in the browser.
 */
export const MAX_REMOTE_PPTX_BYTES = Math.min(MAX_PPTX_BYTES, 200_000_000)
/** Largest export returned inline as base64. */
export const MAX_INLINE_EXPORT_BYTES = 8 * 1024 * 1024
/** Lifetime of an export download link. */
export const EXPORT_URL_TTL_SEC = 15 * 60
/** Exports older than this are deleted by the next export of the same deck. */
const EXPORT_RETENTION_MS = 60 * 60 * 1000

/** A .pptx failure as the routes answer it. */
function appendFailure(error: AppendDeckError): ServiceError {
  if (error.kind === 'parseFailed') return badRequest(`Could not parse .pptx — ${error.message}`)
  if (error.kind === 'noSlides') return badRequest('.pptx contains no slides')
  if (error.kind === 'emptyBody') return badRequest('Empty body')
  return failed(
    error.documentTouched
      ? 'Append failed part-way — some slides may already be in the deck; check it before retrying'
      : 'Append failed — no slides were written',
  )
}

/** The server's PptxService, plus what only the HTTP routes use. */
export interface ServerPptxService extends PptxService {
  /** POST /decks/:id/append-pptx: stage and write into the live deck in one go. */
  appendPptx(args: {
    userId: string
    deckId: string
    bytes: Buffer
    insertAt?: number | undefined
  }): Promise<AppendDeckResult>
  /**
   * POST /decks/:id/insert-slides: copy chosen slides of another deck into
   * the live deck at `at` — `deck.insertFrom`'s deck source (access check,
   * media copy, token rebinding, link rewriting), written in one go by a
   * person pasting slides in the editor.
   */
  insertSlidesFromDeck(args: {
    userId: string
    deckId: string
    sourceDeckId: string
    slideIds: readonly string[]
    at?: number | undefined
  }): Promise<SlideInsertResult>
  /** GET /decks/:id/export.pptx: the package bytes. */
  exportBytes(args: {
    deckId: string
  }): Promise<{ buffer: Buffer; filename: string; slideCount: number }>
}

export function createPptxService(deps: ServiceDeps): ServerPptxService {
  const { db, log } = deps

  async function importPptx(args: {
    userId: string
    folderId: string
    source: BinarySource
    title?: string | undefined
  }): Promise<ImportPptxResult> {
    // The folder role first: nothing is downloaded for someone who may not
    // add decks there (importDeckFromPptxBytes checks it again with the bytes).
    await requireFolderRole(db, args.folderId, args.userId, 'editor', { bypass: deps.bypass })
    const file = await resolveBinarySource(args.source, {
      userId: args.userId,
      maxBytes: MAX_PPTX_BYTES,
      maxRemoteBytes: MAX_REMOTE_PPTX_BYTES,
      what: 'The .pptx file',
      timeoutMs: LARGE_DOWNLOAD_TIMEOUT_MS,
    })
    const titleSource = args.title ?? file.filename
    const outcome = await importDeckFromPptxBytes({
      bytes: file.bytes,
      folderId: args.folderId,
      ownerUserId: args.userId,
      ...(titleSource !== undefined ? { filenameForTitle: titleSource } : {}),
      db,
      log,
    })
    if (outcome.ok) return outcome.result
    const { error } = outcome
    if (error.kind === 'folderNotFound') throw notFound('Folder not found')
    if (error.kind === 'forbidden') throw forbidden()
    if (error.kind === 'parseFailed') throw badRequest(`Could not parse .pptx — ${error.message}`)
    if (error.kind === 'noSlides') throw badRequest('.pptx contains no slides')
    if (error.kind === 'emptyBody') throw badRequest('Empty body')
    throw failed('Failed to create deck')
  }

  async function preparePptxInsert(
    userId: string,
    deckId: string,
    source: BinarySource,
  ): Promise<PreparedSlideInsert> {
    const file = await resolveBinarySource(source, {
      userId,
      maxBytes: MAX_PPTX_BYTES,
      maxRemoteBytes: MAX_REMOTE_PPTX_BYTES,
      what: 'The .pptx file',
      timeoutMs: LARGE_DOWNLOAD_TIMEOUT_MS,
    })
    const staged = await stagePptxInsert({ bytes: file.bytes, deckId, ownerUserId: userId, log })
    if (!staged.ok) throw appendFailure(staged.error)
    const { media } = staged.staged
    // Rows committed and transcodes enqueued BEFORE the document write (the
    // order pptx/appendDeck.ts documents): editors that see the slides can
    // fetch their assets at once.
    try {
      await registerDeckMedia({ db, deckId, ownerUserId: userId, media, log })
    } catch (err) {
      log.warn({ err, deckId }, 'deck.insertFrom: registering media failed, deck left untouched')
      await discardDeckMedia({ db, deckId, media, log })
      throw failed('Insert failed — no slides were written')
    }
    let settled = false
    return {
      slideCount: staged.staged.parsed.slides.length,
      apply(deck, at) {
        if (settled) throw new Error('pptx insert: already applied or discarded')
        settled = true
        const { written, insertedAt } = writeStagedPptx(staged.staged, deck.doc, at)
        return {
          slideIds: written.slideIds,
          insertedAt,
          objectsCreated: written.objectsCreated,
          mediaRegistered: media.mediaAssetRows.length,
          skipped: {
            images: written.skipped.images + media.skippedUnsupportedImages,
            unknownShapes: written.skipped.unknownShapes,
          },
          ignoredElements: staged.staged.parsed.ignoredElements,
          ...(written.placeholders.length > 0 ? { placeholders: written.placeholders } : {}),
        }
      },
      async discard() {
        if (settled) return
        settled = true
        await discardDeckMedia({ db, deckId, media, log })
      },
      // A .pptx brings only media of its own, registered for this deck: nothing linked to carry.
      async settle() {},
    }
  }

  async function prepareInsert(args: {
    userId: string
    deckId: string
    source: SlideInsertSource
  }): Promise<PreparedSlideInsert> {
    if (args.source.kind === 'pptx') {
      return preparePptxInsert(args.userId, args.deckId, args.source.file)
    }
    return stageDeckInsert(deps, {
      userId: args.userId,
      sourceDeckId: args.source.deckId,
      targetDeckId: args.deckId,
      range: args.source.range,
      slideIds: args.source.slideIds,
    })
  }

  async function appendPptx(args: {
    userId: string
    deckId: string
    bytes: Buffer
    insertAt?: number | undefined
  }): Promise<AppendDeckResult> {
    if (args.bytes.byteLength === 0) throw badRequest('Empty body')
    if (args.bytes.byteLength > MAX_PPTX_BYTES) {
      throw tooLarge(`File too large (${args.bytes.byteLength} > ${MAX_PPTX_BYTES} bytes)`)
    }
    const outcome = await appendPptxToDeck({
      bytes: args.bytes,
      deckId: args.deckId,
      ownerUserId: args.userId,
      ...(args.insertAt !== undefined ? { insertAt: args.insertAt } : {}),
      db,
      log,
    })
    if (!outcome.ok) throw appendFailure(outcome.error)
    return outcome.result
  }

  async function insertSlidesFromDeck(args: {
    userId: string
    deckId: string
    sourceDeckId: string
    slideIds: readonly string[]
    at?: number | undefined
  }): Promise<SlideInsertResult> {
    const prepared = await stageDeckInsert(deps, {
      userId: args.userId,
      sourceDeckId: args.sourceDeckId,
      targetDeckId: args.deckId,
      slideIds: args.slideIds,
    })
    const touched = { value: false }
    let result: SlideInsertResult
    try {
      result = await writeLiveDoc(
        deps,
        'deck',
        args.deckId,
        (doc) => prepared.apply({ doc, slides: doc.getArray('slides') }, args.at),
        SERVER_EDIT_ORIGIN,
        touched,
      )
    } catch (err) {
      // Untouched: nothing references the staged media, so it goes. Touched:
      // the rows stay (a slide may already point at them; see appendDeck.ts).
      if (!touched.value) await prepared.discard()
      throw err
    }
    // Written: what the slides link follows a deck that changed folders meanwhile.
    await prepared.settle()
    return result
  }

  async function exportBytes(args: { deckId: string }) {
    const outcome = await exportDeckToPptx(deps, args.deckId)
    if (outcome.ok) return outcome
    if (outcome.error === 'deckNotFound') throw notFound('Deck not found')
    if (outcome.error === 'noSlides') throw badRequest('Deck has no slides to export')
    throw failed('Failed to build .pptx')
  }

  /** Best effort: delete this deck's exports older than the retention window. */
  async function sweepOldExports(deckId: string): Promise<void> {
    const s3 = buildS3Client()
    const cutoff = Date.now() - EXPORT_RETENTION_MS
    try {
      let token: string | undefined
      do {
        const page = await s3.send(
          new ListObjectsV2Command({
            Bucket: MEDIA_BUCKET,
            Prefix: `decks/${deckId}/exports/`,
            ContinuationToken: token,
          }),
        )
        const stale: ObjectIdentifier[] = (page.Contents ?? [])
          .filter((o) => o.Key !== undefined && (o.LastModified?.getTime() ?? 0) < cutoff)
          .map((o) => ({ Key: o.Key! }))
        if (stale.length > 0) {
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: MEDIA_BUCKET,
              Delete: { Objects: stale, Quiet: true },
            }),
          )
        }
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined
      } while (token !== undefined)
    } catch (err) {
      log.warn({ err, deckId }, 'pptx-export: sweeping old exports failed')
    }
  }

  async function exportPptx(args: {
    userId: string
    deckId: string
    delivery: 'url' | 'base64'
  }): Promise<PptxExportResult> {
    const { buffer, filename, slideCount } = await exportBytes({ deckId: args.deckId })
    if (args.delivery === 'base64') {
      if (buffer.byteLength > MAX_INLINE_EXPORT_BYTES) {
        throw tooLarge(
          `The export is ${buffer.byteLength} bytes, over the ${MAX_INLINE_EXPORT_BYTES}-byte inline limit; ` +
            'use delivery "url"',
        )
      }
      return {
        delivery: 'base64',
        filename,
        sizeBytes: buffer.byteLength,
        slideCount,
        base64: buffer.toString('base64'),
      }
    }
    const key = `decks/${args.deckId}/exports/${nanoid(16)}/deck.pptx`
    await buildS3Client().send(
      new PutObjectCommand({
        Bucket: MEDIA_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: PPTX_CONTENT_TYPE,
        ContentDisposition: attachmentDisposition(filename, 'ascii'),
        CacheControl: 'private, no-store',
      }),
    )
    void sweepOldExports(args.deckId)
    const expiresAt = new Date(Date.now() + EXPORT_URL_TTL_SEC * 1000)
    return {
      delivery: 'url',
      filename,
      sizeBytes: buffer.byteLength,
      slideCount,
      url: await presignGetUrl(key, EXPORT_URL_TTL_SEC),
      expiresAt: expiresAt.toISOString(),
    }
  }

  return { importPptx, prepareInsert, exportPptx, appendPptx, insertSlidesFromDeck, exportBytes }
}
