/**
 * renderer/runText/decorations.ts — underlines as the engine draws them
 * (ADR 0018, decorations). Worker-safe: Canvas2D only, no DOM.
 *
 * No API reports where an engine puts an underline or how thick it is, so
 * the rules are the engines' own, read from their sources (and held to by the
 * parity specs, e2e/text-runs-*.spec.ts):
 *
 * Chromium (Blink, 156: `TextDecorationThickness::Resolve`,
 * `TextDecorationOffset::ComputeUnderlineOffsetAuto`,
 * `DecorationLinePainter::DrawLineAsRect`, `TextPainter::ClipDecorationLine`)
 *   - thickness `auto` = font size / 10, at least 1;
 *   - offset from the text's top = the font's rounded ascent + a gap of
 *     max(1, ⌈thickness / 2⌉), as an integer;
 *   - painted with the top rounded and the height floored (at least 1) in the
 *     text's own coordinates — CSS px of the layout; the SVG raster's
 *     `scale(r)` then scales the snapped line (so does a CSS `scale()` on
 *     the page: the band is antialiased at a fractional zoom);
 *   - ink skip: where the glyph outlines cross the line (its unsnapped rect
 *     inset by ½ px, relative to the baseline at the font's unrounded
 *     ascent), the line is clipped out (not antialiased) by the crossing
 *     widened by min(thickness, 13) on each side.
 *
 * WebKit (`InlineTextBoxStyle::computedUnderlineOffset`,
 * `TextDecorationThickness::resolve`, `TextDecorationPainter::
 * paintBackgroundDecorations`, `GraphicsContext::
 * computeLineBoundsAndAntialiasingModeForText`)
 *   - thickness `auto` = font size / 16;
 *   - offset = the font's ascent + a gap of max(1, ⌈font size / 16 / 2⌉);
 *   - the line's origin rounded to whole px, then in device px its top
 *     rounded up and its left rounded; the height is not snapped (at least
 *     ½); below a scale of 1 the colour is faded by the scale (at least 0.4);
 *   - ink skip: per glyph, the extent of its outline inside the line; each
 *     widened by min(the line's height, the font's height / 5) and subtracted
 *     from the line, which is drawn as the rectangles left.
 *
 * The outline crossings are found on the glyphs themselves, drawn into a
 * mask `INK_SAMPLES` times finer than the layout's CSS px across the line's
 * rows (`inkSpans`): columns with half coverage or more are inside.
 */

import {
  floorCss,
  roundCss,
  type Decoration,
  type GlyphRun,
  type RasterPlace,
} from './glyphRuns.js'

/** Which engine's rules an underline follows. */
export type DecorationRules = 'chromium' | 'webkit'

/** Mask columns per CSS px the ink crossings are found at (at least). */
export const INK_SAMPLES = 16

/**
 * Mask columns per CSS px for a raster at `resolution`: 8 per device px, so
 * a crossing lands within ⅛ device px of the glyph's outline at any zoom
 * (the engines intersect the outlines exactly; 16 per CSS px put a gap's
 * edge ½ device px off at 400 % and DPR 2 — a device column of underline
 * the page skips, 0.96 px on a line's centre, u-small).
 */
function inkSamples(resolution: number): number {
  return Math.max(INK_SAMPLES, Math.ceil(resolution * 8))
}

/** Blink's `kDecorationClipMaxDilation`. */
const CHROMIUM_MAX_DILATION = 13

/** A horizontal span, CSS px of the layout. */
export interface Span {
  begin: number
  end: number
}

/** The 2D context surface both canvases share. */
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/**
 * A run's glyphs one by one, as the painter places them: each grapheme's text
 * and the x of its origin (CSS px of the layout), with `ctx` set to the run's
 * type. CJK is left out (both engines draw an underline through it).
 */
export type GlyphsOf = (
  ctx: Ctx,
  run: GlyphRun,
) => Array<{ text: string; x: number; width: number }>

/** Set a run's type (font, width, spacing) on a context. */
export type SetType = (ctx: Ctx, run: GlyphRun) => void

const MAX_MASK_WIDTH = 4096

/** Make a scratch 2D context of `width` × `height` px (OffscreenCanvas, worker or page). */
export type ScratchContext = (width: number, height: number) => OffscreenCanvasRenderingContext2D

/**
 * Where the glyphs of `runs` have ink between `top` and `bottom` (CSS px
 * relative to each run's baseline): one span per glyph from its leftmost to
 * its rightmost ink in the band — as the engines intersect each glyph's
 * outline with the line (Skia's glyph intercepts, WebKit's per-glyph path
 * extents), so the two legs of a "g" make one span, not two with a sliver of
 * line between them. `bottom === top` samples the one line `top`.
 */
