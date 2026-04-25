/**
 * slide-model/src/deckGuides.ts
 *
 * P11: deck-level alignment guides. Stored at the Y.Doc root as
 * `doc.getArray('guides')` — a Y.Array<Y.Map> where each Y.Map has the
 * fields { id, orientation, position }. Shared across all slides on
 * the deck (matches Keynote / Figma "rulers + guides" UX).
 *
 * Mutations always run inside doc.transact(fn, LOCAL_ORIGIN) so the
 * UndoManager scoped to the doc tracks them automatically (same scope
 * as the slides Y.Array — see undo.ts).
 */

import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import type { DeckGuide } from '@narrative/shared'
import { LOCAL_ORIGIN } from './mutations.js'

export interface DeckGuidesContext {
  doc: Y.Doc
  /** Top-level guides Y.Array. */
  guides: Y.Array<Y.Map<unknown>>
}

/**
 * Returns a `DeckGuidesContext` for the given Y.Doc, lazily creating
 * the root Y.Array on first access. Y.Doc creates root types lazily so
 * calling `getArray('guides')` on a fresh doc is safe.
 */
export function getDeckGuidesCtx(doc: Y.Doc): DeckGuidesContext {
  const guides = doc.getArray<Y.Map<unknown>>('guides')
  return { doc, guides }
}

function findGuideIndex(arr: Y.Array<Y.Map<unknown>>, id: string): number {
  for (let i = 0; i < arr.length; i++) {
    if (arr.get(i).get('id') === id) return i
  }
  return -1
}

function yMapToGuide(m: Y.Map<unknown>): DeckGuide | null {
  const id = m.get('id')
  const orientation = m.get('orientation')
  const position = m.get('position')
  if (typeof id !== 'string') return null
  if (orientation !== 'horizontal' && orientation !== 'vertical') return null
  if (typeof position !== 'number') return null
  return { id, orientation, position }
}

/** Returns all guides as a plain array snapshot. */
export function listDeckGuides(ctx: DeckGuidesContext): DeckGuide[] {
  const out: DeckGuide[] = []
  for (let i = 0; i < ctx.guides.length; i++) {
    const g = yMapToGuide(ctx.guides.get(i))
    if (g !== null) out.push(g)
  }
  return out
}

/**
 * Adds a guide to the deck. Returns the created guide's id (caller
 * doesn't need to pre-mint one). The id can be passed to updateGuide /
 * removeGuide later.
 */
export function addGuide(
  ctx: DeckGuidesContext,
  orientation: 'horizontal' | 'vertical',
  position: number,
): string {
  const id = nanoid()
  ctx.doc.transact(() => {
    const m = new Y.Map<unknown>()
    m.set('id', id)
    m.set('orientation', orientation)
    m.set('position', position)
    ctx.guides.push([m])
  }, LOCAL_ORIGIN)
  return id
}

/**
 * Updates a guide's position (orientation can't change — delete + re-add
 * if needed). No-op if the guide isn't found.
 */
export function updateGuide(ctx: DeckGuidesContext, id: string, patch: { position: number }): void {
  ctx.doc.transact(() => {
    const idx = findGuideIndex(ctx.guides, id)
    if (idx === -1) return
    ctx.guides.get(idx).set('position', patch.position)
  }, LOCAL_ORIGIN)
}

/** Removes a guide by id. No-op if not found. */
export function removeGuide(ctx: DeckGuidesContext, id: string): void {
  ctx.doc.transact(() => {
    const idx = findGuideIndex(ctx.guides, id)
    if (idx === -1) return
    ctx.guides.delete(idx, 1)
  }, LOCAL_ORIGIN)
}

/**
 * Subscribes to guide changes. Callback is invoked synchronously on
 * register with the current snapshot, then on every mutation.
 */
export function subscribeToDeckGuides(
  ctx: DeckGuidesContext,
  callback: (guides: DeckGuide[]) => void,
): () => void {
  const handler = () => {
    callback(listDeckGuides(ctx))
  }
  ctx.guides.observeDeep(handler)
  callback(listDeckGuides(ctx))
  return () => {
    ctx.guides.unobserveDeep(handler)
  }
}
