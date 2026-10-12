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
 *   3. Media is embedded only when the deck may show it (`deckAssetScope`,
 *      media/visibleMedia.ts): a row of the deck itself, or a picture or
 *      video its folder lets every deck link (a component's, the folder's
 *      own). Exporting is reading what the deck shows: whoever may export
 *      the deck (its editors) reads its folder's linked media anyway, as a
 *      content reader of the folder. An asset id merely named in the
 *      document — pasted in by a collaborator or an agent — that points at
 *      another deck's media, another folder's or the folder's fonts is
 *      skipped like a missing asset, so an export can never be used to read
 *      media the exporter has no access to.
 *   4. Hand the slides to `writeDeck` (pptx/ooxml/) — the OOXML writer that
 *      shares its units, vocabulary and element readers with the importer, so
 *      an exported deck imports back as the same model (pptx/roundtrip.test.ts)
 *      and every part is schema-valid (pptx/ooxml/validate.test.ts).
 */

import type { Readable } from 'node:stream'
import * as Y from 'yjs'
import { and, eq, type SQL } from 'drizzle-orm'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import {
  hydrateSlideDoc,
  isTokenRef,
  listSlides,
  parseHexColor,
  readDeckMeta,
  resolveTokenValue,
  type FolderTokensSnapshot,
  type TokenResolveContext,
} from '@narrative/slide-model'
import type { Slide, SlideObject } from '@narrative/shared'
import { components, decks, mediaAssets } from '../db/schema.js'
import { visibleInSql } from '../media/visibleMedia.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { writeDeck, type AssetLoader } from './ooxml/writeDeck.js'
import { getSlideNotesDoc, readFolderTokens, type NotesDoc } from '@narrative/slide-model'
import type { ServiceDeps } from '../services/deps.js'
import { readDocCopy } from '../services/liveDocs.js'

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
    const variant = readDeckMeta(doc).variant
    const resolved =
      folderTokens === null
        ? rawSlides
        : rawSlides.map((s) => resolveSlideTokens(s, folderTokens, variant))
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
      const notes = getSlideNotesDoc(handles, slide.id) ?? []
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
 * The media rows an export of `deck` may embed: what the deck may show
 * (media/visibleMedia.ts) — its own assets, and its folder's pictures and
 * videos: those of the folder's components a stamp links and the folder's
 * own (a deleted component's). Anything else — another deck's image,
 * another folder's, a font row — is out of scope (fonts are not embedded).
 * Applies to a query that left-joins `components` on the row's component.
 */
export function deckAssetScope(deck: { id: string; folderId: string | null }): SQL {
  return visibleInSql({ owner: { deckId: deck.id }, folderId: deck.folderId })
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
      .leftJoin(components, eq(components.id, mediaAssets.componentId))
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
    return readFolderTokens(doc)
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
export function resolveSlideTokens(
  slide: Slide,
  tokens: FolderTokensSnapshot,
  variant?: Readonly<Record<string, string>>,
): Slide {
  // Where the slide's colours resolve: the deck's variant, the slide's surface (A4.2d).
  const ctx: TokenResolveContext = {
    ...(variant !== undefined ? { variant } : {}),
    ...(slide.layout?.surface !== undefined ? { surface: slide.layout.surface } : {}),
  }
  const objects = slide.objects.map((obj) => resolveTokensDeep(obj, tokens, ctx) as SlideObject)
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

/** The alpha field a colour field's token alpha multiplies into (A4.2d). */
const ALPHA_OF: Readonly<Record<string, string>> = {
  color: 'colorAlpha',
  fill: 'fillAlpha',
  stroke: 'strokeAlpha',
}

function resolveTokensDeep(
  value: unknown,
  tokens: FolderTokensSnapshot,
  ctx: TokenResolveContext = {},
): unknown {
  if (Array.isArray(value)) {
    let touched = false
    const next: unknown[] = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      const resolved = resolveTokensDeep(value[i], tokens, ctx)
      next[i] = resolved
      if (resolved !== value[i]) touched = true
    }
    return touched ? next : value
  }
  if (!isPlainObject(value)) return value
  // TokenRef itself — resolve to a hex number when possible. Leave the ref
  // in place when the token id is unknown (see replaceUnresolvedTokens).
  if (isTokenRef(value)) {
    const resolved = resolveTokenValue(value, tokens, ctx)
    const parsed = resolved === null ? null : parseHexColor(resolved)
    return parsed === null ? value : parsed.color
  }
  let touched = false
  const next: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const orig = value[key]
    const resolved = resolveTokensDeep(orig, tokens, ctx)
    next[key] = resolved
    if (resolved !== orig) touched = true
  }
  // A token colour with alpha (#rrggbbaa) multiplies its field's own alpha.
  for (const [key, alphaKey] of Object.entries(ALPHA_OF)) {
    const orig = value[key]
    if (!isTokenRef(orig)) continue
    const hex = resolveTokenValue(orig, tokens, ctx)
    const alpha = hex === null ? 1 : (parseHexColor(hex)?.alpha ?? 1)
    if (alpha >= 1) continue
    const own = typeof value[alphaKey] === 'number' ? (value[alphaKey] as number) : 1
    next[alphaKey] = Math.round(own * alpha * 1000) / 1000
    touched = true
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
