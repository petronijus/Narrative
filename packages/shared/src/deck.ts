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
  /**
   * P3: Keynote-style outline indent level. `0` (default) = top level.
   * Higher values = child of the nearest previous slide at a lower
   * indent. Child slides are hidden when any ancestor's `collapsed`
   * flag is true in the sidebar; present-mode ignores both fields
   * (collapse is purely a sidebar UX choice).
   */
  indent?: number
  /**
   * P3: when true, this slide's outline children are hidden in the
   * slides panel. Only meaningful on slides that have at least one
   * subsequent slide at a higher indent level.
   */
  collapsed?: boolean
  /**
   * The style pack layout the slide follows (A4.4): written by
   * `slide.applyLayout` (replaced by the next one), restyled by
   * `style.deck.apply`; nothing detaches a slide from its layout yet. Its
   * `surface` (a photo tone, a blue band) is where the slide's colour
   * tokens resolve (A4.2d).
   */
  layout?: SlideLayoutRef
}

/** A slide's pack layout (A4.4). */
export interface SlideLayoutRef {
  packId: string
  layoutId: string
  /** The surface the layout pins or the slide chose; colour tokens resolve on it. */
  surface?: string
}

/**
 * Deck-wide settings at the document root's `meta` map (A4.2d): the
 * deck's style variant — one value per axis of its folder's pack (Contoso's
 * background; Woodgrove's theme and accent) — the values of the pack's footer
 * fields, and the deck's language.
 */
export interface DeckMeta {
  variant?: Record<string, string>
  fields?: Record<string, string>
  lang?: string
}

/**
 * Compute the 1-based page number for `slideId` among the deck's
 * non-skipped slides. Returns `undefined` when the slide is unknown or
 * is itself flagged skipped (skipped slides never render in present
 * mode, so the displayed number is moot).
 *
 * Slides without a "page number" text object still consume a counter
 * tick — the count reflects deck position, not whether a badge exists.
 */
export function computeSlideNumber(
  slides: ReadonlyArray<Pick<Slide, 'id' | 'skipped'>>,
  slideId: string,
): number | undefined {
  let n = 0
  for (const s of slides) {
    if (s.skipped === true) continue
    n += 1
    if (s.id === slideId) return n
  }
  return undefined
}

// ---------------------------------------------------------------------------
// P11: deck-level rulers + guides
// ---------------------------------------------------------------------------

/**
 * Author-placed alignment guide drawn across the artboard. Stored at the
 * deck level (shared by every slide) and persisted in Y.Doc. Positions
 * are in slide-space pixels: `position` is X for vertical guides, Y for
 * horizontal guides.
 */
export interface DeckGuide {
  id: string
  orientation: 'horizontal' | 'vertical'
  position: number
}
