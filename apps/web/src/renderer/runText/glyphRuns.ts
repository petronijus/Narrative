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
   * Where the raster goes (paint only; `placeLayout`): the runs and
   * decorations are then in the canvas's world coordinates (CSS px), the
   * raster's pixel (0, 0) is world device pixel `device` (whole), and CSS-px
   * roundings (baselines, underline positions) are taken from `css`, the
   * world position of the page's own coordinates (the slide's 0, 0), where
   * the page rounds the same text. Absent: the raster's own coordinates.
   */
  place?: RasterPlace
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

/** A placed raster's frame (`TextRunLayout.place`). */
export interface RasterPlace {
  /** The raster's (0, 0) in device px of the space (see `outer`): texel = resolution × p − device. */
  device: { x: number; y: number }
  /** The page's CSS-px rounding origin, in the space's coordinates. */
  css: { x: number; y: number }
  /**
   * The page rounds baselines (and WebKit its decoration origins) to 1 /
   * `unit` px of the space: WebKit to a device px of it (`unit` = the
   * device pixel ratio), Blink to a whole px. Default 1.
   */
  unit?: number
  /**
   * The page takes a float position as a LayoutUnit by truncating it before
   * it rounds (WebKit: `LayoutUnit { textOrigin.y() }` in
   * TextBoxPainter::textOriginFromPaintRect — a baseline at 1137.496 is
   * 1137.484, drawn at 1137, where rounding to the nearest LayoutUnit made it
   * 1137.5 and 1138: Georgia italic, a device row off at the fitted zoom).
   * Blink's positions are LayoutUnits already: the nearest one.
   */
  truncate?: boolean
  /**
   * A turn or flip the raster is painted through, after the scale
   * (pagePlacement.ts: a turned or flipped box drawn in device px): texel =
   * outer × (resolution × p − device). Absent: upright.
   */
  outer?: [number, number, number, number, number, number]
  /** The layout's raster rectangle in the space: nothing is painted outside it (as Pixi's raster is cut). */
  clip?: { x: number; y: number; width: number; height: number }
}

/**
 * `v` as the page holds it, a LayoutUnit (1/64 px) of its coordinates: a
 * position summed in floating point lands a hair beside the page's, and at
 * a half the rounding below then goes the other way (a line a whole px off,
 * measured).
 */
function layoutUnit(v: number, truncate = false): number {
  // WebKit's LayoutUnit(float) truncates (a 1/64 off the float sum's noise first).
  return truncate ? Math.floor(v * 64 + 1e-6) / 64 : Math.round(v * 64) / 64
}

/**
 * `v` rounded to 1 / `unit` CSS px of the page's coordinates (`place.css`;
 * none: the layout's own; `place.unit`, a whole px by default).
 */
export function roundCss(v: number, origin = 0, unit = 1, truncate = false): number {
  return Math.round(layoutUnit(v - origin, truncate) * unit) / unit + origin
}

/** `v` floored to 1 / `unit` CSS px of the page's coordinates. */
export function floorCss(v: number, origin = 0, unit = 1): number {
  return Math.floor(layoutUnit(v - origin) * unit) / unit + origin
}

/**
 * `layout` placed for a raster whose top-left lands at `top` (world CSS px)
 * and whose quad's corner is moved onto the device pixel `round(top ×
 * deviceResolution)` (runTextSystem: the texture's trim). Its runs and
 * decorations are moved into the space the page rounds them in, so the
 * painter rounds where the page rounds the same text (ADR 0018 → Placement):
 *
 *   - an upright text at scale 1: the world, CSS px rounded from
 *     `pageOrigin` (the slide's 0, 0);
 *   - a scaled one (`frame`: a shrunk autofit box, drawn as the edit overlay
 *     draws it — laid out at `width / scale` and scaled): the frame's own
 *     units from its corner, where the page rounds inside a transformed box.
 *
 * `resolution` is the raster's (texels per unit of that space); the texel
 * grid lies on the device grid, at a fraction of a texel from the space's
 * origin when scaled (`place.device`).
 */
