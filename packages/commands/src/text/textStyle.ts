/**
 * text/textStyle.ts — what a folder text style writes onto a text box that
 * is linked to it (`textStyleId`). One mapping for everything that applies
 * a style: the editor's TextStylePropagator (a changed style reaching the
 * boxes linked to it) and the commands that link a box to a style
 * (`object.slideNumber.set` today, `text.style.apply` in A2.11), so a style
 * reads the same whichever way it arrived.
 *
 *   fontFamily           ← family
 *   fontWeight           ← weight
 *   fontSize             ← size
 *   lineHeight           ← lineHeight
 *   letterSpacing        ← letterSpacing
 *   paragraphSpaceBefore ← paragraphSpaceBefore (default 0)
 *   paragraphSpaceAfter  ← paragraphSpaceAfter (default 0)
 *   color                ← color: a hex becomes 0xRRGGBB; a colour token
 *                          becomes its current value, or stays a reference
 *                          the renderer resolves when it cannot be resolved
 *   textTransform        ← textTransform (default 'none')
 *
 * A field the style leaves unset is not written (the box keeps its own).
 */

import { TEXT_STYLE_OVERRIDE_KEYS, type TextStyleOverrideKey } from '@narrative/shared'
import {
  isTokenRef,
  resolveTokenValue,
  type FolderTokensSnapshot,
  type TextStyleTokenSnapshot,
} from '@narrative/slide-model'

const HEX6 = /^#[0-9a-f]{6}$/i

/** The text style a page-number field is meant to wear (seeded into every folder). */
export const PAGE_NUMBER_TEXT_STYLE_NAME = 'Footnotes and pages'

/** The value `key` of a box linked to `style` takes, or undefined (leave the box's own). */
export function textStyleField(
  style: TextStyleTokenSnapshot,
  key: TextStyleOverrideKey,
  tokens: FolderTokensSnapshot,
): unknown {
  switch (key) {
    case 'fontFamily':
      return style.family
    case 'fontWeight':
      return style.weight
    case 'fontSize':
      return style.size
    case 'lineHeight':
      return style.lineHeight
    case 'letterSpacing':
      return style.letterSpacing
    case 'paragraphSpaceBefore':
      return style.paragraphSpaceBefore ?? 0
    case 'paragraphSpaceAfter':
      return style.paragraphSpaceAfter ?? 0
    case 'color': {
      const c = style.color
      if (typeof c === 'string') return HEX6.test(c) ? parseInt(c.slice(1), 16) : undefined
      if (c !== undefined && isTokenRef(c)) {
        const resolved = resolveTokenValue(c, tokens)
        return resolved !== null && HEX6.test(resolved) ? parseInt(resolved.slice(1), 16) : c
      }
      return undefined
    }
    case 'textTransform':
      return style.textTransform ?? 'none'
  }
}

/**
 * Every field `style` sets on a linked box, except the keys the box
 * overrides (`textStyleOverrides`).
 */
export function textStyleFields(
  style: TextStyleTokenSnapshot,
  tokens: FolderTokensSnapshot,
  overrides: Iterable<string> = [],
): Record<string, unknown> {
  const skip = new Set(overrides)
  const fields: Record<string, unknown> = {}
  for (const key of TEXT_STYLE_OVERRIDE_KEYS) {
    if (skip.has(key)) continue
    const value = textStyleField(style, key, tokens)
    if (value !== undefined) fields[key] = value
  }
  return fields
}

/** A folder text style by its name, ignoring case and surrounding spaces; null when there is none. */
export function findTextStyleByName(
  tokens: FolderTokensSnapshot,
  name: string,
): TextStyleTokenSnapshot | null {
  const wanted = name.trim().toLowerCase()
  return (
    Object.values(tokens.textStyles).find((s) => s.name.trim().toLowerCase() === wanted) ?? null
  )
}
