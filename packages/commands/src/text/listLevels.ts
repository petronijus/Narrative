/**
 * text/listLevels.ts — a text box's `listLevels` (A4.2b) as the list
 * commands need them: each level's default list kind, glyph and number
 * format, read from the stored value (a plain array on the object's Y.Map;
 * malformed entries count as no defaults).
 */

import type { ListKind, ListNumberFormat } from '@narrative/shared'
import type { ListLevelDefaults } from '@narrative/slide-model'

const KINDS = new Set<ListKind>(['bullet', 'number', 'none'])
const FORMATS = new Set<ListNumberFormat>([
  'decimal',
  'decimalParen',
  'lowerAlpha',
  'lowerAlphaParen',
  'upperAlpha',
  'upperAlphaParen',
  'lowerRoman',
  'upperRoman',
])

/** The box's level defaults, or undefined when it has none. */
export function listLevelsOf(value: unknown): Array<ListLevelDefaults | undefined> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.map((entry): ListLevelDefaults | undefined => {
    if (typeof entry !== 'object' || entry === null) return undefined
    const e = entry as Record<string, unknown>
    const out: ListLevelDefaults = {}
    if (KINDS.has(e['list'] as ListKind)) out.list = e['list'] as ListKind
    if (typeof e['bulletChar'] === 'string' && e['bulletChar'] !== '') {
      out.bulletChar = e['bulletChar']
    }
    if (FORMATS.has(e['numberFormat'] as ListNumberFormat)) {
      out.numberFormat = e['numberFormat'] as ListNumberFormat
    }
    return out
  })
}
