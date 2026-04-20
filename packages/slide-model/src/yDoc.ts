/**
 * slide-model/src/yDoc.ts
 *
 * Y.Doc factory for the multi-slide deck schema (M9).
 *
 * Schema (M9+):
 *   doc.getArray('slides') — Y.Array<Y.Map> where each Y.Map is a slide:
 *     - id: string
 *     - objects: Y.Array<Y.Map>  (nested — slide-scoped)
 *     - animations: Y.Array<Y.Map> (nested — slide-scoped)
 *     - transition: Y.Map (kind, durationMs, direction?)
 *
 * Backward-compat migration (Strategy B):
 *   If root 'objects' has items AND root 'slides' is empty → migrate in-place:
 *   create slide-0 from root objects/animations, push into slides Y.Array.
 *   Root objects/animations are left as-is (Yjs doesn't remove doc-level keys).
 *   Migration is idempotent: if slides is already populated, no-op.
 *
 * Fresh deck: if slides is empty after migration check → create one default
 * empty slide so the editor never sees a zero-slide deck.
 */

import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import { DEFAULT_TRANSITION } from '@narrative/shared'
import { LOCAL_ORIGIN } from './mutations.js'

export interface SlideDocHandles {
  doc: Y.Doc
  /** Top-level slides Y.Array — primary structure from M9 onward. */
  slides: Y.Array<Y.Map<unknown>>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Creates a new slide Y.Map with empty objects/animations arrays and default transition.
 * Must be called inside a doc.transact() to ensure proper Yjs integration.
 */
function createSlideYMap(doc: Y.Doc, id: string): Y.Map<unknown> {
  const slideMap = new Y.Map<unknown>()
  const objects = new Y.Array<Y.Map<unknown>>()
  const animations = new Y.Array<Y.Map<unknown>>()
  const transition = new Y.Map<unknown>()

  transition.set('kind', DEFAULT_TRANSITION.kind)
  transition.set('durationMs', DEFAULT_TRANSITION.durationMs)

  slideMap.set('id', id)
  slideMap.set('objects', objects)
  slideMap.set('animations', animations)
  slideMap.set('transition', transition)

  // Suppress unused doc ref — kept for future use when doc context is needed
  void doc

  return slideMap
}

/**
 * Copies all Y.Map entries from a source Y.Array into a target Y.Array.
 * Used for migration: move root objects/animations into slide-0.
 *
 * Each item in source is a Y.Map — we create plain copies as new Y.Maps
 * to insert into the target (cannot move Yjs items between arrays directly).
 */
function copyYArrayItems(source: Y.Array<Y.Map<unknown>>, target: Y.Array<Y.Map<unknown>>): void {
  const copies: Y.Map<unknown>[] = []
  for (let i = 0; i < source.length; i++) {
    const src = source.get(i)
    const copy = new Y.Map<unknown>()
    src.forEach((value, key) => {
      copy.set(key, value)
    })
    copies.push(copy)
  }
  if (copies.length > 0) {
    target.push(copies)
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Creates or hydrates a Y.Doc for a deck.
 *
 * When called on a fresh Y.Doc: creates one empty default slide.
 * When called on a legacy Y.Doc (root objects populated, slides empty):
 *   migrates root objects/animations into slide-0 in one transact().
 * When called on an already-migrated Y.Doc: no-op.
 *
 * All mutations run under LOCAL_ORIGIN so they are tracked by UndoManager.
 */
export function createSlideDoc(): SlideDocHandles {
  const doc = new Y.Doc()
  const slides = doc.getArray<Y.Map<unknown>>('slides')

  // Backward-compat: check legacy root arrays
  const legacyObjects = doc.getArray<Y.Map<unknown>>('objects')
  const legacyAnimations = doc.getArray<Y.Map<unknown>>('animations')

  const hasLegacyObjects = legacyObjects.length > 0
  const hasMigratedSlides = slides.length > 0

  if (hasLegacyObjects && !hasMigratedSlides) {
    // Migrate legacy single-slide doc → slides[0]
    // IMPORTANT: push slideMap into slides FIRST to register nested Y types with the doc,
    // then populate objects/animations from legacy arrays.
    doc.transact(() => {
      const slideMap = createSlideYMap(doc, nanoid())
      slides.push([slideMap])

      // After insertion, nested Y.Arrays are doc-integrated — safe to push into them
      const insertedSlide = slides.get(slides.length - 1)
      const slideObjects = insertedSlide.get('objects') as Y.Array<Y.Map<unknown>>
      const slideAnimations = insertedSlide.get('animations') as Y.Array<Y.Map<unknown>>

      copyYArrayItems(legacyObjects, slideObjects)
      copyYArrayItems(legacyAnimations, slideAnimations)
    }, LOCAL_ORIGIN)
  } else if (!hasMigratedSlides) {
    // Fresh doc — create one empty default slide
    doc.transact(() => {
      const slideMap = createSlideYMap(doc, nanoid())
      slides.push([slideMap])
    }, LOCAL_ORIGIN)
  }
  // else: slides already populated → no-op (already migrated or fresh with slides)

  return { doc, slides }
}

/**
 * Hydrates an existing Y.Doc (e.g. from Hocuspocus) into SlideDocHandles.
 * Runs the same backward-compat migration as createSlideDoc().
 *
 * Use this when the Y.Doc is created externally (HocuspocusProvider) and
 * you need to ensure the slides structure exists.
 */
export function hydrateSlideDoc(doc: Y.Doc): SlideDocHandles {
  const slides = doc.getArray<Y.Map<unknown>>('slides')
  const legacyObjects = doc.getArray<Y.Map<unknown>>('objects')
  const legacyAnimations = doc.getArray<Y.Map<unknown>>('animations')

  const hasLegacyObjects = legacyObjects.length > 0
  const hasMigratedSlides = slides.length > 0

  if (hasLegacyObjects && !hasMigratedSlides) {
    doc.transact(() => {
      const slideMap = createSlideYMap(doc, nanoid())
      slides.push([slideMap])

      const insertedSlide = slides.get(slides.length - 1)
      const slideObjects = insertedSlide.get('objects') as Y.Array<Y.Map<unknown>>
      const slideAnimations = insertedSlide.get('animations') as Y.Array<Y.Map<unknown>>

      copyYArrayItems(legacyObjects, slideObjects)
      copyYArrayItems(legacyAnimations, slideAnimations)
    }, LOCAL_ORIGIN)
  } else if (!hasMigratedSlides) {
    doc.transact(() => {
      const slideMap = createSlideYMap(doc, nanoid())
      slides.push([slideMap])
    }, LOCAL_ORIGIN)
  }

  return { doc, slides }
}

// ---------------------------------------------------------------------------
// Internal: exposed for slides.ts
// ---------------------------------------------------------------------------

export { createSlideYMap }
