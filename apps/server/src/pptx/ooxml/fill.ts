/**
 * pptx/ooxml/fill.ts
 *
 * DrawingML fills, both directions: solid, gradient, none.
 *
 * Two things the importer used to get wrong live here now, next to the
 * writer that has to agree with them:
 *
 * - Linear gradient direction. DrawingML's `<a:lin ang>` measures the
 *   direction of colour change clockwise from the x-axis: 0° runs left to
 *   right, 90° top to bottom. Narrative's `angleDeg` (see the renderer's
 *   `paintLinearGradientTexture`) points the direction vector at
 *   (sin α, cos α): 0° runs top to bottom, 90° left to right. The two are a
 *   reflection about the diagonal, α = 90° − θ. The importer added 90°
 *   instead, which agrees for horizontal gradients and turns every vertical
 *   one upside down.
 * - Radial gradient centre. `<a:path>` gradients grow from the rectangle
 *   `<a:fillToRect l t r b>` (insets as fractions of the shape) to the
 *   shape's edge; a point rectangle is the model's centre. The importer
 *   ignored it and every radial gradient came in centred.
 */

import type { XmlNode } from './read.js'
import { findAll, findFirst, getAttrs, getChildren } from './read.js'
import {
  type ThemeColourMap,
  parseColourAndAlphaFrom,
  writeColor,
  writeSolidFill,
} from './color.js'
import { el, tag, type XmlElement } from './xml.js'
import { angleToDeg, degToAngle, fractionToPercent, percentToFraction } from './units.js'

/**
 * Stop on a parsed gradient. `offset` is normalised 0..1 (PPTX uses 0..100000
 * `<a:gs pos="..">`). `color` is 0xRRGGBB.
 */
export interface ParsedGradientStop {
  offset: number
  color: number
  alpha?: number
}

export interface ParsedLinearGradient {
  kind: 'linearGradient'
  /** Degrees, Narrative's convention: 0 = top→bottom, 90 = left→right. */
  angleDeg: number
  stops: ParsedGradientStop[]
}

export interface ParsedRadialGradient {
  kind: 'radialGradient'
  stops: ParsedGradientStop[]
  /** Centre as a fraction of the shape (0..1). Absent: the shape's centre. */
  centerX?: number
  centerY?: number
}

export type ParsedGradient = ParsedLinearGradient | ParsedRadialGradient

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

function normalizeDeg(d: number): number {
  const n = ((d % 360) + 360) % 360
  // Keep exact values exact: 360 − ε rounds back onto 0 in the model.
  return Math.abs(n - 360) < 1e-9 ? 0 : n
}

/** DrawingML `<a:lin ang>` degrees → Narrative gradient degrees. */
export function drawingAngleToModel(drawingDeg: number): number {
  return normalizeDeg(90 - drawingDeg)
}

/** Narrative gradient degrees → DrawingML `<a:lin ang>` degrees. */
export function modelAngleToDrawing(modelDeg: number): number {
  return normalizeDeg(90 - modelDeg)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function parseGradient(
  gradFill: XmlNode,
  theme: ThemeColourMap,
): ParsedGradient | undefined {
  const children = getChildren(gradFill, 'a:gradFill')
  const gsLst = findFirst(children, 'a:gsLst')
  if (!gsLst) return undefined
  const gsNodes = findAll(getChildren(gsLst, 'a:gsLst'), 'a:gs')
  const stops: ParsedGradientStop[] = []
  for (const gs of gsNodes) {
    const pos = percentToFraction(Number(getAttrs(gs)['@pos'] ?? 0))
    const c = parseColourAndAlphaFrom(gs, theme)
    if (c !== undefined) {
      const stop: ParsedGradientStop = { offset: pos, color: c.color }
      if (c.alpha !== undefined) stop.alpha = c.alpha
      stops.push(stop)
    }
  }
  // PPTX guarantees the order; sorting keeps a hand-edited file sane.
  stops.sort((a, b) => a.offset - b.offset)
  if (stops.length === 0) return undefined

  const path = findFirst(children, 'a:path')
  if (path !== undefined) {
    const out: ParsedRadialGradient = { kind: 'radialGradient', stops }
    const rect = findFirst(getChildren(path, 'a:path'), 'a:fillToRect')
    if (rect !== undefined) {
      const a = getAttrs(rect)
      const f = (k: string): number => percentToFraction(Number(a[k] ?? 0))
      // Centre of the focus rectangle, whose insets are l/t/r/b.
      const cx = (f('@l') + 1 - f('@r')) / 2
      const cy = (f('@t') + 1 - f('@b')) / 2
      if (Number.isFinite(cx) && Number.isFinite(cy)) {
        out.centerX = cx
        out.centerY = cy
      }
    }
    return out
  }

  const lin = findFirst(children, 'a:lin')
  const drawingDeg = lin !== undefined ? angleToDeg(Number(getAttrs(lin)['@ang'] ?? 0)) : 0
  return {
    kind: 'linearGradient',
    angleDeg: drawingAngleToModel(Number.isFinite(drawingDeg) ? drawingDeg : 0),
    stops,
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface GradientStopModel {
  offset: number
  color: number
  alpha?: number
}

export type GradientModel =
  | { kind: 'linearGradient'; angleDeg: number; stops: readonly GradientStopModel[] }
  | {
      kind: 'radialGradient'
      stops: readonly GradientStopModel[]
      centerX?: number
      centerY?: number
    }

/** `<a:gradFill>` for a model gradient. */
export function writeGradFill(g: GradientModel): XmlElement {
  const stops = [...g.stops].sort((a, b) => a.offset - b.offset)
  const gsLst = tag(
    'a:gsLst',
    stops.map((s) =>
      el(
        'a:gs',
        { pos: fractionToPercent(Math.max(0, Math.min(1, s.offset))) },
        writeColor(s.color, s.alpha),
      ),
    ),
  )
  if (g.kind === 'linearGradient') {
    return el(
      'a:gradFill',
      { rotWithShape: 1 },
      gsLst,
      el('a:lin', { ang: degToAngle(modelAngleToDrawing(g.angleDeg)), scaled: 0 }),
    )
  }
  const cx = Math.max(0, Math.min(1, g.centerX ?? 0.5))
  const cy = Math.max(0, Math.min(1, g.centerY ?? 0.5))
  return el(
    'a:gradFill',
    { rotWithShape: 1 },
    gsLst,
    el(
      'a:path',
      { path: 'circle' },
      el('a:fillToRect', {
        l: fractionToPercent(cx),
        t: fractionToPercent(cy),
        r: fractionToPercent(1 - cx),
        b: fractionToPercent(1 - cy),
      }),
    ),
  )
}

/** A shape's fill as the model describes it. */
export type FillModel =
  | { kind: 'solid'; color: number; alpha?: number }
  | { kind: 'gradient'; gradient: GradientModel }
  | { kind: 'none' }

/** The fill element for `<p:spPr>` / `<p:bgPr>` / `<a:tcPr>`. */
export function writeFill(f: FillModel): XmlElement {
  if (f.kind === 'none') return tag('a:noFill')
  if (f.kind === 'gradient') return writeGradFill(f.gradient)
  return writeSolidFill(f.color, f.alpha)
}
