/**
 * renderer/experimental/textEngine/runs.ts — the positioned glyph runs every
 * candidate of the E7 spike draws (docs/plans/performance.md → E7).
 *
 * EXPERIMENTAL, not on any user path: the spike page
 * (`apps/web/text-engine-spike.html`, dev server only) is the one importer.
 *
 * A text's layout is produced once, in CSS px of the text's own box, and is
 * independent of the resolution it is drawn at — the property that makes a
 * zoom a re-paint instead of a re-layout. Two producers exist:
 *
 *   - `domRuns.ts` reads the browser's own layout of the markup HTMLText
 *     rasterises (the line boxes are the browser's, so they are exact);
 *   - `blockLayout.ts` lays the same markup out itself from Canvas2D
 *     measurements, without a DOM layout (it can run in a worker).
 *
 * and three consumers: `paint.ts` (Canvas2D, in a worker or on the main
 * thread) and `sdfText.ts` (SDF glyph atlases drawn by Pixi's BitmapText).
 *
 * Coordinates are the HTMLText texture's: (0, 0) is the outer corner of the
 * style's padding, so a raster of `width + 2 * padding` CSS px lines up with
 * Pixi's own (`HTMLTextSystem`, `getPo2TextureFromSource`).
 */

/** One run of glyphs in one font on one line. */
export interface GlyphRun {
  /** The characters as drawn (text-transform applied). */
  text: string
  /** Start of the run's first glyph, CSS px. */
  x: number
  /** Alphabetic baseline, CSS px. */
  y: number
  /** CSS `font` shorthand without stretch: `italic 700 24px "Inter", Arial`. */
  font: string
  /** Font size in px (the SDF back end scales its atlas by it). */
  size: number
  /** `font-stretch` in percent (100 = normal). */
  stretch: number
  /** CSS colour of the glyphs. */
  color: string
  /** px; 0 = none. */
  letterSpacing: number
  /** Advance of the run as laid out, CSS px (decorations, SDF placement). */
  width: number
  /**
   * Words at positions the layout fixed (offsets from `x`); absent: the run
   * is drawn as one string. See `domRuns.ts` → `MeasureOptions.words`.
   */
  parts?: Array<{ text: string; dx: number }>
  /** An underline drawn under the run, if the run is decorated. */
  underline?: { offset: number; thickness: number; color: string }
  /** `-webkit-text-stroke`, painted under the fill (`paint-order: stroke`). */
  stroke?: { width: number; color: string }
}

/** A text laid out: what a raster needs and what the renderer measures. */
export interface TextRunLayout {
  /** Content width / height as `measureHtmlText` reports them (padding excluded). */
  width: number
  height: number
  /** HTMLTextStyle padding, CSS px. */
  padding: number
  runs: GlyphRun[]
  /** Line boxes (top, bottom) in the same coordinates; for fidelity checks. */
  lines: Array<{ top: number; bottom: number }>
}

/** The raster size in device px HTMLTextSystem gives a text (without its 2 px UV margin). */
export function rasterSize(
  layout: Pick<TextRunLayout, 'width' | 'height' | 'padding'>,
  resolution: number,
): { width: number; height: number } {
  return {
    width: Math.ceil(Math.ceil(Math.max(1, layout.width) + layout.padding * 2) * resolution),
    height: Math.ceil(Math.ceil(Math.max(1, layout.height) + layout.padding * 2) * resolution),
  }
}

/** Canvas `fontStretch` keywords by percent (CSS Fonts 4 §2.3); others have no canvas spelling. */
export const STRETCH_KEYWORDS: ReadonlyMap<number, CanvasFontStretch> = new Map<
  number,
  CanvasFontStretch
>([
  [50, 'ultra-condensed'],
  [62.5, 'extra-condensed'],
  [75, 'condensed'],
  [87.5, 'semi-condensed'],
  [100, 'normal'],
  [112.5, 'semi-expanded'],
  [125, 'expanded'],
  [150, 'extra-expanded'],
  [200, 'ultra-expanded'],
])

/** The canvas keyword for a width, or undefined when Canvas2D cannot express it. */
export function stretchKeyword(percent: number): CanvasFontStretch | undefined {
  return STRETCH_KEYWORDS.get(percent)
}
