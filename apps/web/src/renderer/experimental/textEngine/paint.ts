/**
 * renderer/experimental/textEngine/paint.ts — draw a text's glyph runs with
 * Canvas2D (E7 spike, EXPERIMENTAL). Runs in a worker (`rasterWorker.ts`)
 * or on the main thread; it touches nothing but the context it is given.
 *
 * Mirrors what HTMLText's SVG raster does: the layout in CSS px, scaled by
 * the resolution from the top left (`transform: scale(r)` in Pixi's
 * `getSVGUrl`), the stroke painted under the fill (`paint-order: stroke`).
 */

import { rasterSize, stretchKeyword, type GlyphRun, type TextRunLayout } from './runs.js'

/** The 2D context surface both canvases share (lib.dom types them apart). */
export type Paint2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/** What a paint could not reproduce, for the fidelity report. */
export interface PaintNotes {
  /** Runs whose `font-stretch` has no Canvas2D spelling (drawn at normal width). */
  stretchDropped: number
}

/** Paint `layout` at `resolution` into `ctx`, whose canvas is already `rasterSize` big. */
export function paintRuns(ctx: Paint2D, layout: TextRunLayout, resolution: number): PaintNotes {
  const notes: PaintNotes = { stretchDropped: 0 }
  const { width, height } = rasterSize(layout, resolution)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.setTransform(resolution, 0, 0, resolution, 0, 0)
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  const canStretch = 'fontStretch' in ctx
  for (const run of layout.runs) {
    ctx.font = run.font
    if (run.stretch !== 100) {
      const keyword = stretchKeyword(run.stretch)
      if (canStretch && keyword !== undefined) ctx.fontStretch = keyword
      else notes.stretchDropped++
    } else if (canStretch) {
      ctx.fontStretch = 'normal'
    }
    ctx.letterSpacing = `${run.letterSpacing}px`
    if (run.stroke !== undefined) {
      ctx.lineWidth = run.stroke.width
      ctx.strokeStyle = run.stroke.color
      ctx.lineJoin = 'miter'
      drawRun(ctx, run, 'stroke')
    }
    ctx.fillStyle = run.color
    drawRun(ctx, run, 'fill')
    if (run.underline !== undefined) {
      // Decorations are snapped to whole CSS pixels of the layout, as the
      // baseline is (the SVG raster scales the snapped result).
      const top = Math.floor(Math.round(run.y) + run.underline.offset)
      const thickness = Math.max(1, Math.round(run.underline.thickness))
      ctx.fillStyle = run.underline.color
      ctx.fillRect(run.x, top, run.width, thickness)
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  return notes
}

/**
 * Draw a run: as one string, or word by word where the layout fixed the
 * words. The layout's positions are LayoutUnits (1/64 px) and the shaper's
 * pen is a float, so a word goes where the pen is unless the two disagree
 * by more than the snapping (a kerning pair across a space the canvas
 * shaper does not apply), and then where the layout put it.
 */
function drawRun(ctx: Paint2D, run: GlyphRun, mode: 'fill' | 'stroke'): void {
  // Chromium paints a line's baseline on a whole CSS pixel of the layout,
  // and the SVG raster scales that (`transform: scale(r)`): at 2× a
  // fractional baseline (line 2 of a 27.6 px line height) is rounded first.
  const y = Math.round(run.y)
  const draw = (text: string, x: number): void => {
    if (mode === 'fill') ctx.fillText(text, x, y)
    else ctx.strokeText(text, x, y)
  }
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
    if (index > consumed) pen += ctx.measureText(run.text.slice(consumed, index)).width
    if (Math.abs(pen - at) > SNAP) pen = at
    draw(part.text, pen)
    pen += ctx.measureText(part.text).width
    consumed = index < 0 ? consumed : index + part.text.length
  }
}

/** Two LayoutUnits: what a layout position and a float pen may differ by without a kerning pair. */
const SNAP = 2 / 64
