/**
 * slide-model/src/sections.ts
 *
 * Deck-level section CRUD (P3).
 *
 * Sections live at `doc.getArray('sections')` as a Y.Array<Y.Map>,
 * separate from the slides Y.Array. Slides declare membership via the
 * optional `sectionId` field. Sections are purely presentational: they
 * don't influence present-mode ordering, only the slides panel's
 * grouping + collapse UI.
 *
 * All mutations run inside doc.transact(fn, LOCAL_ORIGIN).
 */

import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import type { DeckSection } from '@narrative/shared'
import type { SlideMutationContext } from './slides.js'
import { LOCAL_ORIGIN } from './mutations.js'

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

function getSectionsArray(ctx: SlideMutationContext): Y.Array<Y.Map<unknown>> {
  return ctx.doc.getArray<Y.Map<unknown>>('sections')
}

function findSectionIndex(sections: Y.Array<Y.Map<unknown>>, sectionId: string): number {
  for (let i = 0; i < sections.length; i++) {
    if (sections.get(i).get('id') === sectionId) return i
  }
  return -1
}

function yMapToSection(m: Y.Map<unknown>): DeckSection {
  return {
    id: (m.get('id') as string) ?? '',
    title: (m.get('title') as string) ?? '',
    collapsed: (m.get('collapsed') as boolean) ?? false,
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Returns a plain snapshot of the deck's sections in Y.Array order.
 */
export function listSections(ctx: SlideMutationContext): DeckSection[] {
  const sections = getSectionsArray(ctx)
  const out: DeckSection[] = []
  for (let i = 0; i < sections.length; i++) {
    out.push(yMapToSection(sections.get(i)))
  }
  return out
}

/**
 * Subscribes to deck section changes. `cb` fires immediately with the
 * current snapshot and then on every mutation affecting the sections
 * Y.Array or any of its member Y.Maps (deep observer).
 *
 * Returns an unsubscribe function.
 */
export function subscribeToSections(
  ctx: SlideMutationContext,
  cb: (sections: DeckSection[]) => void,
): () => void {
  const sections = getSectionsArray(ctx)
  const emit = () => cb(listSections(ctx))
  emit()
  const handler = () => emit()
  sections.observeDeep(handler)
  return () => sections.unobserveDeep(handler)
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Creates a new section and appends it to the sections Y.Array (or
 * inserts at `index`). Returns the fresh snapshot.
 */
export function createSection(
  ctx: SlideMutationContext,
  title?: string,
  index?: number,
): DeckSection {
  const sections = getSectionsArray(ctx)
  const id = nanoid()
  const sectionMap = new Y.Map<unknown>()
  sectionMap.set('id', id)
  sectionMap.set('title', title ?? 'New section')
  sectionMap.set('collapsed', false)

  ctx.doc.transact(() => {
    if (index === undefined || index >= sections.length) {
      sections.push([sectionMap])
    } else {
      const clamped = Math.max(0, index)
      sections.insert(clamped, [sectionMap])
    }
  }, LOCAL_ORIGIN)

  return yMapToSection(sectionMap)
}

/**
 * Removes a section and clears `sectionId` from every slide that was
 * a member. Slides themselves are NOT deleted — just detached.
 */
export function removeSection(ctx: SlideMutationContext, sectionId: string): void {
  const sections = getSectionsArray(ctx)
  const idx = findSectionIndex(sections, sectionId)
  if (idx === -1) return

  ctx.doc.transact(() => {
    // Detach member slides first.
    for (let i = 0; i < ctx.slides.length; i++) {
      const slide = ctx.slides.get(i)
      if (slide.get('sectionId') === sectionId) {
        slide.delete('sectionId')
      }
    }
    sections.delete(idx, 1)
  }, LOCAL_ORIGIN)
}

export function renameSection(ctx: SlideMutationContext, sectionId: string, title: string): void {
  const sections = getSectionsArray(ctx)
  const idx = findSectionIndex(sections, sectionId)
  if (idx === -1) return
  ctx.doc.transact(() => {
    sections.get(idx).set('title', title.trim().length === 0 ? 'Untitled section' : title.trim())
  }, LOCAL_ORIGIN)
}

export function setSectionCollapsed(
  ctx: SlideMutationContext,
  sectionId: string,
  collapsed: boolean,
): void {
  const sections = getSectionsArray(ctx)
  const idx = findSectionIndex(sections, sectionId)
  if (idx === -1) return
  ctx.doc.transact(() => {
    sections.get(idx).set('collapsed', collapsed)
  }, LOCAL_ORIGIN)
}

/**
 * Moves a section to a new position in the sections Y.Array. Like
 * moveSlide, Yjs cannot reorder in place — we clone and re-insert.
 */
export function moveSection(ctx: SlideMutationContext, sectionId: string, toIndex: number): void {
  const sections = getSectionsArray(ctx)
  const fromIdx = findSectionIndex(sections, sectionId)
  if (fromIdx === -1) return
  const clampedTo = Math.max(0, Math.min(toIndex, sections.length - 1))
  if (fromIdx === clampedTo) return

  ctx.doc.transact(() => {
    const original = sections.get(fromIdx)
    const clone = original.clone()
    sections.delete(fromIdx, 1)
    sections.insert(clampedTo, [clone])
  }, LOCAL_ORIGIN)
}
