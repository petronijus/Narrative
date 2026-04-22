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

export type SlideTransitionKind = 'none' | 'fade' | 'push' | 'cube' | 'magic'
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

// ---------------------------------------------------------------------------
// Slide background (P2: artboard + backgrounds)
// ---------------------------------------------------------------------------

export interface GradientStop {
  /** Position along the gradient: 0 = start, 1 = end. */
  offset: number
  /** 0xRRGGBB integer colour. */
  color: number
  /** Alpha 0..1, default 1. */
  alpha?: number
}

/** Solid colour fill. */
export interface ColorBackground {
  kind: 'color'
  /** 0xRRGGBB integer colour. */
  color: number
  /** Alpha 0..1, default 1. */
  alpha?: number
}

/** Linear gradient fill. */
export interface LinearGradientBackground {
  kind: 'linearGradient'
  /** Clockwise, 0 = top→bottom, 90 = left→right, …  */
  angleDeg: number
  stops: GradientStop[]
}

/** Radial gradient fill. */
export interface RadialGradientBackground {
  kind: 'radialGradient'
  /** Gradient origin, expressed as fraction of the slide (0..1). */
  centerX: number
  centerY: number
  /** Outermost radius as a fraction of the slide diagonal. */
  radius: number
  stops: GradientStop[]
}

/** Image fill referencing an uploaded asset. */
export interface ImageBackground {
  kind: 'image'
  assetId: string
  /** 'cover' fills the artboard (may crop); 'contain' letterboxes. */
  fit: 'cover' | 'contain'
  /** Optional dim overlay for legibility (0..1, default 0). */
  dim?: number
}

export type SlideBackground =
  | ColorBackground
  | LinearGradientBackground
  | RadialGradientBackground
  | ImageBackground

/** Canonical default — near-white, readable in both themes. */
export const DEFAULT_BACKGROUND: SlideBackground = {
  kind: 'color',
  color: 0xffffff,
  alpha: 1,
}

// ---------------------------------------------------------------------------
// Slide
// ---------------------------------------------------------------------------

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
  /** P2: optional per-slide background fill. Undefined ⇒ DEFAULT_BACKGROUND. */
  background?: SlideBackground
  /**
   * P3: optional slide name shown in the slides panel. Also feeds the
   * overview + speaker notes. Undefined falls back to "Slide {index+1}".
   */
  name?: string
  /**
   * P3: when true, the slide is hidden from present mode (next/prev skip
   * over it). Still visible + editable in the editor.
   */
  skipped?: boolean
}
