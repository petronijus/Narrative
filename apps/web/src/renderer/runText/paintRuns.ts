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
import { rasterSize, stretchKeyword, type GlyphRun, type TextRunLayout } from './glyphRuns.js'
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

/** Paint `layout` at `resolution` into `ctx`, whose canvas is `rasterSize` big. */
export function paintRuns(
  ctx: Paint2D,
  layout: TextRunLayout,
  resolution: number,
  rules: PaintRules,
  support?: PaintSupport,
): void {
  const { width, height } = rasterSize(layout, resolution)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.textBaseline = 'alphabetic'
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
    ctx.setTransform(resolution, 0, 0, resolution, 0, 0)
    paintUnderlines(
      ctx,
      layout.decorations,
      layout.runs,
      resolution,
      rules.decorations,
      support.scratch,
      (mask, run, baseline) => {
        setRunType(mask, run)
        mask.textBaseline = 'alphabetic'
        drawInkOf(mask, run, rules, baseline)
      },
      metrics,
    )
  }
  ctx.setTransform(resolution, 0, 0, resolution, 0, 0)
  for (const run of layout.runs) {
    setRunType(ctx, run)
    if (run.stroke !== undefined) {
      ctx.lineWidth = run.stroke.width
      ctx.strokeStyle = run.stroke.color
      ctx.lineJoin = 'miter'
      ctx.miterLimit = rules.strokeMiterLimit
      drawRun(ctx, run, 'stroke', rules)
    }
    ctx.fillStyle = run.color
    drawRun(ctx, run, 'fill', rules)
  }
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

/** A run's glyphs for the ink-skip mask: all of them but CJK, at their places in the run. */
function drawInkOf(ctx: Paint2D, run: GlyphRun, rules: PaintRules, baseline: number): void {
  if (!HAS_CJK.test(run.text)) {
    drawRun(ctx, run, 'fill', rules, baseline)
    return
  }
  let at = 0
  const draw = (from: number, to: number): void => {
    if (to <= from) return
    const dx = ctx.measureText(run.text.slice(0, from)).width
    ctx.fillText(run.text.slice(from, to), run.x + dx, baseline)
  }
  for (const m of run.text.matchAll(CJK)) {
    draw(at, m.index)
    at = m.index + m[0].length
  }
  draw(at, run.text.length)
}

function setFont(ctx: Paint2D, font: string): void {
  ctx.font = SENTINEL_FONT
  ctx.font = font
  if (ctx.font.includes('__narrative_no_font__')) throw new UnpaintableRunError(`font ${font}`)
}

/**
 * Draw a run: as one string, or word by word where the layout fixed the words.
 * The layout's positions are LayoutUnits (1/64 px) and the shaper's pen is a
 * float, so a word goes where the pen is unless the two disagree by more than
 * the snapping (a kerning pair across a space the canvas shaper does not
 * apply), and then where the layout put it.
 */
function drawRun(
  ctx: Paint2D,
  run: GlyphRun,
  mode: 'fill' | 'stroke',
  rules: PaintRules,
  baseline?: number,
): void {
  const y = baseline ?? (rules.snapBaseline ? Math.round(run.y) : run.y)
  const put = (text: string, x: number): void => {
    if (mode === 'fill') ctx.fillText(text, x, y)
    else ctx.strokeText(text, x, y)
  }
  const spaced = run.letterSpacing !== 0 && !spacesLetters(ctx)
  const draw = spaced
    ? (text: string, x: number): void =>
        drawSpaced(put, (t) => ctx.measureText(t).width, text, x, run.letterSpacing)
    : put
  // The pen between words advances by the spaced width too.
  const measure = (text: string): number =>
    ctx.measureText(text).width +
    (spaced ? [...(graphemes?.segment(text) ?? [])].length * run.letterSpacing : 0)
  if (run.rtl === true) {
    // Placed from its right edge by the canvas; graphemes drawn one by one
    // would need the visual order the canvas computes.
    if (spaced) throw new UnpaintableRunError('letter-spaced right-to-left run')
    ctx.direction = 'rtl'
    ctx.textAlign = 'right'
    draw(run.text, run.x + run.width)
    ctx.direction = 'ltr'
    ctx.textAlign = 'left'
    return
  }
  ctx.direction = 'ltr'
  ctx.textAlign = 'left'
  if (run.parts === undefined) {
    draw(run.text, run.x)
    return
  }
  let pen = run.x + (run.parts[0]?.dx ?? 0)
  let consumed = 0
  for (const part of run.parts) {
    const at = run.x + part.dx
    // The spaces between the previous word and this one.
    const index = run.text.indexOf(part.text, consumed)
    if (index > consumed) pen += measure(run.text.slice(consumed, index))
    if (Math.abs(pen - at) > SNAP) pen = at
    draw(part.text, pen)
    pen += measure(part.text)
    consumed = index < 0 ? consumed : index + part.text.length
  }
}
