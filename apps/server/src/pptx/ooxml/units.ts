/**
 * pptx/ooxml/units.ts
 *
 * Every unit conversion between Narrative's model and OOXML, in one place,
 * for both directions. The importer reached the model through two steps
 * (EMU → "pptx px" at 96 dpi, then × canvasWidth / slideWidthPx) and the old
 * exporter came back through a third (px → inches for pptxgenjs → EMU), with
 * rounding at every stage: a deck came back 0.1 px off everywhere. Here the
 * model's canvas pixel converts to EMU exactly.
 *
 * The exported slide is 16:9 at PowerPoint's default size, 12 192 000 ×
 * 6 858 000 EMU (13.333 × 7.5 in). The model canvas is SLIDE_WIDTH ×
 * SLIDE_HEIGHT (1920 × 1080), so one canvas pixel is exactly 6 350 EMU and a
 * point (12 700 EMU) is exactly 2 canvas pixels.
 */

import { SLIDE_HEIGHT, SLIDE_WIDTH } from '@narrative/shared'

/** Exported slide size, EMU. */
export const SLIDE_CX_EMU = 12_192_000
export const SLIDE_CY_EMU = 6_858_000

/**
 * EMU per canvas pixel. Exact: 12 192 000 / 1920 = 6 858 000 / 1080. Not
 * the parser's 9 525 EMU per 96-dpi pixel, which is the source deck's own
 * pixel before it is scaled onto the canvas.
 */
export const EMU_PER_CANVAS_PX = SLIDE_CX_EMU / SLIDE_WIDTH
if (EMU_PER_CANVAS_PX * SLIDE_HEIGHT !== SLIDE_CY_EMU || !Number.isInteger(EMU_PER_CANVAS_PX)) {
  throw new Error('ooxml/units: canvas size and exported slide size are not in an exact ratio')
}

/** EMU per typographic point. */
export const EMU_PER_PT = 12_700

/** Canvas px → EMU, as the integer OOXML requires. */
export function pxToEmu(px: number): number {
  return Math.round(px * EMU_PER_CANVAS_PX)
}

/** EMU → canvas px, for a deck exported at our slide size. */
export function emuToCanvasPx(emu: number): number {
  return emu / EMU_PER_CANVAS_PX
}

/**
 * EMU per source pixel: the importer's working unit. A deck of any slide
 * size is read in 96-dpi pixels (9 525 EMU) and scaled onto the canvas in
 * one step afterwards (`writer.ts`), so readers shared with the exporter
 * return lengths in this unit.
 */
export const EMU_PER_SOURCE_PX = 9_525

/** EMU → source px (96 dpi). */
export function emuToSourcePx(emu: number): number {
  return emu / EMU_PER_SOURCE_PX
}

/** Canvas px → points (font sizes, spacing and line widths are in points). */
export function pxToPt(px: number): number {
  return (px * EMU_PER_CANVAS_PX) / EMU_PER_PT
}

/** Points → canvas px. */
export function ptToPx(pt: number): number {
  return (pt * EMU_PER_PT) / EMU_PER_CANVAS_PX
}

/**
 * Canvas px → hundredths of a point, the unit of `sz`, `spc`, `spcPts` and
 * friends. Rounded: OOXML wants an integer.
 */
export function pxToCentipoints(px: number): number {
  return Math.round(pxToPt(px) * 100)
}

/** Hundredths of a point → canvas px. */
export function centipointsToPx(v: number): number {
  return ptToPx(v / 100)
}

/** OOXML angles (`rot`, `ang`) are 60 000ths of a degree. */
export const ANGLE_UNITS_PER_DEG = 60_000

/** Degrees → OOXML angle units, normalised to [0, 360°) as `rot` requires. */
export function degToAngle(deg: number): number {
  const d = ((deg % 360) + 360) % 360
  return Math.round(d * ANGLE_UNITS_PER_DEG) % (360 * ANGLE_UNITS_PER_DEG)
}

/** OOXML angle units → degrees. */
export function angleToDeg(v: number): number {
  return v / ANGLE_UNITS_PER_DEG
}

/** Percentages (`alpha`, `lumMod`, `spcPct`, `pos`) are 1000ths of a percent. */
export const PERCENT_UNITS = 100_000

/** Fraction 0..1 → OOXML percentage units. */
export function fractionToPercent(f: number): number {
  return Math.round(f * PERCENT_UNITS)
}

/** OOXML percentage units → fraction. */
export function percentToFraction(v: number): number {
  return v / PERCENT_UNITS
}
