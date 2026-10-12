/**
 * commands/src/text/fontWeights.ts
 *
 * Which weights a text box's font family actually has, and which of them
 * the browser renders for a requested weight. Shared by the editor's weight
 * picker (to DISPLAY the weight that is really on screen) and
 * `text.setBoxTypography` (to snap the stored weight when the family
 * changes), so the editor and an agent switching fonts get the same cut.
 * Moved here from apps/web in A2.11.
 *
 * Kept pure — no React, no Yjs — so the Inspector can derive the value it
 * shows without writing to the document. An earlier version "fixed" an
 * unavailable weight from a `useEffect` in the weight picker: merely
 * selecting a text box wrote to the deck, landed on the undo stack and
 * sent an update to every collaborator (each of whom repeated it).
 */

import type { FontWeight } from '@narrative/shared'

/** The numeric weights the editor offers (`FontWeight` minus the legacy keywords). */
export type NumericFontWeight = Exclude<FontWeight, 'normal' | 'bold'>

export const STANDARD_WEIGHTS: ReadonlyArray<NumericFontWeight> = [
  100, 200, 300, 400, 500, 600, 700, 800, 900,
]

/**
 * System font stacks. `weights` is the realistic list of cuts the user
 * can expect to find pre-installed on macOS / Windows (and that the
 * browser will not synthesize). System fonts typically ship only
 * Regular + Bold; Inter is the exception because Vite serves the
 * variable face that covers 100..900.
 */
export const SYSTEM_FONTS: ReadonlyArray<{
  label: string
  value: string
  weights: ReadonlyArray<number>
}> = [
  {
    label: 'Inter',
    value: 'Inter, system-ui, sans-serif',
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
  },
  {
    label: 'Helvetica',
    value: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    weights: [400, 700],
  },
  { label: 'Georgia', value: "Georgia, 'Times New Roman', serif", weights: [400, 700] },
  { label: 'Times', value: "'Times New Roman', Times, serif", weights: [400, 700] },
  { label: 'Courier', value: "'Courier New', Courier, monospace", weights: [400, 700] },
  { label: 'SF Mono', value: "'SF Mono', Menlo, monospace", weights: [400, 700] },
]

/** A folder-uploaded font face, reduced to what weight resolution needs. */
export interface FontFaceWeight {
  family: string
  weight: number
  /** A variable face's weight and width axis ranges (A4.2c): it covers every weight in `wght`. */
  axes?: { wght?: [number, number]; wdth?: [number, number] }
}

/** The weights a face covers: its own, or every standard weight in a variable face's range. */
function faceWeights(face: FontFaceWeight): number[] {
  const range = face.axes?.wght
  if (range === undefined) return [face.weight]
  return STANDARD_WEIGHTS.filter((w) => w >= range[0] && w <= range[1])
}

/**
 * The widths (`fontStretch`, % of normal) a folder family can be drawn at
 * without synthesis: the union of its variable faces' `wdth` ranges; null
 * when no face of it has a width axis (only 100 is real).
 */
export function stretchRangeFor(
  fontFamily: string | undefined,
  folderFonts: ReadonlyArray<FontFaceWeight>,
): [number, number] | null {
  const primary = pickPrimaryFamily(fontFamily)
  if (primary === null) return null
  let range: [number, number] | null = null
  for (const f of folderFonts) {
    const w = f.family === primary ? f.axes?.wdth : undefined
    if (w === undefined) continue
    range = range === null ? [w[0], w[1]] : [Math.min(range[0], w[0]), Math.max(range[1], w[1])]
  }
  return range
}

/** The legacy `'normal'` / `'bold'` keywords map to 400 / 700. */
export function toNumericWeight(weight: FontWeight): NumericFontWeight {
  if (weight === 'normal') return 400
  if (weight === 'bold') return 700
  return weight
}

/** First family of a CSS stack, unquoted; null for an empty value. */
export function pickPrimaryFamily(fontFamily: string | undefined): string | null {
  if (fontFamily === undefined || fontFamily === '') return null
  const first =
    fontFamily
      .split(',')[0]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? ''
  return first === '' ? null : first
}

/**
 * The standard weights available for `fontFamily`, ascending:
 *   1. a folder-uploaded family → only the cuts actually uploaded;
 *   2. a curated system stack   → its `SYSTEM_FONTS` list;
 *   3. anything else            → null, meaning "any weight" (the browser
 *      synthesises or falls back, so the full 100..900 range is offered).
 *
 * Non-standard uploaded weights (a 350 cut) are not offered by the picker,
 * so they are left out; a family with no standard cut at all degrades to
 * "any weight" rather than an empty list.
 */
export function allowedWeightsFor(
  fontFamily: string | undefined,
  folderFonts: ReadonlyArray<FontFaceWeight>,
): NumericFontWeight[] | null {
  const primary = pickPrimaryFamily(fontFamily)
  if (primary === null) return null
  const uploaded = folderFonts.filter((f) => f.family === primary).flatMap(faceWeights)
  const source =
    uploaded.length > 0
      ? uploaded
      : (SYSTEM_FONTS.find((f) => f.value === fontFamily)?.weights ?? null)
  if (source === null) return null
  const set = new Set(source)
  const allowed = STANDARD_WEIGHTS.filter((w) => set.has(w))
  return allowed.length > 0 ? allowed : null
}

/**
 * The weight the browser renders when `requested` is asked of a family
 * that only has `available` — the CSS Fonts Level 4 font-weight matching
 * rule (§5.2), so the picker shows the face that is actually on screen:
 *
 *   - requested in 400..500: weights in [requested, 500] ascending, then
 *     weights below `requested` descending, then weights above 500
 *     ascending;
 *   - requested below 400: weights at or below it descending, then above
 *     ascending;
 *   - requested above 500: weights at or above it ascending, then below
 *     descending.
 *
 * (A browser may additionally synthesise bold when the matched face is
 * lighter than 600 and the request is 600+; the picker still names the
 * real face.) Returns `requested` when `available` is empty.
 */
export function matchFontWeight(requested: number, available: ReadonlyArray<number>): number {
  if (available.length === 0) return requested
  const asc = [...available].sort((a, b) => a - b)
  const desc = [...asc].reverse()
  const pick = (...passes: Array<number | undefined>): number =>
    passes.find((w) => w !== undefined) ?? requested

  if (requested >= 400 && requested <= 500) {
    return pick(
      asc.find((w) => w >= requested && w <= 500),
      desc.find((w) => w < requested),
      asc.find((w) => w > 500),
    )
  }
  if (requested < 400) {
    return pick(
      desc.find((w) => w <= requested),
      asc.find((w) => w > requested),
    )
  }
  return pick(
    asc.find((w) => w >= requested),
    desc.find((w) => w < requested),
  )
}

/**
 * The weight to show for (and, on a family switch, to store on) a text
 * box: its own weight when the family has it, otherwise the face the
 * browser falls back to.
 */
export function effectiveFontWeight(
  weight: FontWeight,
  allowed: ReadonlyArray<NumericFontWeight> | null,
): NumericFontWeight {
  const requested = toNumericWeight(weight)
  if (allowed === null || allowed.includes(requested)) return requested
  return matchFontWeight(requested, allowed) as NumericFontWeight
}
