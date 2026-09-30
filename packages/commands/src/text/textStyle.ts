/**
 * text/textStyle.ts — what a folder text style writes onto a text box that
 * is linked to it (`textStyleId`). One mapping for everything that applies
 * a style: the server's token propagation (a changed style reaching the
 * boxes and tables linked to it, `propagateTextStyles` below; the editor's
 * TextStylePropagator until A2.12) and the commands that link a box to a
 * style (`text.style.apply`, `object.slideNumber.set`), so a style reads
 * the same whichever way it arrived.
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

import * as Y from 'yjs'
import {
  TEXT_STYLE_OVERRIDE_KEYS,
  type SlideObject,
  type SlideObjectPatch,
  type TableDefaults,
  type TextStyleOverrideKey,
} from '@narrative/shared'
import {
  getSlideObjectsCtx,
  isTokenRef,
  resolveTokenValue,
  setTableDefaultsPatch,
  updateObject,
  type DeckMutationContext,
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

/**
 * Whether another text style of the folder already has `name` (as
 * `findTextStyleByName` compares): text styles are applied by name, so two
 * of one name would make that ambiguous. `exceptId` is the style being
 * renamed.
 */
export function textStyleNameTaken(
  tokens: FolderTokensSnapshot,
  name: string,
  exceptId?: string,
): boolean {
  const wanted = name.trim().toLowerCase()
  return Object.values(tokens.textStyles).some(
    (s) => s.id !== exceptId && s.name.trim().toLowerCase() === wanted,
  )
}

// ---------------------------------------------------------------------------
// Propagation: a changed style reaching what is linked to it
// ---------------------------------------------------------------------------

/** The text styles whose colour is the colour token `colorId`. */
export function stylesUsingColor(tokens: FolderTokensSnapshot, colorId: string): string[] {
  const ref = `colors.${colorId}`
  return Object.values(tokens.textStyles)
    .filter((s) => isTokenRef(s.color) && s.color.$token === ref)
    .map((s) => s.id)
}

/**
 * Re-apply the styles `styleIds` onto everything linked to them in one deck
 * (or component master — the same one-slide shape): text boxes by their
 * `textStyleId`, tables by their defaults' `textStyleId`. Fields the box or
 * table overrides (`textStyleOverrides`) are skipped, and only fields whose
 * value differs are written. Returns how many objects changed. Must run
 * inside the caller's transaction.
 */
export function propagateTextStyles(
  deck: DeckMutationContext,
  tokens: FolderTokensSnapshot,
  styleIds: ReadonlySet<string>,
): number {
  let changed = 0
  if (styleIds.size === 0) return 0
  for (const slideMap of deck.slides.toArray()) {
    const slideId = slideMap.get('id')
    if (typeof slideId !== 'string') continue
    const objects = getSlideObjectsCtx(deck, slideId)
    if (objects === null) continue
    for (const map of objects.objects.toArray()) {
      const type = map.get('type')
      if (type === 'text') {
        const sid = map.get('textStyleId')
        const style =
          typeof sid === 'string' && styleIds.has(sid) ? tokens.textStyles[sid] : undefined
        if (style === undefined) continue
        const patch = differingFields(
          textStyleFields(style, tokens, overridesOf(map.get('textStyleOverrides'))),
          (key) => map.get(key),
        )
        if (Object.keys(patch).length === 0) continue
        updateObject(objects, map.get('id') as string, patch as SlideObjectPatch<SlideObject>)
        changed++
      } else if (type === 'table') {
        const defaults = map.get('defaults')
        if (!(defaults instanceof Y.Map)) continue
        const sid = defaults.get('textStyleId')
        const style =
          typeof sid === 'string' && styleIds.has(sid) ? tokens.textStyles[sid] : undefined
        if (style === undefined) continue
        const patch = differingFields(
          textStyleFields(style, tokens, overridesOf(defaults.get('textStyleOverrides'))),
          (key) => defaults.get(key),
        )
        if (Object.keys(patch).length === 0) continue
        setTableDefaultsPatch(objects, map.get('id') as string, patch as Partial<TableDefaults>)
        changed++
      }
    }
  }
  return changed
}

function overridesOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((k): k is string => typeof k === 'string')
  if (value instanceof Y.Array)
    return value.toArray().filter((k): k is string => typeof k === 'string')
  return []
}

function differingFields(
  fields: Record<string, unknown>,
  current: (key: string) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (JSON.stringify(current(key)) !== JSON.stringify(value)) out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// The reverse: a style made from what a box shows
// ---------------------------------------------------------------------------

/** 0xRRGGBB as the '#rrggbb' a token stores. */
export function hexOf(color: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.trunc(color)))
    .toString(16)
    .padStart(6, '0')}`
}

/**
 * The text-style fields that reproduce a text box's (or a table's
 * defaults') own typography — what "Create new text style" and "Update
 * text style" in the Inspector take from the selected box. A colour
 * linked to a folder colour stays linked; `normal` / `bold` weights become
 * 400 / 700. Fields the box leaves unset are not taken.
 */
export function textStyleFieldsFromObject(obj: {
  fontFamily?: unknown
  fontWeight?: unknown
  fontSize?: unknown
  lineHeight?: unknown
  letterSpacing?: unknown
  paragraphSpaceBefore?: unknown
  paragraphSpaceAfter?: unknown
  color?: unknown
  textTransform?: unknown
}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof obj.fontFamily === 'string' && obj.fontFamily !== '') out['family'] = obj.fontFamily
  const weight =
    obj.fontWeight === 'bold' ? 700 : obj.fontWeight === 'normal' ? 400 : obj.fontWeight
  if (typeof weight === 'number') out['weight'] = weight
  if (typeof obj.fontSize === 'number') out['size'] = obj.fontSize
  if (typeof obj.lineHeight === 'number') out['lineHeight'] = obj.lineHeight
  out['letterSpacing'] = typeof obj.letterSpacing === 'number' ? obj.letterSpacing : 0
  out['paragraphSpaceBefore'] =
    typeof obj.paragraphSpaceBefore === 'number' ? obj.paragraphSpaceBefore : 0
  out['paragraphSpaceAfter'] =
    typeof obj.paragraphSpaceAfter === 'number' ? obj.paragraphSpaceAfter : 0
  if (typeof obj.color === 'number') out['color'] = hexOf(obj.color)
  else if (isTokenRef(obj.color) && obj.color.$token.startsWith('colors.'))
    out['color'] = { $token: obj.color.$token }
  out['textTransform'] =
    obj.textTransform === 'uppercase' ||
    obj.textTransform === 'lowercase' ||
    obj.textTransform === 'capitalize'
      ? obj.textTransform
      : 'none'
  return out
}
