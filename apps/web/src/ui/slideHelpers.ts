/**
 * ui/slideHelpers.ts
 *
 * Client-side slide helper utilities (M9).
 *
 * duplicateSlide — deep-copies a slide's objects + animations into a new slide
 * inserted immediately after the source. This is a client-side helper because
 * slide-model mutations don't expose a bulk-copy primitive yet.
 *
 * TODO(M22): move duplicateSlide into @narrative/slide-model as a first-class mutation
 * (cleanup milestone). For now it lives here to keep state-sync out of scope for M9.
 *
 * Implementation notes:
 * - Reads source slide via listSlides() snapshot.
 * - Creates the new slide via addSlide() (correct transaction).
 * - Copies objects preserving their source IDs — object IDs are slide-local,
 *   and preserving them makes the duplicated slide a natural fixture for
 *   Magic Move transitions (M13) and keeps animation `objectId` references
 *   valid.
 * - All mutations run in individual doc.transact calls (addSlide, addObject,
 *   addAnimation). A single compound transaction would be cleaner — deferred
 *   to M22.
 */

import {
  addSlide,
  listSlides,
  getSlideObjectsCtx,
  getSlideAnimationsCtx,
  addObject,
  addAnimation,
} from '@narrative/slide-model'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { Slide, SlideObject } from '@narrative/shared'

/**
 * Duplicates a slide by ID, inserting the copy at `insertAtIndex`.
 *
 * @param deckCtx        Deck-level mutation context (doc + slides Y.Array)
 * @param slideId        Source slide ID
 * @param insertAtIndex  Insertion index for the new slide (default: append)
 * @returns The newly created slide snapshot, or null if the source was not found.
 */
export function duplicateSlide(
  deckCtx: SlideMutationContext,
  slideId: string,
  insertAtIndex?: number,
): Slide | null {
  // Read the current slide list snapshot
  const slides = listSlides(deckCtx)
  const source = slides.find((s) => s.id === slideId)
  if (source === undefined) {
    console.warn(`duplicateSlide: slide '${slideId}' not found — no-op`)
    return null
  }

  // Create a new empty slide at the desired position
  const newSlide = addSlide(deckCtx, insertAtIndex)

  // Copy objects into the new slide, PRESERVING the source object IDs. Two
  // reasons:
  //   1. Magic Move (M13) transitions morph objects by id-match across slides.
  //      If duplicate minted new ids, "duplicate slide + tweak" — the most
  //      natural Magic Move authoring flow — would silently fall through to
  //      a cross-fade.
  //   2. Animation steps reference objectId; fresh-id duplicates used to
  //      orphan them. Keeping ids means the copied slide's animations still
  //      target the right objects.
  //
  // Id uniqueness is per-slide (each slide's objects live in their own
  // Y.Array), so same id across two slides is safe.
  const objectsCtx = getSlideObjectsCtx(deckCtx, newSlide.id)
  if (objectsCtx !== null) {
    for (const obj of source.objects) {
      addObject(objectsCtx, obj as SlideObject)
    }
  }

  // Copy animations into the new slide. objectId references carry over
  // verbatim and now resolve correctly against the duplicated objects.
  const animationsCtx = getSlideAnimationsCtx(deckCtx, newSlide.id)
  if (animationsCtx !== null) {
    for (const anim of source.animations) {
      addAnimation(animationsCtx, {
        objectId: anim.objectId,
        preset: anim.preset,
        trigger: anim.trigger,
        duration: anim.duration,
        delay: anim.delay,
        easing: anim.easing,
        ...(anim.params !== undefined ? { params: anim.params } : {}),
      })
    }
  }

  // Return current snapshot of the new slide
  const updated = listSlides(deckCtx)
  return updated.find((s) => s.id === newSlide.id) ?? newSlide
}