export function inkSpans(
  runs: readonly GlyphRun[],
  top: number,
  bottom: number,
  scratch: ScratchContext,
  glyphsOf: GlyphsOf,
  setType: SetType,
  samples = INK_SAMPLES,
): Span[] {
  const spans: Span[] = []
  for (const run of runs) {
    const size = fontSizeOf(run.font)
    // Glyphs reach past their advance (italics, overhangs): an em each side.
    const margin = Math.max(4, size)
    const glyphs = glyphsOf(scratch(1, 1), run)
    for (const g of glyphs) {
      const left = g.x - margin
      // Fewer samples for a glyph the mask cannot hold at `samples` (a large
      // glyph zoomed in): a mask cut short found its crossings in the wrong
      // place (u-big at 400 %, DPR 2).
      const glyphSamples = Math.min(samples, MAX_MASK_WIDTH / (g.width + 2 * margin))
      const columns = Math.ceil((g.width + 2 * margin) * glyphSamples)
      const rows = Math.max(1, Math.ceil((bottom - top) * glyphSamples))
      const y0 = bottom === top ? top - 0.5 / glyphSamples : top
      // Resizing the scratch canvas resets its state: the type is set again.
      const ctx = scratch(columns, rows)
      setType(ctx, run)
      ctx.clearRect(0, 0, columns, rows)
      ctx.fillStyle = '#000'
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'
      ctx.setTransform(glyphSamples, 0, 0, glyphSamples, -left * glyphSamples, -y0 * glyphSamples)
      ctx.fillText(g.text, g.x, 0)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      const px = ctx.getImageData(0, 0, columns, rows).data
      let first = -1
      let last = -1
      for (let x = 0; x < columns; x++) {
        for (let y = 0; y < rows; y++) {
          if (px[(y * columns + x) * 4 + 3]! >= 128) {
            if (first < 0) first = x
            last = x
            break
          }
        }
      }
      if (first >= 0)
        spans.push({ begin: left + first / glyphSamples, end: left + (last + 1) / glyphSamples })
    }
  }
  return spans.sort((a, b) => a.begin - b.begin)
}

function fontSizeOf(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/u.exec(font)
  return m === null ? 16 : Number.parseFloat(m[1]!)
}

/** Font metrics a painter reads off its own canvas (the unrounded ascent and descent). */
export interface FontMetricsSource {
  ascent(font: string): number
  descent(font: string): number
}

/**
 * Paint `layout`'s underlines into `ctx` (its transform: CSS px of the layout
 * scaled by `resolution`), before the glyphs, as `rules`' engine does.
 */
export function paintUnderlines(
  ctx: Ctx,
  decorations: readonly Decoration[],
  runs: readonly GlyphRun[],
  resolution: number,
  rules: DecorationRules,
  scratch: ScratchContext,
  glyphsOf: GlyphsOf,
  setType: SetType,
  metrics: FontMetricsSource,
  /** The device pixel the canvas's (0, 0) is (a placed layout; glyphRuns.ts → placeLayout). */
  origin: DeviceOrigin = { device: { x: 0, y: 0 }, css: { x: 0, y: 0 } },
): void {
  for (const d of decorations) {
    if (d.width <= 0) continue
    const own = d.runs.map((i) => runs[i]!).filter((r) => r !== undefined)
    if (rules === 'chromium')
      paintChromium(ctx, d, own, resolution, scratch, glyphsOf, setType, metrics, origin)
    else paintWebKit(ctx, d, own, resolution, scratch, glyphsOf, setType, metrics, origin)
  }
}

/**
 * `v` (px of the layout's unit space at the resolution) rounded to a whole
 * texel of a raster whose texel 0 is at `offset` there (RasterPlace.device):
 * an upright raster's offset is whole, a scaled one's is not.
 */
function roundOnGrid(v: number, offset: number): number {
  return Math.round(v - offset) + offset
}

/**
 * A placed raster's frame: the world device pixel its (0, 0) is, and the
 * world position of the page's CSS-px rounding origin (glyphRuns.ts →
 * RasterPlace).
 */
export type DeviceOrigin = RasterPlace

/**
 * `ctx` drawing in device px of the place's space: texel = outer × (p −
 * device) (an upright raster: the device px themselves).
 */
function setDeviceTransform(ctx: Ctx, origin: DeviceOrigin): void {
  const o = origin.outer
  if (o === undefined) ctx.setTransform(1, 0, 0, 1, -origin.device.x, -origin.device.y)
  else {
    ctx.setTransform(o[0], o[1], o[2], o[3], o[4], o[5])
    ctx.transform(1, 0, 0, 1, -origin.device.x, -origin.device.y)
  }
}

