/**
 * renderer/runText/paintRuns.ts — draw a text's glyph runs with Canvas2D
 * (ADR 0018). Runs in a text raster worker (`textRasterWorker.ts`) or, where
 * a worker cannot paint, on the main thread (`textRasterPool.ts`); it touches
 * nothing but the context it is given.
 *
 * Mirrors what HTMLText's SVG raster does with the same layout: the layout in
 * CSS px scaled by the resolution from the top left (`transform: scale(r)` in
 * Pixi's `getSVGUrl`), the stroke painted under the fill (`paint-order:
 * stroke`), underlines under the glyphs, cut where the glyphs cross them
 * (decorations.ts).
 */

import { paintUnderlines, type FontMetricsSource, type ScratchContext } from './decorations.js'
import {
  roundCss,
  stretchKeyword,
  type GlyphRun,
  type RasterPlace,
  type TextRunLayout,
} from './glyphRuns.js'
import type { PaintRules } from './protocol.js'

/** The 2D context surface both canvases share (lib.dom types them apart). */
export type Paint2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/** Two LayoutUnits: what a layout position and a float pen may differ by without a kerning pair. */
const SNAP = 2 / 64

/** A font string the context cannot parse leaves the previous font set; this one never is a run's. */
const SENTINEL_FONT = '1px __narrative_no_font__'

/** Thrown when a run's font cannot be set: the paint would draw it in another face. */
export class UnpaintableRunError extends Error {}

/** What drawing decorations needs besides the target context (scratch masks, font metrics). */
export interface PaintSupport {
  scratch: ScratchContext
}

/** A scratch context factory over one reusable OffscreenCanvas. */
export function offscreenScratch(): ScratchContext {
  let canvas: OffscreenCanvas | null = null
  let ctx: OffscreenCanvasRenderingContext2D | null = null
  return (width, height) => {
    if (canvas === null) {
      canvas = new OffscreenCanvas(width, height)
      ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx === null) throw new UnpaintableRunError('no scratch 2d context')
    } else {
      canvas.width = width
      canvas.height = height
    }
    return ctx!
  }
}

