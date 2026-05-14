/**
 * routes/pptxExport.ts
 *
 * Synchronous deck → `.pptx` download.
 *
 * Endpoint:
 *   GET /decks/:id/export.pptx
 *     Auth: editor+ role on the deck.
 *     Response: `application/vnd.openxmlformats-officedocument.presentationml.presentation`
 *               body = the .pptx bytes (no JSON wrapper).
 *
 * Implementation:
 *   1. Replay every `deck_updates` row into a fresh Y.Doc (same code path
 *      Hocuspocus uses on connect, just inline here).
 *   2. Hydrate the slide-model handles, list slides as plain snapshots.
 *   3. Hand the slide list to `exportDeckToPptx` (pure / no I/O).
 *   4. Stream the resulting Buffer back with a Content-Disposition that
 *      uses the deck title for the filename.
 *
 * Latency-wise the bottleneck is pptxgenjs's `.write()` which is ~1-2 s for
 * a 30-slide deck. Acceptable for an interactive download; will need a
 * worker if we ever batch-export entire folders.
 */

import type { FastifyInstance } from 'fastify'
import type { Readable } from 'node:stream'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { hydrateSlideDoc, listSlides, getSlideNotes } from '@narrative/slide-model'
import type { Database } from '../db/client.js'
import { decks, deckUpdates, mediaAssets } from '../db/schema.js'
import { authPreHandler, requireDeckRole } from '../auth/fastifyAuth.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { exportDeckToPptx, type AssetLoader } from '../pptx/export.js'

export async function registerPptxExportRoutes(app: FastifyInstance, db: Database): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/decks/:id/export.pptx',
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
    async (request, reply) => {
      const { id } = request.params

      // ─── Load deck row for title + sanity check ──────────────────────────
      const [deck] = await db
        .select({ id: decks.id, title: decks.title })
        .from(decks)
        .where(eq(decks.id, id))
        .limit(1)
      if (!deck) {
        return reply.status(404).send({ error: 'Deck not found' })
      }

      // ─── Replay deck_updates → Y.Doc ─────────────────────────────────────
      const updates = await db
        .select({ update: deckUpdates.update })
        .from(deckUpdates)
        .where(eq(deckUpdates.deckId, id))
        .orderBy(deckUpdates.id)
      const doc = new Y.Doc()
      for (const row of updates) {
        try {
          Y.applyUpdate(doc, row.update)
        } catch (err) {
          request.log.warn({ err, deckId: id }, 'pptx-export: skipping corrupt deck_updates row')
        }
      }

      // ─── Slides → snapshots → .pptx ──────────────────────────────────────
      const handles = hydrateSlideDoc(doc)
      const slides = listSlides(handles)
      if (slides.length === 0) {
        return reply.status(400).send({ error: 'Deck has no slides to export' })
      }

      // ─── Asset loader for image objects + image backgrounds ──────────────
      // Memoised so repeated references (e.g. the same logo on every slide)
      // hit MinIO once. The pptxgenjs API is sync from our side, so we have
      // to read every byte into memory anyway.
      const assetCache = new Map<string, { bytes: Buffer; mimeType: string } | null>()
      const s3 = buildS3Client()
      const assetLoader: AssetLoader = async (assetId) => {
        if (assetCache.has(assetId)) return assetCache.get(assetId) ?? null
        const [row] = await db
          .select({ storageKey: mediaAssets.storageKey, mimeType: mediaAssets.mimeType })
          .from(mediaAssets)
          .where(eq(mediaAssets.id, assetId))
          .limit(1)
        if (!row) {
          assetCache.set(assetId, null)
          return null
        }
        try {
          const obj = await s3.send(
            new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: row.storageKey }),
          )
          if (obj.Body === undefined) {
            assetCache.set(assetId, null)
            return null
          }
          const bytes = await streamToBuffer(obj.Body as Readable)
          const result = { bytes, mimeType: row.mimeType }
          assetCache.set(assetId, result)
          return result
        } catch (err) {
          request.log.warn({ err, assetId }, 'pptx-export: failed to fetch asset bytes')
          assetCache.set(assetId, null)
          return null
        }
      }

      // ─── Speaker notes per slide ─────────────────────────────────────────
      // Walk each slide's ProseMirror-shaped notes Y.XmlFragment and flatten
      // to a plain string (one line per `<paragraph>` block). Empty notes
      // surface as an absent map entry so the exporter skips `addNotes`
      // entirely on slides without content.
      const notesBySlideId = new Map<string, string>()
      for (const slide of slides) {
        const fragment = getSlideNotes(handles, slide.id)
        if (fragment === null) continue
        const text = flattenNotesFragment(fragment)
        if (text.length > 0) notesBySlideId.set(slide.id, text)
      }

      let buffer: Buffer
      try {
        buffer = await exportDeckToPptx(slides, {
          title: deck.title,
          assetLoader,
          notesBySlideId,
        })
      } catch (err) {
        request.log.error({ err, deckId: id }, 'pptx-export: pptxgenjs write failed')
        return reply.status(500).send({ error: 'Failed to build .pptx' })
      }

      // ─── Send ────────────────────────────────────────────────────────────
      const filename = safeFilename(deck.title || 'deck') + '.pptx'
      return reply
        .status(200)
        .header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        )
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Content-Length', String(buffer.byteLength))
        .send(buffer)
    },
  )
}

/**
 * Walk a ProseMirror-shaped Y.XmlFragment and emit a plain-text string.
 * One `\n` between block children (paragraphs etc.), and consecutive
 * blank paragraphs collapse to a single blank line — same behaviour as
 * the editor's preview pane (`useSlideNotes.serialiseFragment`).
 */
function flattenNotesFragment(frag: Y.XmlFragment): string {
  const lines: string[] = []
  for (const child of frag.toArray() as Array<
    Y.XmlElement | Y.XmlText | Y.XmlHook | Y.XmlFragment
  >) {
    if (child instanceof Y.XmlElement) {
      lines.push(child.toString().replace(/<[^>]+>/g, ''))
    } else if (child instanceof Y.XmlText) {
      lines.push(child.toString())
    }
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Drain a Readable into a Buffer. AWS SDK v3 returns Body as a Readable
 *  stream — we need the full payload in memory to base64-embed it. */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks)
}

/**
 * Strip characters that are unsafe in `Content-Disposition: filename=` and in
 * common file systems. Keeps unicode letters/numbers/dashes/underscores —
 * just removes quotes, slashes, control bytes, and anything that would
 * confuse a `filename=` parser. Caps the result so we don't produce a
 * 4000-char download name from a maliciously long deck title.
 */
function safeFilename(title: string): string {
  const trimmed = title
    .replace(/[ -"'<>\\/|?*\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return trimmed.length === 0 ? 'deck' : trimmed.slice(0, 120)
}