/** A band of device rows and columns, drawn with the AA of its fractional edges, minus whole columns. */
function fillBand(
  ctx: Ctx,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
  resolution: number,
  clipOut: Array<[number, number]>,
  origin: DeviceOrigin,
  /** The clipped-out rows: device px, whole (the clip rects' vertical extent). */
  clipRows: [number, number],
): void {
  ctx.save()
  setDeviceTransform(ctx, origin)
  if (clipOut.length > 0) {
    // Everything but the clipped columns within the clipped rows (device px,
    // whole: Blink's clip is not antialiased). Above and below those rows the
    // band is drawn whole: a partly covered row the clip rect does not reach
    // keeps its line (the 1 px vertical outset is in the text's own px, a
    // half device px at the fitted zoom).
    const top = Math.floor(y * resolution) - 1
    const bottom = Math.ceil((y + h) * resolution) + 1
    const [c0, c1] = clipRows
    ctx.beginPath()
    if (c0 > top) ctx.rect(Math.floor(x * resolution) - 1, top, (w + 2) * resolution + 2, c0 - top)
    if (bottom > c1)
      ctx.rect(Math.floor(x * resolution) - 1, c1, (w + 2) * resolution + 2, bottom - c1)
    let at = Math.floor(x * resolution) - 1
    const end = Math.ceil((x + w) * resolution) + 1
    for (const [l, r] of clipOut) {
      if (l > at) ctx.rect(at, c0, l - at, c1 - c0)
      at = Math.max(at, r)
    }
    if (end > at) ctx.rect(at, c0, end - at, c1 - c0)
    ctx.clip()
  }
  ctx.fillStyle = color
  ctx.fillRect(x * resolution, y * resolution, w * resolution, h * resolution)
  ctx.restore()
}

/** Merge device-column spans (sorted, overlapping or touching merged). */
function mergeColumns(spans: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && s[0] <= last[1]) last[1] = Math.max(last[1], s[1])
    else out.push([s[0], s[1]])
  }
  return out
}

/** Where Blink puts an underline (CSS px of the layout; see the module comment). */
export function chromiumUnderline(
  d: Pick<Decoration, 'top' | 'fontSize' | 'ascent'>,
  floatAscent: number,
  /** The page's CSS-px rounding origin, y (RasterPlace.css). */
  cssY = 0,
): {
  thickness: number
  /** The line as laid out (unsnapped top). */
  lineY: number
  /** The line as painted: top rounded, height floored. */
  paintY: number
  paintH: number
  /** The ink-skip band, relative to the baseline at the unrounded ascent. */
  inkTop: number
  inkBottom: number
  dilation: number
} {
  const thickness = Math.max(1, d.fontSize / 10)
  const gap = Math.max(1, Math.ceil(thickness / 2))
  const offset = Math.trunc(d.ascent + gap)
  const lineY = d.top + offset
  const inkTop = lineY + 0.5 - (d.top + floatAscent)
  return {
    thickness,
    lineY,
    paintY: floorCss(lineY + 0.5, cssY),
    paintH: Math.max(Math.floor(thickness), 1),
    inkTop,
    inkBottom: inkTop + Math.max(0, thickness - 1),
    dilation: Math.min(thickness, CHROMIUM_MAX_DILATION),
  }
}

function paintChromium(
  ctx: Ctx,
  d: Decoration,
  runs: readonly GlyphRun[],
  resolution: number,
  scratch: ScratchContext,
  glyphsOf: GlyphsOf,
  setType: SetType,
  metrics: FontMetricsSource,
  origin: DeviceOrigin,
): void {
  const g = chromiumUnderline(d, metrics.ascent(d.font), origin.css.y)
  const { paintY, paintH, dilation } = g
  const clipOut: Array<[number, number]> = []
  if (runs.length > 0) {
    for (const s of inkSpans(
      runs,
      g.inkTop,
      g.inkBottom,
      scratch,
      glyphsOf,
      setType,
      inkSamples(resolution),
    )) {
      // Skia rounds a non-antialiased clip rect to whole device px.
      clipOut.push([
        // On the raster's own pixel grid (whole texels): the device grid.
        roundOnGrid((s.begin - dilation) * resolution, origin.device.x),
        roundOnGrid((s.end + dilation) * resolution, origin.device.x),
      ])
    }
  }
  // Blink's clip rects: the line's own rectangle (unsnapped) outset by 1 px
  // of the text's own space less the ½ px it was inset by (TextPainter →
  // ClipDecorationsStripe), rounded to whole device rows.
  const clipRows: [number, number] = [
    roundOnGrid((g.lineY - 0.5) * resolution, origin.device.y),
    roundOnGrid((g.lineY + g.thickness + 0.5) * resolution, origin.device.y),
  ]
  fillBand(
    ctx,
    d.color,
    d.x,
    paintY,
    d.width,
    paintH,
    resolution,
    mergeColumns(clipOut),
    origin,
    clipRows,
  )
}

