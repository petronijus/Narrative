/**
 * shared/src/canvas.ts
 *
 * Canonical slide canvas dimensions in CSS px. Single source of truth — every
 * module that needs to convert to/from slide-space pixels (renderer, pptx
 * importer/exporter, snapshot/thumbnail code, AI generation, etc.) imports
 * these constants from here.
 *
 * Why 1920×1080: Full HD 16:9 — standard presentation aspect ratio with
 * enough resolution that text and shapes look crisp at typical projector +
 * 4K monitor zoom levels. Deck-level aspect-ratio overrides (4:3, square)
 * are deferred to M20.
 */

/** Width of every slide's artboard, in CSS px. */
export const SLIDE_WIDTH = 1920

/** Height of every slide's artboard, in CSS px. */
export const SLIDE_HEIGHT = 1080

/** Standard PPTX widescreen layout in EMU (English Metric Units), which is
 *  what `<p:sldSz cx cy>` carries inside `ppt/presentation.xml`. PPTX uses
 *  914 400 EMU per inch; widescreen = 13.333" × 7.5".
 *
 *  At 96 DPI that's 1280 × 720 px in source space, which means
 *  importing from / exporting to a 1920×1080 Narrative canvas needs a
 *  uniform 1.5× scale (in both directions for 16:9 inputs). Non-standard
 *  aspect ratios are handled by `min(targetW/srcW, targetH/srcH)`. */
export const PPTX_WIDE_EMU_WIDTH = 12_192_000
export const PPTX_WIDE_EMU_HEIGHT = 6_858_000
