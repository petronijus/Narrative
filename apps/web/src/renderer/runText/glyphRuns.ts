/**
 * renderer/runText/glyphRuns.ts — a text laid out as positioned glyph runs
 * (ADR 0018): what the measuring host reads off the browser's layout
 * (`readRuns.ts`) and what a painter draws (`paintRuns.ts`, in a worker or on
 * the main thread).
 *
 * A layout is made once per markup, CSS and font generation, in CSS px of the
 * text's own box, and does not depend on the resolution it is drawn at: a zoom,
 * a thumbnail or a present-mode scene paints the same layout again.
 *
 * Coordinates are the HTMLText texture's: (0, 0) is the outer corner of the
 * style's padding, so a raster of `rasterSize` device px lines up with the one
 * Pixi's `HTMLTextSystem` would make (`getPo2TextureFromSource`'s frame).
 *
 * Everything here is structured-clone friendly: a layout is posted to a worker
 * as it is.
 */

/** One run of glyphs in one font, one colour and one direction, on one line. */
export interface GlyphRun {
  /** The characters as drawn (text-transform applied). */
  text: string
  /** Left edge of the run as laid out, CSS px. */
  x: number
  /** Alphabetic baseline, CSS px (unsnapped; the painter applies the engine's snapping). */
  y: number
  /** CSS `font` shorthand without stretch: `italic 700 24px Inter, Arial`. */
  font: string
  /** `font-stretch` in percent (100 = normal). */
  stretch: number
  /** CSS colour of the glyphs. */
  color: string
  /** px; 0 = none. */
  letterSpacing: number
  /** Advance of the run as laid out, CSS px. */
  width: number
  /** Right-to-left run (drawn with `direction = 'rtl'` from its right edge). */
  rtl?: boolean
  /**
   * Words at the positions the layout gave them (offsets from `x`); absent: the
   * run is drawn as one string. See `readRuns.ts` → word positions.
   */
  parts?: Array<{ text: string; dx: number }>
  /** `-webkit-text-stroke`, painted under the fill (`paint-order: stroke`). */
  stroke?: { width: number; color: string }
}

/**
 * An underline as laid out, before the engine's rules place it: the decorated
 * text fragment (one per line and text node), and the decorating box's font
 * whose metrics put the line (`paintRuns.ts` → `underlineGeometry`, per
 * engine). The line skips the ink of the runs drawn for that fragment.
 */
export interface Decoration {
  /** Left edge and advance of the decorated fragment, CSS px. */
  x: number
  width: number
  /** Top of the fragment's content area (where its ascent starts), CSS px. */
  top: number
  /** The decorating box's used font size, px. */
  fontSize: number
  /** The decorating box's font (CSS `font` shorthand): its metrics place the line. */
  font: string
  /** That font's ascent / descent as the layout rounded them, CSS px. */
  ascent: number
  descent: number
  /** `text-decoration-color`, resolved. */
  color: string
  /** Indices into `runs` of the glyphs the line skips (`text-decoration-skip-ink: auto`). */
  runs: number[]
}

/** A text laid out: what a raster needs and what the renderer measures. */
export interface TextRunLayout {
  /** Content width / height as Pixi's `measureHtmlText` reports them (padding excluded). */
  width: number
  height: number
  /** HTMLTextStyle padding, CSS px. */
  padding: number
  runs: GlyphRun[]
  decorations: Decoration[]
  /**
   * Set when the text holds something the run painter cannot draw as the
   * engine does: the raster then falls back to Pixi's HTMLText for this text
   * (the bounds still come from this layout, which is the same layout).
   */
  unsupported?: string
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
const STRETCH_KEYWORDS: ReadonlyMap<number, CanvasFontStretch> = new Map<number, CanvasFontStretch>(
  [
    [50, 'ultra-condensed'],
    [62.5, 'extra-condensed'],
    [75, 'condensed'],
    [87.5, 'semi-condensed'],
    [100, 'normal'],
    [112.5, 'semi-expanded'],
    [125, 'expanded'],
    [150, 'extra-expanded'],
    [200, 'ultra-expanded'],
  ],
)

/** The canvas keyword for a width, or undefined when Canvas2D cannot express it. */
export function stretchKeyword(percent: number): CanvasFontStretch | undefined {
  return STRETCH_KEYWORDS.get(percent)
}
