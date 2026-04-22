/**
 * slide-model/src/slides.ts
 *
 * Slide CRUD operations for the multi-slide deck schema (M9).
 *
 * All mutations run inside doc.transact(fn, LOCAL_ORIGIN).
 * No-ops warn to console where noted; they never throw for undefined slide IDs.
 *
 * Key invariant: a deck always has at least 1 slide (never zero).
 */

import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import { DEFAULT_TRANSITION } from '@narrative/shared'
import type {
  Slide,
  SlideTransition,
  SlideBackground,
  GradientStop,
  ImageBackground,
} from '@narrative/shared'
import type { SlideObject } from '@narrative/shared'
import type { AnimationStep } from '@narrative/shared'
import { LOCAL_ORIGIN } from './mutations.js'
import type { ObjectsMutationContext } from './mutations.js'
import type { AnimationsMutationContext } from './animationMutations.js'
import { yMapToPlainObject } from './bindings.js'
import { yMapToAnimationStep } from './animationBindings.js'

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

/**
 * Deck-level mutation context — holds doc + top-level slides Y.Array.
 * Mirrors DeckMutationContext / SlideMutationContext from slideMutationContext.ts.
 */
export interface SlideMutationContext {
  doc: Y.Doc
  slides: Y.Array<Y.Map<unknown>>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function findSlideIndex(slides: Y.Array<Y.Map<unknown>>, slideId: string): number {
  for (let i = 0; i < slides.length; i++) {
    if (slides.get(i).get('id') === slideId) return i
  }
  return -1
}

function yMapToSlide(yMap: Y.Map<unknown>): Slide {
  const id = yMap.get('id') as string
  const objectsArr = yMap.get('objects') as Y.Array<Y.Map<unknown>> | undefined
  const animationsArr = yMap.get('animations') as Y.Array<Y.Map<unknown>> | undefined
  const transitionMap = yMap.get('transition') as Y.Map<unknown> | undefined

  const objects: SlideObject[] = []
  if (objectsArr !== undefined) {
    for (let i = 0; i < objectsArr.length; i++) {
      try {
        objects.push(yMapToPlainObject(objectsArr.get(i)))
      } catch {
        // Malformed object — skip
      }
    }
  }

  const animations: AnimationStep[] = []
  if (animationsArr !== undefined) {
    for (let i = 0; i < animationsArr.length; i++) {
      try {
        animations.push(yMapToAnimationStep(animationsArr.get(i)))
      } catch {
        // Malformed animation — skip
      }
    }
  }

  const direction = transitionMap?.get('direction') as SlideTransition['direction'] | undefined
  const transition: SlideTransition = {
    kind: (transitionMap?.get('kind') as SlideTransition['kind']) ?? DEFAULT_TRANSITION.kind,
    durationMs: (transitionMap?.get('durationMs') as number) ?? DEFAULT_TRANSITION.durationMs,
    ...(direction !== undefined ? { direction } : {}),
  }

  // P2: optional background. Stored as a plain Y.Map (flat keys) —
  // gradient stops flatten to `stops:<index>:<field>` entries so Y.Doc
  // sees them as atomic granular updates. Missing ⇒ undefined in the
  // snapshot; consumers fall back to DEFAULT_BACKGROUND.
  const backgroundMap = yMap.get('background') as Y.Map<unknown> | undefined
  const background = backgroundMap === undefined ? undefined : yMapToBackground(backgroundMap)

  // P3: name + skipped. Both optional — name shows in the slides panel,
  // skipped hides the slide from present-mode navigation.
  const name = yMap.get('name') as string | undefined
  const skipped = yMap.get('skipped') as boolean | undefined

  return {
    id,
    objects,
    animations,
    transition,
    ...(background !== undefined ? { background } : {}),
    ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
    ...(skipped === true ? { skipped: true } : {}),
  }
}

/**
 * Reads a SlideBackground Y.Map back to its plain snapshot.
 * Unknown / malformed shapes return undefined so the consumer falls
 * through to the default.
 */
function yMapToBackground(m: Y.Map<unknown>): SlideBackground | undefined {
  const kind = m.get('kind') as SlideBackground['kind'] | undefined
  if (kind === undefined) return undefined
  if (kind === 'color') {
    return {
      kind: 'color',
      color: (m.get('color') as number) ?? 0xffffff,
      alpha: (m.get('alpha') as number | undefined) ?? 1,
    }
  }
  if (kind === 'linearGradient') {
    return {
      kind: 'linearGradient',
      angleDeg: (m.get('angleDeg') as number) ?? 180,
      stops: readGradientStops(m),
    }
  }
  if (kind === 'radialGradient') {
    return {
      kind: 'radialGradient',
      centerX: (m.get('centerX') as number) ?? 0.5,
      centerY: (m.get('centerY') as number) ?? 0.5,
      radius: (m.get('radius') as number) ?? 0.5,
      stops: readGradientStops(m),
    }
  }
  if (kind === 'image') {
    return {
      kind: 'image',
      assetId: (m.get('assetId') as string) ?? '',
      fit: (m.get('fit') as ImageBackground['fit']) ?? 'cover',
      dim: (m.get('dim') as number | undefined) ?? 0,
    }
  }
  return undefined
}

function readGradientStops(m: Y.Map<unknown>): GradientStop[] {
  const arr = m.get('stops') as Y.Array<Y.Map<unknown>> | undefined
  if (arr === undefined) return []
  const out: GradientStop[] = []
  for (let i = 0; i < arr.length; i++) {
    const s = arr.get(i)
    out.push({
      offset: (s.get('offset') as number) ?? 0,
      color: (s.get('color') as number) ?? 0xffffff,
      alpha: (s.get('alpha') as number | undefined) ?? 1,
    })
  }
  return out
}

function createSlideYMap(doc: Y.Doc, id: string): Y.Map<unknown> {
  const slideMap = new Y.Map<unknown>()
  const objects = new Y.Array<Y.Map<unknown>>()
  const animations = new Y.Array<Y.Map<unknown>>()
  const transition = new Y.Map<unknown>()
  // M19: speaker notes as Y.XmlFragment so Tiptap / ProseMirror can bind
  // through y-prosemirror for rich-text collab. Plain-text access still
  // works via getSlideNotesText() which serialises the fragment.
  const notes = new Y.XmlFragment()

  transition.set('kind', DEFAULT_TRANSITION.kind)
  transition.set('durationMs', DEFAULT_TRANSITION.durationMs)

  slideMap.set('id', id)
  slideMap.set('objects', objects)
  slideMap.set('animations', animations)
  slideMap.set('transition', transition)
  slideMap.set('notes', notes)

  void doc // reserved for future doc-level metadata
  return slideMap
}

// ---------------------------------------------------------------------------
// Slide CRUD
// ---------------------------------------------------------------------------

/**
 * Adds a new slide to the deck.
 *
 * @param ctx Deck-level mutation context
 * @param index Optional insertion index. Omit to append at end.
 * @returns Plain snapshot of the newly created slide
 */
export function addSlide(ctx: SlideMutationContext, index?: number): Slide {
  const id = nanoid()
  const slideMap = createSlideYMap(ctx.doc, id)

  ctx.doc.transact(() => {
    if (index === undefined || index >= ctx.slides.length) {
      ctx.slides.push([slideMap])
    } else {
      const clampedIndex = Math.max(0, index)
      ctx.slides.insert(clampedIndex, [slideMap])
    }
  }, LOCAL_ORIGIN)

  return yMapToSlide(slideMap)
}

/**
 * Removes a slide by ID.
 *
 * - No-op + warn if slide not found.
 * - If removing the last slide, keeps the deck with 1 new empty slide (never zero).
 */
export function removeSlide(ctx: SlideMutationContext, slideId: string): void {
  const idx = findSlideIndex(ctx.slides, slideId)
  if (idx === -1) {
    console.warn(`removeSlide: slide '${slideId}' not found — no-op`)
    return
  }

  ctx.doc.transact(() => {
    if (ctx.slides.length <= 1) {
      // Removing the last slide — replace with a fresh empty slide instead
      const newSlide = createSlideYMap(ctx.doc, nanoid())
      ctx.slides.delete(0, 1)
      ctx.slides.push([newSlide])
    } else {
      ctx.slides.delete(idx, 1)
    }
  }, LOCAL_ORIGIN)
}

/**
 * Moves a slide to a new index within the deck.
 * Index is clamped to valid range [0, slides.length - 1].
 * No-op + warn if slide not found.
 */
export function moveSlide(ctx: SlideMutationContext, slideId: string, toIndex: number): void {
  const fromIdx = findSlideIndex(ctx.slides, slideId)
  if (fromIdx === -1) {
    console.warn(`moveSlide: slide '${slideId}' not found — no-op`)
    return
  }

  const clampedTo = Math.max(0, Math.min(toIndex, ctx.slides.length - 1))
  if (fromIdx === clampedTo) return // Already in position

  ctx.doc.transact(() => {
    // Snapshot the slide data BEFORE deletion.
    // Y.Array items cannot be moved — must delete and re-insert a fresh Y.Map.
    // We reconstruct the slide Y.Map from the current state of the original.
    const originalMap = ctx.slides.get(fromIdx)
    const id = originalMap.get('id') as string
    const origObjects = originalMap.get('objects') as Y.Array<Y.Map<unknown>>
    const origAnimations = originalMap.get('animations') as Y.Array<Y.Map<unknown>>
    const origTransition = originalMap.get('transition') as Y.Map<unknown>

    // Build new slide Y.Map
    const newSlideMap = new Y.Map<unknown>()
    const newObjects = new Y.Array<Y.Map<unknown>>()
    const newAnimations = new Y.Array<Y.Map<unknown>>()
    const newTransition = new Y.Map<unknown>()

    // Clone transition
    origTransition.forEach((value, key) => {
      newTransition.set(key, value)
    })

    // Clone objects
    const objCopies: Y.Map<unknown>[] = []
    for (let i = 0; i < origObjects.length; i++) {
      const src = origObjects.get(i)
      const copy = new Y.Map<unknown>()
      src.forEach((value, key) => copy.set(key, value))
      objCopies.push(copy)
    }
    if (objCopies.length > 0) newObjects.push(objCopies)

    // Clone animations
    const animCopies: Y.Map<unknown>[] = []
    for (let i = 0; i < origAnimations.length; i++) {
      const src = origAnimations.get(i)
      const copy = new Y.Map<unknown>()
      src.forEach((value, key) => copy.set(key, value))
      animCopies.push(copy)
    }
    if (animCopies.length > 0) newAnimations.push(animCopies)

    newSlideMap.set('id', id)
    newSlideMap.set('objects', newObjects)
    newSlideMap.set('animations', newAnimations)
    newSlideMap.set('transition', newTransition)

    // Delete original and insert clone at target position.
    // insertAt = clampedTo for backward moves (elements after insertAt shift right by 1 after insert).
    // insertAt = clampedTo for forward moves too (after delete fromIdx, elements shift left;
    // but clampedTo already accounts for the final desired position in the original array,
    // and Y.Array.insert(n) inserts BEFORE index n, so inserting at clampedTo gives the
    // correct final order regardless of direction).
    ctx.slides.delete(fromIdx, 1)
    ctx.slides.insert(clampedTo, [newSlideMap])
  }, LOCAL_ORIGIN)
}

/**
 * Updates transition metadata for a slide.
 * No-op + warn if slide not found.
 */
export function updateSlideTransition(
  ctx: SlideMutationContext,
  slideId: string,
  patch: Partial<SlideTransition>,
): void {
  const idx = findSlideIndex(ctx.slides, slideId)
  if (idx === -1) {
    console.warn(`updateSlideTransition: slide '${slideId}' not found — no-op`)
    return
  }

  ctx.doc.transact(() => {
    const slideMap = ctx.slides.get(idx)
    const transitionMap = slideMap.get('transition') as Y.Map<unknown> | undefined

    if (transitionMap === undefined) {
      console.warn(`updateSlideTransition: slide '${slideId}' has no transition map`)
      return
    }

    if (patch.kind !== undefined) transitionMap.set('kind', patch.kind)
    if (patch.durationMs !== undefined) transitionMap.set('durationMs', patch.durationMs)
    if (patch.direction !== undefined) {
      transitionMap.set('direction', patch.direction)
    }
  }, LOCAL_ORIGIN)
}

// ---------------------------------------------------------------------------
// P3: slide metadata — name + skipped
// ---------------------------------------------------------------------------

/**
 * Sets the slide's display name. Pass an empty string (or whitespace-only)
 * to clear it; consumers fall back to "Slide {index+1}".
 */
export function setSlideName(ctx: SlideMutationContext, slideId: string, name: string): void {
  const idx = findSlideIndex(ctx.slides, slideId)
  if (idx === -1) return
  ctx.doc.transact(() => {
    const slideMap = ctx.slides.get(idx)
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      slideMap.delete('name')
    } else {
      slideMap.set('name', trimmed)
    }
  }, LOCAL_ORIGIN)
}