export function placeLayout(
  layout: TextRunLayout,
  top: { x: number; y: number },
  resolution: number,
  pageOrigin: { x: number; y: number } = { x: 0, y: 0 },
  /** Where the content sits in the raster beyond its corner (raster units; placement.ts → rasterTop `shift`). */
  shift: { x: number; y: number } = { x: 0, y: 0 },
  /** A scaled text: its frame's corner (world) and scale, and the canvas's device px per world px. */
  frame?: { origin: { x: number; y: number }; scale: number; deviceResolution: number },
  /** The canvas's texel-grid phase (world px × resolution; placement.ts → gridPhaseOf). */
  phase: { x: number; y: number } = { x: 0, y: 0 },
  /** The page rounds baselines to 1 / `unit` px (RasterPlace.unit). */
  unit = 1,
  /** The page truncates positions to LayoutUnits (RasterPlace.truncate). */
  truncate = false,
  /**
   * The corner of the text's box (world): the page holds the box's CSS
   * position as a LayoutUnit — WebKit truncating it — and lays the text out
   * from there in floats. Default: the raster's corner taken as a whole.
   */
  box: { x: number; y: number; width?: number; anchor?: number } | null = null,
): TextRunLayout {
  // The page's positions are LayoutUnits (1/64 px): a corner computed in
  // floating point a hair under a half rounds a baseline down where the page
  // rounds it up (one line of a bottom-aligned box a whole px off, measured).
  const onLayoutUnits = (v: number, o: number): number => Math.round((v - o) * 64) / 64 + o
  const scale = frame?.scale ?? 1
  const deviceResolution = frame?.deviceResolution ?? resolution
  // The raster's corner in the rounding space, and the space's own origin.
  const space = frame?.origin ?? { x: 0, y: 0 }
  const css = frame === undefined ? pageOrigin : { x: 0, y: 0 }
  const u0 = { x: (top.x - space.x) / scale, y: (top.y - space.y) / scale }
  // The box's position as the page holds it, the text's place in the box as
  // it is: WebKit truncates a CSS length to a LayoutUnit (430.3 px is
  // 430.296875), and rounding the whole sum instead put glyphs 1/64 px apart —
  // at 400 % a glyph a whole device px off where its position rounds.
  // (Blink: the whole sum to the nearest LayoutUnit, as measured.)
  const boxUnit = (v: number, o: number): number => Math.floor((v - o) * 64 + 1e-6) / 64 + o
  const at =
    box === null || frame !== undefined || !truncate
      ? {
          x: onLayoutUnits(u0.x + shift.x, css.x),
          y: onLayoutUnits(u0.y + shift.y, css.y),
        }
      : {
          // A text anchored at the box's right (or middle) is placed from the
          // box's width, which the page holds as a LayoutUnit too.
          x:
            boxUnit(box.x, css.x) +
            (box.anchor ?? 0) * (boxUnit(box.width ?? 0, 0) - (box.width ?? 0)) +
            (u0.x + shift.x - box.x),
          y: boxUnit(box.y, css.y) + (u0.y + shift.y - box.y),
        }
  // texel(u) = device(u) − D, device(u) = top·dr + (u − u0)·resolution.
  const onGrid = (v: number, p: number): number => Math.round(v - p) + p
  const device = {
    x: u0.x * resolution - top.x * deviceResolution + onGrid(top.x * deviceResolution, phase.x),
    y: u0.y * resolution - top.y * deviceResolution + onGrid(top.y * deviceResolution, phase.y),
  }
  return {
    ...layout,
    runs: layout.runs.map((r) => ({ ...r, x: r.x + at.x, y: r.y + at.y })),
    decorations: layout.decorations.map((d) => ({ ...d, x: d.x + at.x, top: d.top + at.y })),
    place: { device, css, unit, ...(truncate ? { truncate } : {}) },
  }
}
