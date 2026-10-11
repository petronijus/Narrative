/**
 * render/cardState.ts — what each card picture (a deck's, a component
 * master's) was last drawn from,
 * so the background scheduler (services/deckThumbnails.ts) does not draw the
 * same card twice, whoever drew it last (services/render.ts: the scheduler,
 * or `deck.refreshThumbnail`).
 *
 * The key is a hash of the first slide's Yjs structure (`cardSourceOf`) —
 * the card shows nothing else. Not the document's state
 * vector: a Yjs deletion leaves the state vector as it was, so deleting the
 * title would never have redrawn the card; and an edit on slide 7 would
 * have. What the slide refers to outside the document (folder tokens and
 * fonts) is not in the hash: changing those stores no deck snapshot anyway.
 *
 * In this process's memory, bounded; a restart forgets at most one picture
 * per deck.
 */

import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import type { CardRef } from '../services/deckThumbnailStore.js'

const keyOf = (card: CardRef): string => `${card.kind}:${card.id}`

const MAX_REMEMBERED = 2_000

const drawnFrom = new Map<string, string>()

/** The hash of what a deck's card shows (its first slide); null for a deck without slides. */
export function cardSourceOf(doc: Y.Doc): string | null {
  const slides = doc.getArray<unknown>('slides')
  if (slides.length === 0) return null
  return createHash('sha256')
    .update(canonical(slides.get(0)))
    .digest('base64url')
}

/**
 * The slide's Yjs structure as text, the same for every copy of the
 * document: map keys sorted (copies may hold them in another order), a text
 * as its delta (its runs and their formatting), anything else as JSON.
 */
function canonical(value: unknown): string {
  if (value instanceof Y.Text) return `T${JSON.stringify(value.toDelta())}`
  if (value instanceof Y.Map) {
    const keys = [...(value as Y.Map<unknown>).keys()].sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value.get(k))}`).join(',')}}`
  }
  if (value instanceof Y.Array) return `[${value.toArray().map(canonical).join(',')}]`
  if (value instanceof Y.AbstractType) return `X${JSON.stringify(value.toJSON())}`
  return JSON.stringify(value) ?? 'null'
}

/** The source the card was last drawn from in this process, if any. */
export function cardDrawnFrom(card: CardRef): string | undefined {
  return drawnFrom.get(keyOf(card))
}

export function noteCardDrawn(card: CardRef, source: string): void {
  const key = keyOf(card)
  drawnFrom.delete(key)
  drawnFrom.set(key, source)
  if (drawnFrom.size > MAX_REMEMBERED) drawnFrom.delete(drawnFrom.keys().next().value!)
}

export function forgetCard(card: CardRef): void {
  drawnFrom.delete(keyOf(card))
}

/** Test helper. */
export function clearCardStateForTests(): void {
  drawnFrom.clear()
}
