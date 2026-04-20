/**
 * shared/src/deck.ts
 *
 * Deck-level types: SlideTransition, Slide (multi-slide schema).
 *
 * Added in M9 — multi-slide schema restructure.
 * Pure TypeScript types — no runtime dependencies.
 */

import type { SlideObject } from './slide.js'
import type { AnimationStep } from './animation.js'

export type SlideTransitionKind = 'none' | 'fade' | 'push' | 'cube'
export type SlidePushDirection = 'left' | 'right' | 'up' | 'down'

export interface SlideTransition {
  kind: SlideTransitionKind
  durationMs: number // 0 when kind === 'none'
  direction?: SlidePushDirection // only for 'push', ignored otherwise
}

export const DEFAULT_TRANSITION: SlideTransition = {
  kind: 'none',
  durationMs: 0,
}

/**
 * Slide = ordered collection of objects + animations + transition metadata.
 * One deck holds an ordered Y.Array of slides.
 *
 * Note: in Y.Doc, objects and animations are nested Y.Arrays inside the slide Y.Map.
 * This type represents the plain-object snapshot used by consumers.
 */
export interface Slide {
  id: string
  objects: SlideObject[]
  animations: AnimationStep[]
  transition: SlideTransition
}
