/**
 * slide-model/src/deckFonts.ts
 *
 * P15: deck-level custom fonts. Every editor of a deck can upload a
 * .ttf / .otf; the entry shows up here, syncs to all collaborators
 * via Hocuspocus, and the client-side FontLoader installs the font
 * via the FontFace API so any TextObject that uses `family` renders
 * with the new face.
 *
 * Schema mirrors `deckGuides.ts`: a top-level `Y.Array<Y.Map>` named
 * `fonts` on the Y.Doc, each Y.Map holding the DeckFontEntry shape.
 * Mutations always go through `doc.transact(fn, LOCAL_ORIGIN)` so the
 * UndoManager picks them up the same way slide / guide edits do.
 *
 * No backwards-compat work needed — `doc.getArray('fonts')` on an
 * existing deck creates an empty array on first access.
 */

import * as Y from 'yjs'
import type { DeckFontEntry } from '@narrative/shared'
import { LOCAL_ORIGIN } from './mutations.js'

export interface DeckFontsContext {
  doc: Y.Doc
  /** Top-level fonts Y.Array. */
  fonts: Y.Array<Y.Map<unknown>>
}

/**
 * Returns a `DeckFontsContext` for the given Y.Doc, lazily creating
 * the root Y.Array on first access.
 */
export function getDeckFontsCtx(doc: Y.Doc): DeckFontsContext {
  const fonts = doc.getArray<Y.Map<unknown>>('fonts')
  return { doc, fonts }
}

function findFontIndex(arr: Y.Array<Y.Map<unknown>>, id: string): number {
  for (let i = 0; i < arr.length; i++) {
    if (arr.get(i).get('id') === id) return i
  }
  return -1
}

function yMapToFont(m: Y.Map<unknown>): DeckFontEntry | null {
  const id = m.get('id')
  const family = m.get('family')
  const weight = m.get('weight')
  const style = m.get('style')
  const postscriptName = m.get('postscriptName')
  const addedBy = m.get('addedBy')
  const addedAt = m.get('addedAt')
  const originalFilename = m.get('originalFilename')

  if (typeof id !== 'string') return null
  if (typeof family !== 'string' || family === '') return null
  if (typeof weight !== 'number') return null
  if (style !== 'normal' && style !== 'italic') return null
  if (typeof postscriptName !== 'string') return null
  if (typeof addedBy !== 'string') return null
  if (typeof addedAt !== 'number') return null

  const out: DeckFontEntry = {
    id,
    family,
    weight,
    style,
    postscriptName,
    addedBy,
    addedAt,
  }
  if (typeof originalFilename === 'string' && originalFilename !== '') {
    out.originalFilename = originalFilename
  }
  return out
}

/** Returns all deck fonts as a plain array snapshot. */
export function listDeckFonts(ctx: DeckFontsContext): DeckFontEntry[] {
  const out: DeckFontEntry[] = []
  for (let i = 0; i < ctx.fonts.length; i++) {
    const f = yMapToFont(ctx.fonts.get(i))
    if (f !== null) out.push(f)
  }
  return out
}

/**
 * Adds a font to the deck. The id MUST match the `media_assets.id`
 * returned by the tus upload — that's how the URL endpoint locates the
 * actual TTF/OTF bytes in MinIO. No-op if a row with the same id is
 * already present (idempotent — a quick double-click on Upload won't
 * register two entries).
 */
export function addDeckFont(ctx: DeckFontsContext, entry: DeckFontEntry): void {
  ctx.doc.transact(() => {
    if (findFontIndex(ctx.fonts, entry.id) !== -1) return
    const m = new Y.Map<unknown>()
    m.set('id', entry.id)
    m.set('family', entry.family)
    m.set('weight', entry.weight)
    m.set('style', entry.style)
    m.set('postscriptName', entry.postscriptName)
    m.set('addedBy', entry.addedBy)
    m.set('addedAt', entry.addedAt)
    if (entry.originalFilename !== undefined) {
      m.set('originalFilename', entry.originalFilename)
    }
    ctx.fonts.push([m])
  }, LOCAL_ORIGIN)
}

/** Removes a font by id. No-op if not found. */
export function removeDeckFont(ctx: DeckFontsContext, id: string): void {
  ctx.doc.transact(() => {
    const idx = findFontIndex(ctx.fonts, id)
    if (idx === -1) return
    ctx.fonts.delete(idx, 1)
  }, LOCAL_ORIGIN)
}

/**
 * Subscribes to deck font changes. Callback is invoked synchronously
 * on register with the current snapshot, then on every mutation.
 */
export function subscribeToDeckFonts(
  ctx: DeckFontsContext,
  callback: (fonts: DeckFontEntry[]) => void,
): () => void {
  const handler = () => {
    callback(listDeckFonts(ctx))
  }
  ctx.fonts.observeDeep(handler)
  callback(listDeckFonts(ctx))
  return () => {
    ctx.fonts.unobserveDeep(handler)
  }
}
