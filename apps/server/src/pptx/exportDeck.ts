/**
 * pptx/exportDeck.ts
 *
 * Deck → `.pptx` bytes, shared by GET /decks/:id/export.pptx and the
 * `deck.exportPptx` command (through services/pptx.ts).
 *
 *   1. Read the deck's LIVE document (services/liveDocs.ts): what open
 *      editors see now. The stored snapshot is written on a debounce and can
 *      be up to 10 s behind, so an export right after an edit — by a person
 *      or an agent — used to miss it.
 *   2. List slides as plain snapshots and resolve folder token references to
 *      concrete colours with the folder's (live) tokens; a reference to a
 *      token the folder no longer has is written as a neutral grey.
 *   3. Media is embedded only when it belongs to this deck: a row of the
 *      deck itself, or a font of the deck's folder (`deckAssetScope`). An
 *      asset id pointing at another deck's media — pasted in by a
 *      collaborator or an agent — is skipped like a missing asset, so an
 *      export can never be used to read media the exporter has no access to.
 *   4. Hand the slides to `writeDeck` (pptx/ooxml/) — the OOXML writer that
 *      shares its units, vocabulary and element readers with the importer, so
 *      an exported deck imports back as the same model (pptx/roundtrip.test.ts)
 *      and every part is schema-valid (pptx/ooxml/validate.test.ts).
 */

import type { Readable } from 'node:stream'
import * as Y from 'yjs'
import { and, eq, or, type SQL } from 'drizzle-orm'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import {
  getSlideNotes,
  hydrateSlideDoc,
  isTokenRef,
  listSlides,
  resolveTokenValue,
  type FolderTokensSnapshot,
} from '@narrative/slide-model'
import type { Slide, SlideObject } from '@narrative/shared'
import { decks, mediaAssets } from '../db/schema.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { writeDeck, type AssetLoader } from './ooxml/writeDeck.js'
import { notesFromFragment, type NotesDoc } from './ooxml/notes.js'
import type { ServiceDeps } from '../services/deps.js'
import { readDocCopy } from '../services/liveDocs.js'
import { tokensSnapshot } from '../services/tokenRebind.js'

export const PPTX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'

export type PptxExportOutcome =
  | { ok: true; buffer: Buffer; filename: string; slideCount: number }
  | { ok: false; error: 'deckNotFound' | 'noSlides' | 'writeFailed' }

export async function exportDeckToPptx(
  deps: Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>,
  deckId: string,
): Promise<PptxExportOutcome> {
  const { db, log } = deps
  const [deck] = await db
    .select({ id: decks.id, title: decks.title, folderId: decks.folderId })
    .from(decks)
    .where(eq(decks.id, deckId))
    .limit(1)
  if (!deck) return { ok: false, error: 'deckNotFound' }

  const doc = await readDocCopy(deps, 'deck', deckId)
  try {
    const handles = hydrateSlideDoc(doc)
    const rawSlides = listSlides(handles)
    if (rawSlides.length === 0) return { ok: false, error: 'noSlides' }

    const folderTokens = await loadFolderTokens(deps, deck.folderId)
    const resolved =
      folderTokens === null ? rawSlides : rawSlides.map((s) => resolveSlideTokens(s, folderTokens))
    const unresolved = { count: 0 }
    const slides = resolved.map((s) => replaceUnresolvedTokens(s, unresolved))
    if (unresolved.count > 0) {
      log.warn(
        { deckId, count: unresolved.count },
        'pptx-export: unresolved colour tokens written as grey',
      )
    }

    const assetLoader = createDeckAssetLoader({ db, log, s3: buildS3Client() }, deck)

    // Speaker notes, as the notes editor holds them; no entry → no notes page.
    const notesBySlideId = new Map<string, NotesDoc>()
    for (const slide of slides) {
      const fragment = getSlideNotes(handles, slide.id)
      if (fragment === null) continue
      const notes = notesFromFragment(fragment)
      if (notes.length > 0) notesBySlideId.set(slide.id, notes)
    }

    let buffer: Buffer
    try {
      buffer = await writeDeck(slides, { title: deck.title, assetLoader, notesBySlideId })
    } catch (err) {
      log.error({ err, deckId }, 'pptx-export: writing the package failed')
      return { ok: false, error: 'writeFailed' }
    }
    return {
      ok: true,
      buffer,
      filename: safeFilename(deck.title || 'deck') + '.pptx',
      slideCount: slides.length,
    }
  } finally {
    doc.destroy()
  }
}