/** Set everything of a run's type on `ctx` (font, width, spacing); throws where the canvas cannot. */
function setRunType(ctx: Paint2D, run: GlyphRun): void {
  setFont(ctx, run.font)
  if ('fontStretch' in ctx) {
    const keyword = stretchKeyword(run.stretch)
    if (keyword === undefined) throw new UnpaintableRunError(`font-stretch ${run.stretch}%`)
    ctx.fontStretch = keyword
  } else if (run.stretch !== 100) {
    throw new UnpaintableRunError(`font-stretch ${run.stretch}%`)
  }
  // Without `letterSpacing` on the context (WebKit) a spaced run is drawn
  // grapheme by grapheme (drawRun → drawSpaced).
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${run.letterSpacing}px`
  // The page lays text out with `text-rendering: auto`, which kerns at every
  // length; a canvas's `auto` stops kerning a longer string (Chromium 2026-10:
  // Arial's "— AV Ta WA To 0123" at 22 px 210.31 px wide on the canvas,
  // 207.09 laid out; Times New Roman 201.22 vs 197.22, its kerned pairs up
  // to a px off). `optimizeLegibility` measured the layout's width for every
  // probe within 0.02 px.
  if ('textRendering' in ctx) ctx.textRendering = 'optimizeLegibility'
}

/** Whether `ctx` spaces letters itself. */
function spacesLetters(ctx: Paint2D): boolean {
  return 'letterSpacing' in ctx
}

const graphemes =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

/**
 * A letter-spaced string on a canvas that cannot space letters: each grapheme
 * where the layout put it — the advance of the text before it (measured
 * whole, so kerning between earlier pairs stays) plus the spacing after each
 * grapheme before it (CSS adds it after every typographic character). With
 * letter spacing a layout applies no optional ligatures, so graphemes drawn
 * apart are the glyphs it drew.
 */
function drawSpaced(
  draw: (text: string, x: number) => void,
  measure: (text: string) => number,
  text: string,
  x: number,
  spacing: number,
): void {
  if (graphemes === null) throw new UnpaintableRunError('letter-spacing without Intl.Segmenter')
  let n = 0
  for (const { segment, index } of graphemes.segment(text)) {
    if (segment.trim() !== '') draw(segment, x + measure(text.slice(0, index)) + n * spacing)
    n++
  }
}

/**
 * Set `ctx`'s transform to a place's space at `resolution`: texel = outer ×
 * (resolution × p − device) (glyphRuns.ts → RasterPlace; an unplaced layout:
 * its own px scaled).
 */
export function setPlaceTransform(
  ctx: Paint2D,
  place: RasterPlace | undefined,
  resolution: number,
): void {
  const o = place?.outer
  if (o === undefined) ctx.setTransform(1, 0, 0, 1, 0, 0)
  else ctx.setTransform(o[0], o[1], o[2], o[3], o[4], o[5])
  ctx.transform(resolution, 0, 0, resolution, -(place?.device.x ?? 0), -(place?.device.y ?? 0))
}

/** Paint `layout` at `resolution` into `ctx` (its canvas: the raster, transparent around it). */
export function paintRuns(
  ctx: Paint2D,
  layout: TextRunLayout,
  resolution: number,
  rules: PaintRules,
  support?: PaintSupport,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.textBaseline = 'alphabetic'
  // A placed layout (glyphRuns.ts → placeLayout, pagePlacement.ts) is in the
  // coordinates the page rounds it in; the raster's (0, 0) is device pixel
  // `place.device` there.
  const place = layout.place
  const css = place?.css ?? { x: 0, y: 0 }
  const unit = place?.unit ?? 1
  const truncate = place?.truncate === true
  ctx.save()
  if (place?.clip !== undefined) {
    // Nothing beyond the layout's raster rectangle, as Pixi's raster is cut there.
    setPlaceTransform(ctx, place, resolution)
    ctx.beginPath()
    ctx.rect(place.clip.x, place.clip.y, place.clip.width, place.clip.height)
    ctx.clip()
  }
  if (layout.decorations.length > 0) {
    if (support === undefined) throw new UnpaintableRunError('decorations without a scratch canvas')
    const metrics: FontMetricsSource = {
      ascent(font) {
        ctx.font = font
        return ctx.measureText('').fontBoundingBoxAscent
      },
      descent(font) {
        ctx.font = font
        return ctx.measureText('').fontBoundingBoxDescent
      },
    }
    // Underlines go under the glyphs (CSS paints them first).
    setPlaceTransform(ctx, place, resolution)
    paintUnderlines(
      ctx,
      layout.decorations,
      layout.runs,
      resolution,
      rules.decorations,
      support.scratch,
      (mask, run) => glyphsOf(mask, run, rules),
      setRunType,
      metrics,
      {
        device: place?.device ?? { x: 0, y: 0 },
        css,
        unit,
        ...(truncate ? { truncate } : {}),
        ...(place?.outer !== undefined ? { outer: place.outer } : {}),
      },
    )
  }
  setPlaceTransform(ctx, place, resolution)
  for (const run of layout.runs) {
    setRunType(ctx, run)
    if (run.stroke !== undefined) {
      ctx.lineWidth = run.stroke.width
      ctx.strokeStyle = run.stroke.color
      ctx.lineJoin = 'miter'
      ctx.miterLimit = rules.strokeMiterLimit
      drawRun(ctx, run, 'stroke', rules, undefined, css.y, unit, truncate)
    }
    ctx.fillStyle = run.color
    drawRun(ctx, run, 'fill', rules, undefined, css.y, unit, truncate)
  }
  ctx.restore()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

/**
 * CJK ideographs and symbols: an underline is drawn straight through them
 * (Blink's `InkSkipCJKHandling::kExcludeCJK`, WebKit's `DrawOverGlyph`), so
 * they leave no ink in the skip mask.
 */
const CJK =
  /[\u2e80-\u2fdf\u2ff0-\u303f\u3040-\u31ff\u3200-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u{20000}-\u{3ffff}]+/gu

const HAS_CJK = new RegExp(CJK.source, 'u')

function setFont(ctx: Paint2D, font: string): void {
  ctx.font = SENTINEL_FONT
  ctx.font = font
  if (ctx.font.includes('__narrative_no_font__')) throw new UnpaintableRunError(`font ${font}`)
}

/**
 * A run's glyphs one by one where the painter draws them (decorations.ts →
 * ink skipping): each grapheme but spaces and CJK, its origin the whole
 * string's pen there (and the shift of its word, where the layout moved it).
 */
function glyphsOf(
  ctx: Paint2D,
  run: GlyphRun,
  rules: PaintRules,
): Array<{ text: string; x: number; width: number }> {
  setRunType(ctx, run)
  ctx.direction = 'ltr'
  if (run.rtl === true) {
    // The canvas orders a right-to-left run itself; its ink is taken whole.
    return [{ text: run.text, x: run.x, width: run.width }]
  }
  const spaced = run.letterSpacing !== 0 && !spacesLetters(ctx)
  const text = spaced ? run.text : shapedText(ctx, run.text, rules)
  const total = ctx.measureText(text).width
  const shifts = spaced ? [] : partShifts(ctx, run, text)
  const out: Array<{ text: string; x: number; width: number }> = []
  if (graphemes === null) return [{ text, x: run.x, width: total }]
  let n = 0
  for (const { segment, index } of graphemes.segment(text)) {
    if (segment.trim() !== '' && !HAS_CJK.test(segment)) {
      const pen = spaced
        ? ctx.measureText(text.slice(0, index)).width + n * run.letterSpacing
        : total - ctx.measureText(text.slice(index)).width
      const shift = shifts.find((p) => index >= p.from && index < p.to)?.shift ?? 0
      out.push({ text: segment, x: run.x + pen + shift, width: ctx.measureText(segment).width })
    }
    n++
  }
  return out
}

/** A no-break space: the same glyph as a space in nearly every font, but no word boundary to Blink's canvas. */
const NBSP = String.fromCharCode(0xa0)

/**
 * The string a run is drawn as. Blink's canvas shapes text word by word
 * (`CachingWordShaper` splits at spaces), its layout shapes the whole line:
 * kerning across a space (Arial's "A ") and contextual alternates that look
 * across one (Inter raises an em dash between figures, "3 — 1") were lost.
 * A no-break space is no word boundary there and maps to the space glyph, so
 * with `rules.shapeAcrossSpaces` the canvas shapes as the layout did — when
 * the font draws the two alike (checked per font; otherwise the spaces stay).
 */
function shapedText(ctx: Paint2D, text: string, rules: PaintRules): string {
  if (!rules.shapeAcrossSpaces || !text.includes(' ')) return text
  const font = ctx.font
  let same = nbspAlike.get(font)
  if (same === undefined) {
    same = Math.abs(ctx.measureText(' ').width - ctx.measureText(NBSP).width) < 1e-6
    nbspAlike.set(font, same)
  }
  return same ? text.replaceAll(' ', NBSP) : text
}

const nbspAlike = new Map<string, boolean>()

/**
 * Draw a run. The whole string is drawn at once (shaped in its context, as
 * the layout shaped it); where the layout put a word somewhere else than the
 * canvas's pen (more than the 1/64 px snapping apart: a kerning pair the
 * canvas does not apply, a tab stop), the string is drawn again for that word
 * moved to the layout's place, clipped to the word's stretch of the line —
 * every glyph keeps the shape its context gives it, and goes where the layout
 * put it.
 */
function drawRun(
  ctx: Paint2D,
  run: GlyphRun,
  mode: 'fill' | 'stroke',
  rules: PaintRules,
  baseline?: number,
  /** The page's CSS-px rounding origin, y (a placed layout's `place.css.y`). */
  cssY = 0,
  /** Baselines are rounded to 1 / `unit` px (a placed layout's `place.unit`). */
  unit = 1,
  /** Positions are truncated to LayoutUnits first (`place.truncate`). */
  truncate = false,
): void {
  const y = baseline ?? (rules.snapBaseline ? roundCss(run.y, cssY, unit, truncate) : run.y)
  const put = (text: string, x: number): void => {
    if (mode === 'fill') ctx.fillText(text, x, y)
    else ctx.strokeText(text, x, y)
  }
  const spaced = run.letterSpacing !== 0 && !spacesLetters(ctx)
  if (run.rtl === true) {
    // Placed from its right edge by the canvas; graphemes drawn one by one
    // would need the visual order the canvas computes.
    if (spaced) throw new UnpaintableRunError('letter-spaced right-to-left run')
    ctx.direction = 'rtl'
    ctx.textAlign = 'right'
    put(shapedText(ctx, run.text, rules), run.x + run.width)
    ctx.direction = 'ltr'
    ctx.textAlign = 'left'
    return
  }
  ctx.direction = 'ltr'
  ctx.textAlign = 'left'
  if (spaced) {
    drawSpacedRun(ctx, run, put)
    return
  }
  const text = shapedText(ctx, run.text, rules)
  if (run.parts === undefined) {
    put(text, run.x)
    return
  }
  const shifts = partShifts(ctx, run, text)
  if (shifts.every((s) => s.shift === 0)) {
    put(text, run.x)
    return
  }
  // Consecutive parts with one shift share a clip; the boundaries lie midway
  // through the gaps between words (no ink there).
  let i = 0
  while (i < shifts.length) {
    let k = i
    while (k + 1 < shifts.length && shifts[k + 1]!.shift === shifts[i]!.shift) k++
    const shift = shifts[i]!.shift
    const prev = shifts[i - 1]
    const next = shifts[k + 1]
    const left =
      prev === undefined ? -1e6 : run.x + (prev.end + prev.shift + shifts[i]!.start + shift) / 2
    const right =
      next === undefined ? 1e6 : run.x + (shifts[k]!.end + shift + next.start + next.shift) / 2
    ctx.save()
    ctx.beginPath()
    ctx.rect(left, -1e6, right - left, 2e6)
    ctx.clip()
    put(text, run.x + shift)
    ctx.restore()
    i = k + 1
  }
}

/**
 * Each part's shift: where the layout put it minus where the canvas's pen is
 * (0 within the snapping), with its stretch of the run (pen at its start and
 * end) and its offsets in the text. The pen at a glyph is the whole string's
 * advance less what follows it: a prefix measured alone would miss the
 * kerning between its last glyph and the next (applied to the left glyph's
 * advance, and drawn by the whole string), and the word would be moved by
 * that kerning a second time.
 */
function partShifts(
  ctx: Paint2D,
  run: GlyphRun,
  text: string,
): Array<{ shift: number; start: number; end: number; from: number; to: number }> {
  if (run.parts === undefined) return []
  const total = ctx.measureText(text).width
  const penAt = (index: number): number =>
    index <= 0 ? 0 : index >= text.length ? total : total - ctx.measureText(text.slice(index)).width
  const shifts: Array<{ shift: number; start: number; end: number; from: number; to: number }> = []
  let consumed = 0
  for (const part of run.parts) {
    const index = run.text.indexOf(part.text, consumed)
    if (index < 0) continue
    consumed = index + part.text.length
    const pen = penAt(index)
    const end = penAt(consumed)
    const delta = part.dx - pen
    shifts.push({
      shift: Math.abs(delta) > SNAP ? delta : 0,
      start: pen,
      end,
      from: index,
      to: consumed,
    })
  }
  // The whole string as wide as the layout made the run: the canvas shaped
  // it as the layout did, and its glyphs are where the layout put them. The
  // pens above are estimates from measured substrings, and a font whose
  // kerning is not the left glyph's advance alone misleads them — Times New
  // Roman (its legacy `kern` table): "— AV" put A 0.6 px and V 1.4 px left of
  // where the whole string draws them, the suffix measured without its
  // context, while the string matched the layout to 0.01 px.
  if (Math.abs(total - run.width) <= SNAP) for (const s of shifts) s.shift = 0
  return shifts
}

/** A letter-spaced run on a canvas that cannot space letters: word by word, grapheme by grapheme. */
function drawSpacedRun(ctx: Paint2D, run: GlyphRun, put: (text: string, x: number) => void): void {
  const draw = (text: string, x: number): void =>
    drawSpaced(put, (t) => ctx.measureText(t).width, text, x, run.letterSpacing)
  const measure = (text: string): number =>
    ctx.measureText(text).width + [...(graphemes?.segment(text) ?? [])].length * run.letterSpacing
  if (run.parts === undefined) {
    draw(run.text, run.x)
    return
  }
  let pen = run.x + (run.parts[0]?.dx ?? 0)
  let consumed = 0
  for (const part of run.parts) {
    const at = run.x + part.dx
    const index = run.text.indexOf(part.text, consumed)
    if (index > consumed) pen += measure(run.text.slice(consumed, index))
    if (Math.abs(pen - at) > SNAP) pen = at
    draw(part.text, pen)
    pen += measure(part.text)
    consumed = index < 0 ? consumed : index + part.text.length
  }
}
