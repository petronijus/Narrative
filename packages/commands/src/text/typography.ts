/**
 * commands/src/text/typography.ts — the rules a box-wide typography change
 * carries, shared by `text.setBoxTypography` (text boxes) and
 * `table.style.table` (a table's defaults):
 *
 *   - a new font family without an explicit weight keeps the box on a cut
 *     the family has (the editor's font picker does the same);
 *   - on a box linked to a folder text style (`textStyleId`), the fields
 *     changed by hand are recorded in `textStyleOverrides`, so a later
 *     change of the style skips them;
 *   - the inline run attributes a box-wide value would otherwise be hidden
 *     under are the ones named in `RUN_ATTR_KEYS`.
 */

import {
  isTextStyleOverrideKey,
  type FontWeight,
  type TextStyleOverrideKey,
} from '@narrative/shared'
import type { RichAttrs } from '@narrative/slide-model'
import { CommandError } from '../errors.js'
import type { CommandContext } from '../types.js'
import {
  SYSTEM_FONTS,
  allowedWeightsFor,
  effectiveFontWeight,
  toNumericWeight,
  type NumericFontWeight,
} from './fontWeights.js'

/** Box fields that inline runs can override too (a run's own value wins over the box's). */
export const RUN_ATTR_KEYS: ReadonlyArray<keyof RichAttrs> = [
  'fontFamily',
  'fontWeight',
  'fontSize',
  'color',
  'italic',
  'underline',
]

/**
 * The weight a box on `currentWeight` takes when its family becomes
 * `family`, or undefined when it keeps its weight. Needs the folder's fonts
 * for any family that is not one of the editor's system stacks: absent
 * fonts (`ctx.folderFonts === undefined`) refuse rather than guess.
 */
export function snappedWeightForFamily(
  ctx: CommandContext,
  currentWeight: FontWeight,
  family: string | undefined,
): NumericFontWeight | undefined {
  if (family === undefined) return undefined
  const system = SYSTEM_FONTS.some((f) => f.value === family)
  if (!system && ctx.folderFonts === undefined) {
    throw new CommandError(
      'conflict',
      "the folder's fonts cannot be read here, so the weight to keep is unknown; pass fontWeight with fontFamily",
    )
  }
  const weight = effectiveFontWeight(
    currentWeight,
    allowedWeightsFor(family, ctx.folderFonts ?? []),
  )
  return weight === toNumericWeight(currentWeight) ? undefined : weight
}

/**
 * The `textStyleOverrides` a linked box has after `fields` were set by
 * hand: its current list plus every style-controlled field among them.
 * Undefined when nothing new is overridden.
 */
export function overridesAfter(
  existing: unknown,
  fields: Iterable<string>,
): TextStyleOverrideKey[] | undefined {
  const current = Array.isArray(existing)
    ? (existing.filter(
        (k) => typeof k === 'string' && isTextStyleOverrideKey(k),
      ) as TextStyleOverrideKey[])
    : []
  const next = new Set(current)
  for (const key of fields) if (isTextStyleOverrideKey(key)) next.add(key)
  return next.size === current.length ? undefined : [...next]
}