/**
 * The media rows an export of `deck` may embed: the deck's own assets, plus
 * the fonts of its folder (folder fonts are shared by every deck in it and
 * carry `folder_id`, not `deck_id`). Anything else — another deck's image, a
 * font of another folder — is out of scope.
 */
export function deckAssetScope(deck: { id: string; folderId: string | null }): SQL {
  const own = eq(mediaAssets.deckId, deck.id)
  if (deck.folderId === null) return own
  return or(own, and(eq(mediaAssets.folderId, deck.folderId), eq(mediaAssets.kind, 'font')))!
}

/**
 * The writer's asset loader for one deck: resolves an asset id to its bytes
 * when the asset is in the deck's scope (`deckAssetScope`), else null — the
 * writer then skips it like a missing file. Memoised so repeated references
 * (the same logo on every slide) hit MinIO once; the package is assembled in
 * memory.
 */
export function createDeckAssetLoader(
  deps: Pick<ServiceDeps, 'db' | 'log'> & { s3: Pick<ReturnType<typeof buildS3Client>, 'send'> },
  deck: { id: string; folderId: string | null },
): AssetLoader {
  const { db, log, s3 } = deps
  const scope = deckAssetScope(deck)
  const assetCache = new Map<string, { bytes: Buffer; mimeType: string } | null>()
  return async (assetId) => {
    if (assetCache.has(assetId)) return assetCache.get(assetId) ?? null
    const [row] = await db
      .select({ storageKey: mediaAssets.storageKey, mimeType: mediaAssets.mimeType })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, assetId), scope))
      .limit(1)
    if (!row) {
      assetCache.set(assetId, null)
      return null
    }
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: row.storageKey }))
      if (obj.Body === undefined) {
        assetCache.set(assetId, null)
        return null
      }
      const result = { bytes: await streamToBuffer(obj.Body as Readable), mimeType: row.mimeType }
      assetCache.set(assetId, result)
      return result
    } catch (err) {
      log.warn({ err, assetId }, 'pptx-export: failed to fetch asset bytes')
      assetCache.set(assetId, null)
      return null
    }
  }
}

/**
 * The folder's tokens (live when its document is open, else stored), or
 * null for a legacy deck without a folder or a folder without tokens.
 */
async function loadFolderTokens(
  deps: Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>,
  folderId: string | null,
): Promise<FolderTokensSnapshot | null> {
  if (folderId === null) return null
  const doc = await readDocCopy(deps, 'folder', folderId)
  try {
    if (!(doc.getMap('tokens') instanceof Y.Map) || doc.getMap('tokens').size === 0) return null
    return tokensSnapshot(doc)
  } finally {
    doc.destroy()
  }
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

/** Drain a Readable into a Buffer (the AWS SDK returns Body as a stream). */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks)
}

/**
 * A `Content-Disposition: attachment` value for `filename`: the exact name
 * in RFC 5987 `filename*=`, plus a `filename=` fallback that header values
 * can carry — Latin-1 for an HTTP response (what Node allows, and what the
 * editor's download reads), strict ASCII for object-store metadata.
 */
export function attachmentDisposition(
  filename: string,
  fallback: 'latin1' | 'ascii' = 'latin1',
): string {
  const outside = fallback === 'latin1' ? /[^\x20-\x7e\xa0-\xff]/g : /[^\x20-\x7e]/g
  const safe = filename.replace(outside, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/**
 * Strip characters that are unsafe in `Content-Disposition: filename=` and in
 * common file systems. Keeps unicode letters/numbers/dashes/underscores —
 * just removes quotes, slashes, control bytes, and anything that would
 * confuse a `filename=` parser. Caps the result so a maliciously long deck
 * title cannot produce a 4000-char download name.
 */
export function safeFilename(title: string): string {
  const trimmed = title
    .replace(/[\u0000-\u001f\u007f"'<>\\/|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return trimmed.length === 0 ? 'deck' : trimmed.slice(0, 120)
}