/**
 * Toggles (or explicitly sets) the slide's `skipped` flag. Skipped
 * slides stay visible in the editor but are passed over by present-mode
 * navigation.
 */
export function setSlideSkipped(
  ctx: SlideMutationContext,
  slideId: string,
  skipped: boolean,
): void {
  const idx = findSlideIndex(ctx.slides, slideId)
  if (idx === -1) return
  ctx.doc.transact(() => {
    const slideMap = ctx.slides.get(idx)
    if (skipped) {
      slideMap.set('skipped', true)
    } else {
      slideMap.delete('skipped')
    }
  }, LOCAL_ORIGIN)
}

// ---------------------------------------------------------------------------
// P2: background mutation
// ---------------------------------------------------------------------------

/**
 * Replaces the slide's background with the provided `next` value, or
 * clears it (reverts to the default) when `next` is null.
 *
 * The whole background is overwritten atomically — gradient stop edits
 * go through this too. It's cheap because the background Y.Map is small
 * (≤ 6 keys + a stop array of ~3-5 entries) and authoring clicks are
 * infrequent; granular per-stop editing is a later optimisation.
 */
export function updateSlideBackground(
  ctx: SlideMutationContext,
  slideId: string,
  next: SlideBackground | null,
): void {
  const idx = findSlideIndex(ctx.slides, slideId)
  if (idx === -1) {
    console.warn(`updateSlideBackground: slide '${slideId}' not found — no-op`)
    return
  }

  ctx.doc.transact(() => {
    const slideMap = ctx.slides.get(idx)
    if (next === null) {
      slideMap.delete('background')
      return
    }
    const bgMap = writeBackgroundYMap(next)
    slideMap.set('background', bgMap)
  }, LOCAL_ORIGIN)
}

