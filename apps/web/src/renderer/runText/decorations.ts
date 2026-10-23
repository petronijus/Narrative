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
 *     `scale(r)` then scales the snapped line;
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

import type { Decoration, GlyphRun } from './glyphRuns.js'

/** Which engine's rules an underline follows. */
export type DecorationRules = 'chromium' | 'webkit'

/** Mask columns per CSS px the ink crossings are found at. */
export const INK_SAMPLES = 16

/** Blink's `kDecorationClipMaxDilation`. */
const CHROMIUM_MAX_DILATION = 13

/** A horizontal span, CSS px of the layout. */
export interface Span {
  begin: number
  end: number
}

/** The 2D context surface both canvases share. */
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/** Draw a run's glyphs (fill) with the baseline at `baseline` — the painter's own placement. */
export type DrawGlyphs = (ctx: Ctx, run: GlyphRun, baseline: number) => void

/** Make a scratch 2D context of `width` × `height` px (OffscreenCanvas, worker or page). */
export type ScratchContext = (width: number, height: number) => OffscreenCanvasRenderingContext2D

const MAX_MASK_WIDTH = 4096

/**
 * Where the glyphs of `runs` have ink between `top` and `bottom` (CSS px
 * relative to each run's baseline), as spans in CSS px of the layout,
 * merged where they touch. `bottom === top` samples the one line `top`.
 */
export function inkSpans(
  runs: readonly GlyphRun[],
  top: number,
  bottom: number,
  scratch: ScratchContext,
  draw: DrawGlyphs,
  samples = INK_SAMPLES,
): Span[] {
  if (runs.length === 0) return []
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  for (const run of runs) {
    // Glyphs reach past their advance (italics, overhangs): a margin of an em-ish.
    const margin = Math.max(4, fontSizeOf(run.font))
    left = Math.min(left, run.x - margin)
    right = Math.max(right, run.x + run.width + margin)
  }
  const rows = Math.max(1, Math.ceil((bottom - top) * samples))
  const columns = Math.ceil((right - left) * samples)
  const ink = new Uint8Array(columns)
  for (let from = 0; from < columns; from += MAX_MASK_WIDTH) {
    const w = Math.min(MAX_MASK_WIDTH, columns - from)
    const ctx = scratch(w, rows)
    ctx.clearRect(0, 0, w, rows)
    ctx.fillStyle = '#000'
    // Mask px = (layout px − left) × samples − from; rows from `top`. With a
    // zero-height band the one row is centred on it.
    const y0 = bottom === top ? top - 0.5 / samples : top
    ctx.setTransform(samples, 0, 0, samples, -left * samples - from, -y0 * samples)
    for (const run of runs) draw(ctx, run, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const px = ctx.getImageData(0, 0, w, rows).data
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3]! >= 128) ink[from + x] = 1
      }
    }
  }
  const spans: Span[] = []
  for (let x = 0; x < columns; x++) {
    if (ink[x] === 0) continue
    const begin = x
    while (x + 1 < columns && ink[x + 1] === 1) x++
    spans.push({ begin: left + begin / samples, end: left + (x + 1) / samples })
  }
  return spans
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
  draw: DrawGlyphs,
  metrics: FontMetricsSource,
): void {
  for (const d of decorations) {
    if (d.width <= 0) continue
    const own = d.runs.map((i) => runs[i]!).filter((r) => r !== undefined)
    if (rules === 'chromium') paintChromium(ctx, d, own, resolution, scratch, draw, metrics)
    else paintWebKit(ctx, d, own, resolution, scratch, draw, metrics)
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
): void {
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (clipOut.length > 0) {
    // Everything but the clipped columns (device px, whole: Blink's clip is not antialiased).
    const top = Math.floor(y * resolution) - 1
    const bottom = Math.ceil((y + h) * resolution) + 1
    ctx.beginPath()
    let at = Math.floor(x * resolution) - 1
    const end = Math.ceil((x + w) * resolution) + 1
    for (const [l, r] of clipOut) {
      if (l > at) ctx.rect(at, top, l - at, bottom - top)
      at = Math.max(at, r)
    }
    if (end > at) ctx.rect(at, top, end - at, bottom - top)
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
    paintY: Math.floor(lineY + 0.5),
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
  draw: DrawGlyphs,
  metrics: FontMetricsSource,
): void {
  const g = chromiumUnderline(d, metrics.ascent(d.font))
  const { paintY, paintH, dilation } = g
  const clipOut: Array<[number, number]> = []
  if (runs.length > 0) {
    for (const s of inkSpans(runs, g.inkTop, g.inkBottom, scratch, draw)) {
      // Skia rounds a non-antialiased clip rect to whole device px.
      clipOut.push([
        Math.round((s.begin - dilation) * resolution),
        Math.round((s.end + dilation) * resolution),
      ])
    }
  }
  fillBand(ctx, d.color, d.x, paintY, d.width, paintH, resolution, mergeColumns(clipOut))
}

/** Where WebKit puts an underline (CSS px of the layout, snapped for `resolution`). */
export function webkitUnderline(
  d: Pick<Decoration, 'x' | 'top' | 'fontSize'>,
  ascent: number,
  resolution: number,
): { x: number; y: number; h: number } {
  const thickness = d.fontSize / 16
  const gap = Math.max(1, Math.ceil(d.fontSize / 16 / 2))
  // roundPointToDevicePixels in the text's own space (its device scale is 1),
  // then the line bounds in device px: top rounded up, left rounded.
  const ox = Math.round(d.x)
  const oy = Math.round(d.top + ascent + gap)
  return {
    x: Math.round(ox * resolution) / resolution,
    y: Math.ceil(oy * resolution) / resolution,
    h: Math.max(thickness, 0.5),
  }
}

function paintWebKit(
  ctx: Ctx,
  d: Decoration,
  runs: readonly GlyphRun[],
  resolution: number,
  scratch: ScratchContext,
  draw: DrawGlyphs,
  metrics: FontMetricsSource,
): void {
  const ascent = metrics.ascent(d.font)
  const { x, y, h } = webkitUnderline(d, ascent, resolution)
  let color = d.color
  if (resolution < 1) color = fadeColor(color, Math.max(resolution, 0.4))
  // The line's segments left once each glyph's crossing, widened, is taken out.
  let segments: Span[] = [{ begin: 0, end: d.width }]
  if (runs.length > 0) {
    // The glyphs' crossings are found where they are drawn (WebKit passes the
    // text origin): on the baseline the painter draws them at.
    const baselineY = Math.round(d.top + d.ascent)
    const fontHeight = ascent + metrics.descent(d.font)
    const dilation = Math.min(h, fontHeight / 5)
    for (const s of inkSpans(runs, y - baselineY, y + h - baselineY, scratch, draw)) {
      segments = subtract(segments, s.begin - x - dilation, s.end - x + dilation)
    }
  }
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
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
