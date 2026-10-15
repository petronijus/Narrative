/**
 * media/fontMetadata.ts
 *
 * P15: parse a TTF / OTF buffer with opentype.js and extract the bits
 * we surface to the client (family, weight, style, postscript name).
 *
 * Uses the official `name` table for the family + postscript name and
 * the `OS/2` table for weight + italic bit. A variable font (an `fvar`
 * table) is listed as its default instance, with the ranges of its weight
 * and width axes (A4.2c: text set at a width — Acme Type Extended is
 * `wdth` 130 — needs a face that has it).
 */

import { parse, type Font, type FontNames } from 'opentype.js/dist/opentype.mjs'

/** The ranges of a variable font's weight and width axes (`fvar`), [min, max]. */
export interface FontAxes {
  wght?: [number, number]
  wdth?: [number, number]
}

export interface FontMetadata {
  family: string
  weight: number
  style: 'normal' | 'italic'
  postscriptName: string
  /** Absent for a static font, or a variable one with neither axis. */
  axes?: FontAxes
}

/**
 * Read the font's name table and OS/2 table to derive the metadata
 * we expose. Throws if the buffer isn't a valid OpenType / TrueType
 * file or is missing the required tables.
 */
export function parseFontMetadata(buf: ArrayBuffer): FontMetadata {
  // parse expects an ArrayBuffer; throws on invalid headers.
  const font = parse(buf)

  // Family — prefer the typographic family (id 16, "preferred family")
  // when present, otherwise fall back to id 1.
  const familyName = pickName(font.names, ['preferredFamily', 'fontFamily'])
  if (familyName === null || familyName.trim() === '') {
    throw new Error('Font is missing a family name')
  }
  const postscriptName = pickName(font.names, ['postScriptName']) ?? familyName

  // Weight — OS/2 usWeightClass is the canonical source, but several
  // foundries (notably Google's variable-font static exports) stamp
  // every cut with the same value. When the postscript / subfamily
  // name clearly contradicts OS/2 (eg `*-Thin` with usWeightClass=300),
  // we trust the name. Defaults to 400 when nothing reliable exists.
  const os2 = font.tables.os2
  const subfamilyName = pickName(font.names, ['preferredSubfamily', 'fontSubfamily'])
  const nameWeight = weightFromName(`${subfamilyName ?? ''} ${postscriptName}`)
  const os2Weight = clampWeight(os2?.usWeightClass ?? 400)
  const weight = nameWeight ?? os2Weight

  // Italic bit — fsSelection bit 0. Some fonts also encode it via the
  // mac style flag in head; OS/2 is the canonical spec source.
  const italic = (os2?.fsSelection ?? 0) & 0b1
  const style: 'normal' | 'italic' = italic ? 'italic' : 'normal'

  const axes = variableAxes(font)
  return {
    family: familyName,
    weight,
    style,
    postscriptName,
    ...(axes !== undefined ? { axes } : {}),
  }
}

/** The weight and width axes of a variable font's `fvar` table. */
function variableAxes(font: Font): FontAxes | undefined {
  const out: FontAxes = {}
  for (const axis of font.tables.fvar?.axes ?? []) {
    const { tag, minValue, maxValue } = axis
    if (typeof minValue !== 'number' || typeof maxValue !== 'number') continue
    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || minValue > maxValue) continue
    if (tag === 'wght' || tag === 'wdth') out[tag] = [minValue, maxValue]
  }
  return out.wght === undefined && out.wdth === undefined ? undefined : out
}

/**
 * The name table's platforms, the most trusted first. Windows records are
 * the ones fonts keep current (Macintosh ones are often legacy, MacRoman,
 * truncated); opentype.js 1.x merged the platforms with the same order
 * winning, so a font reads as it did before 2.x keyed them apart.
 */
const NAME_PLATFORMS = ['windows', 'macintosh', 'unicode'] as const

/**
 * The first non-empty name among `keys`, in order: a key on any platform
 * beats the next key (a typographic family anywhere beats a legacy one).
 * Per key, English on any platform, then any other language.
 */
function pickName(names: FontNames, keys: ReadonlyArray<string>): string | null {
  for (const key of keys) {
    const localised = NAME_PLATFORMS.map((platform) => names[platform]?.[key])
    for (const translations of localised) {
      const en = translations?.en?.trim()
      if (en) return en
    }
    // Fall back to the first non-empty translation — better than nothing.
    for (const translations of localised) {
      for (const v of Object.values(translations ?? {})) {
        if (typeof v === 'string' && v.trim() !== '') return v.trim()
      }
    }
  }
  return null
}

function clampWeight(w: number): number {
  if (!Number.isFinite(w)) return 400
  // CSS allows 1..1000; round to nearest 100 for the picker UI.
  const clamped = Math.max(100, Math.min(900, Math.round(w / 100) * 100))
  return clamped
}

/**
 * Map the canonical weight tokens that appear in postscript names and
 * subfamily fields. Order matters — longer matches first so "ExtraBold"
 * isn't shadowed by "Bold". Returns null when no token matches.
 */
const WEIGHT_NAME_TABLE: ReadonlyArray<readonly [RegExp, number]> = [
  [/extra ?light|ultra ?light/i, 200],
  [/extra ?bold|ultra ?bold/i, 800],
  [/semi ?bold|demi ?bold/i, 600],
  [/black|heavy/i, 900],
  [/thin|hairline/i, 100],
  [/light/i, 300],
  [/medium/i, 500],
  [/bold/i, 700],
  [/regular|normal|book/i, 400],
]

function weightFromName(s: string): number | null {
  if (s.trim() === '') return null
  for (const [re, weight] of WEIGHT_NAME_TABLE) {
    if (re.test(s)) return weight
  }
  return null
}