function writeBackgroundYMap(bg: SlideBackground): Y.Map<unknown> {
  const m = new Y.Map<unknown>()
  m.set('kind', bg.kind)
  if (bg.kind === 'color') {
    m.set('color', bg.color)
    m.set('alpha', bg.alpha ?? 1)
    return m
  }
  if (bg.kind === 'linearGradient') {
    m.set('angleDeg', bg.angleDeg)
    m.set('stops', writeGradientStops(bg.stops))
    return m
  }
  if (bg.kind === 'radialGradient') {
    m.set('centerX', bg.centerX)
    m.set('centerY', bg.centerY)
    m.set('radius', bg.radius)
    m.set('stops', writeGradientStops(bg.stops))
    return m
  }
  // image
  m.set('assetId', (bg as ImageBackground).assetId)
  m.set('fit', (bg as ImageBackground).fit)
  m.set('dim', (bg as ImageBackground).dim ?? 0)
  return m
}

function writeGradientStops(stops: GradientStop[]): Y.Array<Y.Map<unknown>> {
  const arr = new Y.Array<Y.Map<unknown>>()
  const items = stops.map((s) => {
    const sm = new Y.Map<unknown>()
    sm.set('offset', s.offset)
    sm.set('color', s.color)
    sm.set('alpha', s.alpha ?? 1)
    return sm
  })
  arr.push(items)
  return arr
}

