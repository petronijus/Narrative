/**
 * slide-model/src/deckMeta.ts — a deck's settings at the document root's
 * `meta` map (A4.2d): its style variant (one value per axis of its folder's
 * pack), the values of the pack's footer fields, its language.
 *
 *   meta: Y.Map { variant?: { [axis]: value }, fields?: { [id]: text }, lang?: string,
 *                 spec?: DeckSpec }
 *
 * `spec` (A5.3) is the deck spec the deck was last built from
 * (`style.deck.apply { spec }`), kept so it builds again with another
 * variant or another pack; a plain JSON value of at most 256 kB, replaced
 * whole, read by query.deck { spec: true }.
 *
 * `variant` and `fields` are plain JSON values, replaced whole: a deck has
 * a handful of each, and a variant is chosen as a whole. Read everywhere a
 * colour token is resolved for the deck (the renderer, PPTX export, the
 * commands); written by `style.deck.apply` (A4.4).
 */

import type * as Y from 'yjs'
import type { DeckMeta } from '@narrative/shared'

function metaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>('meta')
}

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
    if (k !== '__proto__' && typeof value === 'string') out[k] = value
  }
  return out
}

/** The deck's meta as a plain snapshot; malformed entries are left out. */
export function readDeckMeta(doc: Y.Doc): DeckMeta {
  const m = metaMap(doc)
  const out: DeckMeta = {}
  const variant = stringRecord(m.get('variant'))
  if (variant !== undefined && Object.keys(variant).length > 0) out.variant = variant
  const fields = stringRecord(m.get('fields'))
  if (fields !== undefined && Object.keys(fields).length > 0) out.fields = fields
  const lang = m.get('lang')
  if (typeof lang === 'string' && lang !== '') out.lang = lang
  return out
}

/** A change to the deck's meta; `null` removes a field. */
export interface DeckMetaPatch {
  variant?: Record<string, string> | null
  fields?: Record<string, string> | null
  lang?: string | null
}

/**
 * Write `patch` onto the deck's meta in one transaction (nested in the
 * caller's, whose origin wins). Only the keys present change.
 */
export function setDeckMeta(doc: Y.Doc, patch: DeckMetaPatch): void {
  doc.transact(() => {
    const m = metaMap(doc)
    for (const key of ['variant', 'fields', 'lang'] as const) {
      if (!(key in patch)) continue
      const value = patch[key]
      if (value === null || value === undefined) m.delete(key)
      else m.set(key, value)
    }
  })
}

/** Listen to the deck's meta; returns the unsubscribe. */
export function subscribeDeckMeta(doc: Y.Doc, listener: (meta: DeckMeta) => void): () => void {
  const m = metaMap(doc)
  const handler = (): void => listener(readDeckMeta(doc))
  m.observe(handler)
  return () => m.unobserve(handler)
}

/** The deck spec the deck was last built from (A5.3), as stored; null when there is none. */
export function readDeckSpec(doc: Y.Doc): Record<string, unknown> | null {
  const v = metaMap(doc).get('spec')
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

/** Keep the spec the deck was built from, or forget it (`null`); nested in the caller's transaction. */
export function setDeckSpec(doc: Y.Doc, spec: Record<string, unknown> | null): void {
  doc.transact(() => {
    if (spec === null) metaMap(doc).delete('spec')
    else metaMap(doc).set('spec', spec)
  })
}
