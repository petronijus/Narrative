/**
 * ui/animationTriggers.ts
 *
 * Trigger choices shared by the two trigger pickers (the Inspector's
 * per-animation row and the timeline bar's inline <select>).
 */

import type { AnimationTrigger } from '@narrative/shared'

const OFFERED_TRIGGERS: ReadonlyArray<AnimationTrigger> = [
  'withPrevious',
  'afterPrevious',
  'onClick',
]

/**
 * Trigger choices for a step's <select>. `onEnter` is legacy — no longer
 * offered for new choices (a time-driven first step starts at the slide
 * start anyway, and dragging on the timeline derives afterPrevious /
 * withPrevious). But a step that still HAS it must show it: a controlled
 * <select> whose value matches no option displays the first option, which
 * would claim a trigger the step does not have. So onEnter is listed only
 * for such a step, and disappears once the user picks something else.
 *
 * Display only — nothing here (or in the pickers) rewrites a stored
 * onEnter; its meaning for playback is unchanged: the compiler anchors it
 * at the slide start (position 0 + delay) at any index.
 */
export function triggerOptionsFor(current: AnimationTrigger): AnimationTrigger[] {
  return current === 'onEnter' ? ['onEnter', ...OFFERED_TRIGGERS] : [...OFFERED_TRIGGERS]
}