/**
 * Returns a full snapshot of all slides (plain objects, ordered).
 */
export function listSlides(ctx: SlideMutationContext): Slide[] {
  const result: Slide[] = []
  for (let i = 0; i < ctx.slides.length; i++) {
    result.push(yMapToSlide(ctx.slides.get(i)))
  }
  return result
}

// ---------------------------------------------------------------------------
// Per-slide scoped context accessors
// ---------------------------------------------------------------------------

/**
 * Returns an ObjectsMutationContext scoped to a specific slide's objects Y.Array.
 * Returns null if the slide doesn't exist.
 *
 * Use this to call object mutations (addObject, removeObject, etc.) for a specific slide.
 */
export function getSlideObjectsCtx(
  ctx: SlideMutationContext,
  slideId: string,
): ObjectsMutationContext | null {
  const idx = findSlideIndex(ctx.slides, slideId)
  if (idx === -1) return null

  const slideMap = ctx.slides.get(idx)
  const objects = slideMap.get('objects') as Y.Array<Y.Map<unknown>> | undefined
  if (objects === undefined) return null

  return { doc: ctx.doc, objects }
}

/**
 * Returns an AnimationsMutationContext scoped to a specific slide's animations Y.Array.
 * Returns null if the slide doesn't exist.
 *
 * Use this to call animation mutations (addAnimation, removeAnimation, etc.) for a specific slide.
 */
export function getSlideAnimationsCtx(
  ctx: SlideMutationContext,
  slideId: string,
): AnimationsMutationContext | null {
  const idx = findSlideIndex(ctx.slides, slideId)
  if (idx === -1) return null

  const slideMap = ctx.slides.get(idx)
  const animations = slideMap.get('animations') as Y.Array<Y.Map<unknown>> | undefined
  if (animations === undefined) return null

  return { doc: ctx.doc, animations }
}

/**
 * Returns the Y.XmlFragment holding speaker notes for a given slide.
 * Lazily created on first access if the slide pre-dates M19 phase 2 (any
 * slide whose `notes` field is missing or is the older Y.Text type gets a
 * fresh Y.XmlFragment installed). Returns null only if the slide itself
 * does not exist.
 */
export function getSlideNotes(ctx: SlideMutationContext, slideId: string): Y.XmlFragment | null {
  const idx = findSlideIndex(ctx.slides, slideId)
  if (idx === -1) return null
  const slideMap = ctx.slides.get(idx)
  const existing = slideMap.get('notes')
  if (existing instanceof Y.XmlFragment) return existing
  const notes = new Y.XmlFragment()
  ctx.doc.transact(() => {
    slideMap.set('notes', notes)
  }, LOCAL_ORIGIN)
  return notes
}
