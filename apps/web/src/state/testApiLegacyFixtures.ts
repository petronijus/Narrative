/**
 * state/testApiLegacyFixtures.ts — dev-only seeding of LEGACY document
 * states for the e2e test API (state/testApi.ts).
 *
 * Every write the test API makes goes through the command registry, like
 * the editor's and an agent's. A few states cannot: they come from older
 * versions of Narrative or from PowerPoint imports, and today's commands
 * refuse to create them on purpose. A spec that checks how the editor shows
 * such a document seeds it here, with the slide-model writers, which is why
 * this one file is exempt from the one-door lint rule
 * (apps/web/eslint.one-door.js, ONE_DOOR_IGNORES). Nothing else belongs in
 * it.
 *
 * - An animation step with the retired `onEnter` trigger (starts with the
 *   slide): decks from before A2.9, and PowerPoint effects whose node type
 *   the importer does not know (apps/server/src/pptx/ooxml/timing.ts).
 */

import {
  addAnimation,
  getSlideAnimationsCtx,
  type SlideMutationContext,
} from '@narrative/slide-model'
import type { AnimationStep } from '@narrative/shared'

/** Store `step` exactly as given on `slideId`; returns the new step's id. */
export function seedLegacyAnimationStep(
  deck: SlideMutationContext,
  slideId: string,
  step: Omit<AnimationStep, 'id'>,
): string {
  if (!import.meta.env.DEV) throw new Error('legacy fixtures exist in dev builds only')
  const ctx = getSlideAnimationsCtx(deck, slideId)
  if (ctx === null) throw new Error(`seedLegacyAnimationStep: slide '${slideId}' not found`)
  return addAnimation(ctx, step).id
}
