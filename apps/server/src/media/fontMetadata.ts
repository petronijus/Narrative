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

  // Weight — OS/2 usWeightClass. Defaults to 400 (regular) when the
  // table is absent, which matches CSS @font-face semantics.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const os2 = (font.tables as any).os2 as
    | { usWeightClass?: number; fsSelection?: number }
    | undefined
  const weight = clampWeight(os2?.usWeightClass ?? 400)

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
