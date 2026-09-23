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
 *   2. Hydrate the slide-model handles, list slides as plain snapshots,
 *      resolve folder colour tokens to concrete colours.
 *   3. Hand the slides to `writeDeck` (pptx/ooxml/) — the OOXML writer that
 *      shares its units, vocabulary and element readers with the importer,
 *      so an exported deck imports back as the same model
 *      (pptx/roundtrip.test.ts) and every part is schema-valid
 *      (pptx/ooxml/validate.test.ts).
 *   4. Stream the resulting Buffer back with a Content-Disposition that
 *      uses the deck title for the filename.
 */

import type { FastifyInstance } from 'fastify'
import type { Readable } from 'node:stream'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import {
  hydrateSlideDoc,
  listSlides,
  getSlideNotes,
  resolveTokenValue,
  isTokenRef,
} from '@narrative/slide-model'
import type { Slide, SlideObject } from '@narrative/shared'
import type { FolderTokensSnapshot } from '@narrative/slide-model'
import type { Database } from '../db/client.js'
import { decks, deckUpdates, mediaAssets, folderUpdates } from '../db/schema.js'
import { authPreHandler, requireDeckRole } from '../auth/fastifyAuth.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { writeDeck, type AssetLoader } from '../pptx/ooxml/writeDeck.js'
import { notesFromFragment, type NotesDoc } from '../pptx/ooxml/notes.js'

