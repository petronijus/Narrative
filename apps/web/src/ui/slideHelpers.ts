/**
 * ui/slideHelpers.ts
 *
 * Client-side slide helper utilities (M9).
 *
 * pasteSlides — stamps clipboard slide snapshots into the deck. Duplicating a
 * slide within the deck is a slide-model mutation (`duplicateSlide`): it
 * clones the slide's Yjs structure, which a snapshot cannot carry.
 */

import {
  addSlide,
  getSlideObjectsCtx,
  getSlideAnimationsCtx,
  addObject,
  addAnimation,
  updateSlideTransition,
  updateSlideBackground,
} from '@narrative/slide-model'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { Slide, SlideObject } from '@narrative/shared'

/**
 * Pastes plain Slide snapshots (typically from the cross-deck clipboard)
 * into the deck, inserted starting at `insertAtIndex`. Keeps object ids
 * as slide-model's `duplicateSlide` does, so pasted slides keep Magic
 * Move parity within their objects + animations.
 *
 * Returns the ids of the newly created slides in insertion order.
 */
export function pasteSlides(
  deckCtx: SlideMutationContext,
  slides: ReadonlyArray<Slide>,
  insertAtIndex?: number,
): string[] {
  const newIds: string[] = []
  let idx = insertAtIndex
  for (const source of slides) {
    const newSlide = addSlide(deckCtx, idx)
    newIds.push(newSlide.id)
    if (idx !== undefined) idx += 1

    // Restore transition and background.
    if (source.transition !== undefined) {
      updateSlideTransition(deckCtx, newSlide.id, source.transition)
    }
    if (source.background !== undefined) {
      updateSlideBackground(deckCtx, newSlide.id, source.background)
    }

    const objectsCtx = getSlideObjectsCtx(deckCtx, newSlide.id)
    if (objectsCtx !== null) {
      for (const obj of source.objects) {
        addObject(objectsCtx, obj as SlideObject)
      }
    }

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
  }
  return newIds
}
