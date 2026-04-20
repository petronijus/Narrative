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
 * - Bulk-copies objects via addObject() with fresh nanoid IDs.
 * - Animations are copied without objectId linkage — IDs differ post-copy.
 *   Full ID remapping is deferred to M22.
 * - All mutations run in individual doc.transact calls (addSlide, addObject, addAnimation).
 *   A single compound transaction would be cleaner — deferred to M22.
 */

import { nanoid } from 'nanoid'
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

  // Copy objects into the new slide with freshly generated IDs
  const objectsCtx = getSlideObjectsCtx(deckCtx, newSlide.id)
  if (objectsCtx !== null) {
    for (const obj of source.objects) {
      const copy: SlideObject = {
        ...(obj as SlideObject),
        id: nanoid(),
      }
      addObject(objectsCtx, copy)
    }
  }

  // Copy animations into the new slide.
  // NOTE: objectId references from the source are intentionally kept as-is here —
  // the copied objects have new IDs so animation-to-object linkage will be broken.
  // A full deep-copy with ID remapping is deferred to M22.
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