/** Where WebKit puts an underline (CSS px of the layout, snapped for `resolution`). */
export function webkitUnderline(
  d: Pick<Decoration, 'x' | 'top' | 'fontSize'>,
  ascent: number,
  resolution: number,
  /** The page's CSS-px rounding origin (RasterPlace.css). */
  css: { x: number; y: number } = { x: 0, y: 0 },
  /** Where the raster's texels lie on the device px of `resolution` (RasterPlace.device). */
  grid: { x: number; y: number } = { x: 0, y: 0 },
  /** The page's device pixel ratio: what roundPointToDevicePixels rounds to (RasterPlace.unit). */
  unit = 1,
  /** LayoutUnits by truncation (RasterPlace.truncate). */
  truncate = false,
): { x: number; y: number; h: number } {
  // A sixteenth of the size, ceiled to a device px of the text's own space
  // (TextBoxPainter → resolveTextDecorationThicknessForPaintingBox).
  const thickness = Math.ceil(layoutUnitTrunc(d.fontSize / 16) * unit - 1e-9) / unit
  const gap = Math.max(1, Math.ceil(d.fontSize / 16 / 2))
  // roundPointToDevicePixels in the text's own space (to 1 / the device
  // pixel ratio of its px), then the line bounds in device px: top rounded
  // up, left rounded.
  const ox = roundCss(d.x, css.x, unit, truncate)
  const oy = roundCss(d.top + ascent + gap, css.y, unit, truncate)
  return {
    x: roundOnGrid(ox * resolution, grid.x) / resolution,
    y: (Math.ceil(oy * resolution - grid.y) + grid.y) / resolution,
    h: Math.max(thickness, 0.5),
  }
}

function paintWebKit(
  ctx: Ctx,
  d: Decoration,
  runs: readonly GlyphRun[],
  resolution: number,
  scratch: ScratchContext,
  glyphsOf: GlyphsOf,
  setType: SetType,
  metrics: FontMetricsSource,
  origin: DeviceOrigin,
): void {
  // The font's unrounded ascent (readRuns: FontBox.paintAscent), as WebKit
  // offsets the line from it; the canvas's own reports it rounded.
  const ascent = d.ascent
  const { x, y, h } = webkitUnderline(
    d,
    ascent,
    resolution,
    origin.css,
    origin.device,
    origin.unit ?? 1,
    origin.truncate === true,
  )
  let color = d.color
  if (resolution < 1) color = fadeColor(color, Math.max(resolution, 0.4))
  // The line's segments left once each glyph's crossing, widened, is taken out.
  let segments: Span[] = [{ begin: 0, end: d.width }]
  if (runs.length > 0) {
    // The glyphs' crossings are found where they are drawn (WebKit passes the
    // text origin): on the baseline the painter draws them at.
    const baselineY = roundCss(
      d.top + d.ascent,
      origin.css.y,
      origin.unit ?? 1,
      origin.truncate === true,
    )
    const fontHeight = d.ascent + d.descent
    const dilation = Math.min(h, fontHeight / 5)
    for (const s of inkSpans(
      runs,
      y - baselineY,
      y + h - baselineY,
      scratch,
      glyphsOf,
      setType,
      inkSamples(resolution),
    )) {
      segments = subtract(segments, s.begin - x - dilation, s.end - x + dilation)
    }
  }
  ctx.save()
  setDeviceTransform(ctx, origin)
  ctx.fillStyle = color
  for (const s of segments) {
    if (s.end <= s.begin) continue
    ctx.fillRect(
      (x + s.begin) * resolution,
      y * resolution,
      (s.end - s.begin) * resolution,
      h * resolution,
    )
  }
  ctx.restore()
}

/** `v` as WebKit's LayoutUnit(float) holds it: truncated to 1/64. */
function layoutUnitTrunc(v: number): number {
  return Math.floor(v * 64 + 1e-6) / 64
}

/** `spans` minus [from, to]. */
export function subtract(spans: Span[], from: number, to: number): Span[] {
  const out: Span[] = []
  for (const s of spans) {
    if (to <= s.begin || from >= s.end) {
      out.push(s)
      continue
    }
    if (from > s.begin) out.push({ begin: s.begin, end: from })
    if (to < s.end) out.push({ begin: to, end: s.end })
  }
  return out
}

/** A CSS colour with its alpha multiplied (rgb()/rgba() as computed styles write them). */
export function fadeColor(color: string, factor: number): string {
  const m = /^rgba?\(([^)]+)\)$/u.exec(color.trim())
  if (m === null) return color
  const parts = m[1]!.split(/[\s,/]+/u).filter((p) => p !== '')
  const [r, g, b] = parts
  const a = parts[3] === undefined ? 1 : Number.parseFloat(parts[3])
  return `rgba(${r}, ${g}, ${b}, ${a * factor})`
}
