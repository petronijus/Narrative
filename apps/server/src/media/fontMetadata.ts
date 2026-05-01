/**
 * media/fontMetadata.ts
 *
 * P15: parse a TTF / OTF buffer with opentype.js and extract the bits
 * we surface to the client (family, weight, style, postscript name).
 *
 * Uses the official `name` table for the family + postscript name and
 * the `OS/2` table for weight + italic bit. Variable fonts (with an
 * `fvar` table) collapse to their default instance — multi-axis UI is
 * deferred to v2.
 */

import * as opentype from 'opentype.js'

export interface FontMetadata {
  family: string
  weight: number
  style: 'normal' | 'italic'
  postscriptName: string
}

/**
 * Read the font's name table and OS/2 table to derive the metadata
 * we expose. Throws if the buffer isn't a valid OpenType / TrueType
 * file or is missing the required tables.
 */
export function parseFontMetadata(buf: ArrayBuffer): FontMetadata {
  // opentype.parse expects an ArrayBuffer; throws on invalid headers.
  const font = opentype.parse(buf)

  // Family — prefer the typographic family (id 16, "preferred family")
  // when present, otherwise fall back to id 1. names is keyed by lang;
  // pick `en` then any other available value.
  const familyName = pickName(font.names as unknown as OpenTypeNames, [
    'preferredFamily',
    'fontFamily',
  ])
  if (familyName === null || familyName.trim() === '') {
    throw new Error('Font is missing a family name')
  }
  const postscriptName =
    pickName(font.names as unknown as OpenTypeNames, ['postScriptName']) ?? familyName

  // Weight — OS/2 usWeightClass is the canonical source, but several
  // foundries (notably Google's variable-font static exports) stamp
  // every cut with the same value. When the postscript / subfamily
  // name clearly contradicts OS/2 (eg `*-Thin` with usWeightClass=300),
  // we trust the name. Defaults to 400 when nothing reliable exists.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const os2 = (font.tables as any).os2 as
    | { usWeightClass?: number; fsSelection?: number }
    | undefined
  const subfamilyName = pickName(font.names as unknown as OpenTypeNames, [
    'preferredSubfamily',
    'fontSubfamily',
  ])
  const nameWeight = weightFromName(`${subfamilyName ?? ''} ${postscriptName}`)
  const os2Weight = clampWeight(os2?.usWeightClass ?? 400)
  const weight = nameWeight ?? os2Weight

  // Italic bit — fsSelection bit 0. Some fonts also encode it via the
  // mac style flag in head; OS/2 is the canonical spec source.
  const italic = (os2?.fsSelection ?? 0) & 0b1
  const style: 'normal' | 'italic' = italic ? 'italic' : 'normal'

  return { family: familyName, weight, style, postscriptName }
}

type OpenTypeNames = Record<string, Record<string, string> | undefined>

function pickName(names: OpenTypeNames, keys: ReadonlyArray<string>): string | null {
  for (const key of keys) {
    const localised = names[key]
    if (localised === undefined) continue
    const en = localised.en
    if (typeof en === 'string' && en.trim() !== '') return en.trim()
    // Fall back to the first non-empty translation — better than nothing.
    for (const v of Object.values(localised)) {
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
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