export async function registerPptxExportRoutes(app: FastifyInstance, db: Database): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/decks/:id/export.pptx',
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
    async (request, reply) => {
      const { id } = request.params

      // ─── Load deck row for title + folder + sanity check ────────────────
      const [deck] = await db
        .select({ id: decks.id, title: decks.title, folderId: decks.folderId })
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
      const rawSlides = listSlides(handles)
      if (rawSlides.length === 0) {
        return reply.status(400).send({ error: 'Deck has no slides to export' })
      }

      // ─── Resolve folder color tokens to concrete hex values ─────────────
      // TokenRef references on objects (e.g. `color: { $token: 'colors.brand' }`)
      // arrive on the export side as plain JSON; resolve each via the deck's
      // folder Y.Doc tokens so the .pptx carries final colour numbers instead
      // of falling back to the exporter's grey default.
      const folderTokens = await loadFolderTokens(deck.folderId, db, request)
      const resolved =
        folderTokens === null
          ? rawSlides
          : rawSlides.map((s) => resolveSlideTokens(s, folderTokens))
      // A reference to a token the folder no longer has cannot be resolved;
      // it is written as a neutral grey, and counted.
      const unresolved = { count: 0 }
      const slides = resolved.map((s) => replaceUnresolvedTokens(s, unresolved))
      if (unresolved.count > 0) {
        request.log.warn(
          { deckId: id, count: unresolved.count },
          'pptx-export: unresolved colour tokens written as grey',
        )
      }

      // ─── Asset loader for image objects + image backgrounds ──────────────
      // Memoised so repeated references (e.g. the same logo on every slide)
      // hit MinIO once; the package is assembled in memory.
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
      // The notes editor's document, as it is (pptx/ooxml/notes.ts writes it
      // formatted and exact). A slide without notes has no entry, and no
      // notes page is written for it.
      const notesBySlideId = new Map<string, NotesDoc>()
      for (const slide of slides) {
        const fragment = getSlideNotes(handles, slide.id)
        if (fragment === null) continue
        const notes = notesFromFragment(fragment)
        if (notes.length > 0) notesBySlideId.set(slide.id, notes)
      }

      let buffer: Buffer
      try {
        buffer = await writeDeck(slides, {
          title: deck.title,
          assetLoader,
          notesBySlideId,
        })
      } catch (err) {
        request.log.error({ err, deckId: id }, 'pptx-export: writing the package failed')
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
 * Load a folder's tokens snapshot by replaying `folder_updates` rows.
 * Mirrors the Hocuspocus persistence path: same `folder:<id>` Y.Doc
 * shape, same `getMap('tokens')` walk. Returns null when the deck has
 * no folder (legacy decks) or the folder has no tokens persisted yet.
 *
 * The snapshot conforms to `FolderTokensSnapshot` from slide-model so
 * `resolveTokenValue` works directly.
 */
async function loadFolderTokens(
  folderId: string | null,
  db: Database,
  request: { log: { warn: (...args: unknown[]) => void } },
): Promise<FolderTokensSnapshot | null> {
  if (folderId === null) return null
  const rows = await db
    .select({ update: folderUpdates.update })
    .from(folderUpdates)
    .where(eq(folderUpdates.folderId, folderId))
    .orderBy(folderUpdates.id)
  if (rows.length === 0) return null

  const doc = new Y.Doc()
  for (const row of rows) {
    try {
      Y.applyUpdate(doc, row.update)
    } catch (err) {
      request.log.warn({ err, folderId }, 'pptx-export: skipping corrupt folder_updates row')
    }
  }

  const tokensMap = doc.getMap<unknown>('tokens')
  const out: FolderTokensSnapshot = { colors: {}, textStyles: {}, effectStyles: {} }

  // Each category is a Y.Map<tokenId, Y.Map<field, value>>. Walk and
  // unwrap to plain JSON.
  const categories: Array<keyof FolderTokensSnapshot> = ['colors', 'textStyles', 'effectStyles']
  for (const cat of categories) {
    const catMap = tokensMap.get(cat)
    if (!(catMap instanceof Y.Map)) continue
    for (const [tokenId, tokenY] of catMap as Y.Map<unknown>) {
      if (!(tokenY instanceof Y.Map)) continue
      const plain: Record<string, unknown> = {}
      for (const [k, v] of tokenY as Y.Map<unknown>) {
        plain[k] = v
      }
      ;(out[cat] as Record<string, unknown>)[tokenId] = plain
    }
  }
  return out
}

/**
 * Walk every object on a slide and replace TokenRef references with their
 * concrete colour values. Idempotent — concrete numbers pass through
 * unchanged. Resolution failure (unknown token id) leaves the ref in
 * place; `replaceUnresolvedTokens` then writes it as grey.
 *
 * Token refs can sit at arbitrary depth: top-level (`obj.color`,
 * `obj.fill`, `obj.stroke`), nested (`obj.shadow.color`,
 * `table.defaults.color`, `table.defaults.border.color`), inside
 * 2-D arrays (`table.rows[r][c].color`, `table.rows[r][c].border.top.color`),
 * or inside record-shaped maps (`table.borderSegments['h:0:1'].color`).
 * The walker descends through plain objects + arrays uniformly; Y.Text
 * cell bodies are not plain objects (they're Y.Text instances), so the
 * `Object.getPrototypeOf(v) === Object.prototype` guard skips them
 * naturally.
 */
export function resolveSlideTokens(slide: Slide, tokens: FolderTokensSnapshot): Slide {
  const objects = slide.objects.map((obj) => resolveTokensDeep(obj, tokens) as SlideObject)
  return { ...slide, objects }
}

/** Colour for a token reference that does not resolve: the writer takes concrete colours only. */
export const UNRESOLVED_TOKEN_COLOUR = 0x808080

/**
 * Replace every token reference still left after resolution (a token the
 * folder no longer has) with `UNRESOLVED_TOKEN_COLOUR`, counting them.
 */
export function replaceUnresolvedTokens(slide: Slide, counter: { count: number }): Slide {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      let touched = false
      const next = value.map((v) => {
        const r = walk(v)
        if (r !== v) touched = true
        return r
      })
      return touched ? next : value
    }
    if (!isPlainObject(value)) return value
    if (isTokenRef(value)) {
      counter.count++
      return UNRESOLVED_TOKEN_COLOUR
    }
    let touched = false
    const next: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const r = walk(value[key])
      next[key] = r
      if (r !== value[key]) touched = true
    }
    return touched ? next : value
  }
  return { ...slide, objects: slide.objects.map((o) => walk(o) as SlideObject) }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}

function resolveTokensDeep(value: unknown, tokens: FolderTokensSnapshot): unknown {
  if (Array.isArray(value)) {
    let touched = false
    const next: unknown[] = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      const resolved = resolveTokensDeep(value[i], tokens)
      next[i] = resolved
      if (resolved !== value[i]) touched = true
    }
    return touched ? next : value
  }
  if (!isPlainObject(value)) return value
  // TokenRef itself — resolve to a hex number when possible. Leave the ref
  // in place when the token id is unknown (see replaceUnresolvedTokens).
  if (isTokenRef(value)) {
    const resolved = resolveTokenValue(value, tokens)
    if (resolved !== null) {
      const hex = resolved.replace(/^#/, '')
      if (/^[0-9A-Fa-f]{6}$/.test(hex)) {
        return parseInt(hex, 16)
      }
    }
    return value
  }
  // Plain object — recurse into every value.
  let touched = false
  const next: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const orig = value[key]
    const resolved = resolveTokensDeep(orig, tokens)
    next[key] = resolved
    if (resolved !== orig) touched = true
  }
  return touched ? next : value
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
