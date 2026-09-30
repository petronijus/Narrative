/**
 * slide-model/src/folderDoc.ts — a folder's design-token document
 * (`folder:<id>`), read and written in one place.
 *
 *   tokens: Y.Map
 *     ├─ colors:       Y.Map<id → Y.Map { id, name, value: '#rrggbb' }>
 *     ├─ textStyles:   Y.Map<id → Y.Map { id, name, family?, weight?, size?,
 *     │                                   lineHeight?, letterSpacing?,
 *     │                                   paragraphSpaceBefore?, paragraphSpaceAfter?,
 *     │                                   color? ('#rrggbb' | { $token }),
 *     │                                   textTransform?, builtin? }>
 *     └─ effectStyles: Y.Map<id → Y.Map { id, name, kind, params: Y.Map }>
 *
 * The editor reads the document live (FolderDocProvider), the server reads
 * and writes it for the token commands; both go through these functions, so
 * a token reads the same everywhere. Writers take the document and run in
 * one transaction (nested in the caller's, whose origin wins). Ids are the
 * caller's — the server makes them — so the functions stay deterministic.
 *
 * Until A2.12 the browser seeded and migrated a folder when someone opened
 * it; the server now seeds at creation (and `token.seedDefaults`), and
 * nothing writes the document because it was viewed.
 */

import * as Y from 'yjs'
import { DEFAULT_COLORS, DEFAULT_TEXT_STYLES } from './defaultTokens.js'
import type {
  ColorTokenSnapshot,
  EffectStyleTokenSnapshot,
  FolderTokensSnapshot,
  TextStyleTokenSnapshot,
} from './tokens.js'

export type TokenCategory = 'colors' | 'textStyles' | 'effectStyles'

export const TOKEN_CATEGORIES: ReadonlyArray<TokenCategory> = [
  'colors',
  'textStyles',
  'effectStyles',
]

/** The name the seeded footnote style had before 2026-09 ("Footnotes and pages" since). */
const LEGACY_FOOTNOTE_NAME = 'footnote'
const FOOTNOTE_NAME = 'Footnotes and pages'

function tokensRoot(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>('tokens')
}

function categoryMap(doc: Y.Doc, category: TokenCategory): Y.Map<Y.Map<unknown>> | null {
  const cat = tokensRoot(doc).get(category)
  return cat instanceof Y.Map ? (cat as Y.Map<Y.Map<unknown>>) : null
}

/** The category's map, created when missing. Call inside a transaction. */
function ensureCategoryMap(doc: Y.Doc, category: TokenCategory): Y.Map<Y.Map<unknown>> {
  const existing = categoryMap(doc, category)
  if (existing !== null) return existing
  const created = new Y.Map<Y.Map<unknown>>()
  tokensRoot(doc).set(category, created as unknown)
  return created
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function readColor(id: string, m: Y.Map<unknown>): ColorTokenSnapshot | null {
  const name = m.get('name')
  const value = m.get('value')
  if (typeof name !== 'string' || typeof value !== 'string') return null
  return { id, name, value }
}

function readTextStyle(id: string, m: Y.Map<unknown>): TextStyleTokenSnapshot | null {
  const name = m.get('name')
  if (typeof name !== 'string') return null
  const out: TextStyleTokenSnapshot = { id, name }
  const family = m.get('family')
  if (typeof family === 'string') out.family = family
  for (const key of [
    'weight',
    'size',
    'lineHeight',
    'letterSpacing',
    'paragraphSpaceBefore',
    'paragraphSpaceAfter',
  ] as const) {
    const v = m.get(key)
    if (typeof v === 'number') out[key] = v
  }
  if (m.get('builtin') === true) out.builtin = true
  const textTransform = m.get('textTransform')
  if (
    textTransform === 'uppercase' ||
    textTransform === 'lowercase' ||
    textTransform === 'capitalize' ||
    textTransform === 'none'
  ) {
    out.textTransform = textTransform
  }
  // A hex string, or a reference to one of the folder's colours.
  const color = m.get('color')
  if (typeof color === 'string') out.color = color
  else if (
    typeof color === 'object' &&
    color !== null &&
    typeof (color as Record<string, unknown>)['$token'] === 'string'
  ) {
    out.color = { $token: (color as { $token: string }).$token }
  }
  return out
}

function readEffectStyle(id: string, m: Y.Map<unknown>): EffectStyleTokenSnapshot | null {
  const name = m.get('name')
  const kind = m.get('kind')
  if (typeof name !== 'string' || (kind !== 'shadow' && kind !== 'blur')) return null
  const params: Record<string, unknown> = {}
  const paramsMap = m.get('params')
  if (paramsMap instanceof Y.Map) paramsMap.forEach((v, k) => (params[k] = v))
  return { id, name, kind, params }
}

function readCategory<T>(
  map: Y.Map<Y.Map<unknown>> | null,
  read: (id: string, m: Y.Map<unknown>) => T | null,
): Record<string, T> {
  const out: Record<string, T> = {}
  map?.forEach((entry, id) => {
    // A key that names Object.prototype would set the snapshot's prototype.
    if (!(entry instanceof Y.Map) || id === '__proto__') return
    const value = read(id, entry)
    if (value !== null) out[id] = value
  })
  return out
}

/**
 * The folder's tokens as a plain snapshot; malformed entries are left out.
 * A token's id is its key in the category map (the stored `id` field
 * mirrors it; older documents may lack it).
 */
export function readFolderTokens(doc: Y.Doc): FolderTokensSnapshot {
  return {
    colors: readCategory(categoryMap(doc, 'colors'), readColor),
    textStyles: readCategory(categoryMap(doc, 'textStyles'), readTextStyle),
    effectStyles: readCategory(categoryMap(doc, 'effectStyles'), readEffectStyle),
  }
}

/** Whether the folder has no tokens at all. */
export function hasNoTokens(snapshot: FolderTokensSnapshot): boolean {
  return (
    Object.keys(snapshot.colors).length === 0 &&
    Object.keys(snapshot.textStyles).length === 0 &&
    Object.keys(snapshot.effectStyles).length === 0
  )
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function setFields(m: Y.Map<unknown>, fields: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'id') continue
    if (value === undefined) {
      m.delete(key)
    } else if (key === 'params' && typeof value === 'object' && value !== null) {
      const params = new Y.Map<unknown>()
      for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) params.set(pk, pv)
      m.set('params', params)
    } else {
      m.set(key, value)
    }
  }
}

/** Add a token under `id` with `fields` (`undefined` values are left out). */
export function addFolderToken(
  doc: Y.Doc,
  category: TokenCategory,
  id: string,
  fields: Record<string, unknown>,
): void {
  doc.transact(() => {
    const m = new Y.Map<unknown>()
    ensureCategoryMap(doc, category).set(id, m)
    m.set('id', id)
    setFields(m, fields)
  })
}

/**
 * Change fields of a token; `undefined` removes a field. False when the
 * token does not exist (nothing written).
 */
export function updateFolderToken(
  doc: Y.Doc,
  category: TokenCategory,
  id: string,
  patch: Record<string, unknown>,
): boolean {
  const m = categoryMap(doc, category)?.get(id)
  if (!(m instanceof Y.Map)) return false
  doc.transact(() => setFields(m, patch))
  return true
}

/** Remove a token. False when it does not exist (nothing written). */
export function deleteFolderToken(doc: Y.Doc, category: TokenCategory, id: string): boolean {
  const cat = categoryMap(doc, category)
  if (cat === null || !cat.has(id)) return false
  doc.transact(() => cat.delete(id))
  return true
}

/**
 * Give a folder that has neither colours nor text styles the default
 * palette and text styles (the text styles' colours reference the seeded
 * colours; they are `builtin`, so they cannot be deleted). Idempotent:
 * a folder with any colour or text style is left alone, so a folder whose
 * owner removed the defaults is not refilled. `newId` makes the ids.
 * Returns whether anything was written.
 */
export function seedDefaultTokens(doc: Y.Doc, newId: () => string): boolean {
  const colors = categoryMap(doc, 'colors')
  const textStyles = categoryMap(doc, 'textStyles')
  if ((colors?.size ?? 0) > 0 || (textStyles?.size ?? 0) > 0) return false
  doc.transact(() => {
    const idByKey = new Map<string, string>()
    for (const c of DEFAULT_COLORS) {
      const id = newId()
      idByKey.set(c.key, id)
      addFolderToken(doc, 'colors', id, { name: c.name, value: c.value })
    }
    for (const ts of DEFAULT_TEXT_STYLES) {
      const colorId = idByKey.get(ts.colorKey)
      addFolderToken(doc, 'textStyles', newId(), {
        name: ts.name,
        family: ts.family,
        weight: ts.weight,
        size: ts.size,
        lineHeight: ts.lineHeight,
        letterSpacing: ts.letterSpacing,
        builtin: true,
        ...(colorId !== undefined ? { color: { $token: `colors.${colorId}` } } : {}),
      })
    }
  })
  return true
}

/**
 * Bring a folder seeded by an older build up to date. Idempotent:
 *   - text styles named like a default one and seeded before the `builtin`
 *     flag existed get it (so they stay undeletable);
 *   - the seeded "Footnote" style is named "Footnotes and pages" (a
 *     user-made "Footnote" — explicitly not builtin — is left alone).
 * Returns whether anything was written.
 */
export function migrateFolderTokens(doc: Y.Doc): boolean {
  const textStyles = categoryMap(doc, 'textStyles')
  if (textStyles === null || textStyles.size === 0) return false
  const builtinNames = new Set(DEFAULT_TEXT_STYLES.map((s) => s.name.toLowerCase()))
  const changes: Array<() => void> = []
  textStyles.forEach((m) => {
    if (!(m instanceof Y.Map)) return
    const name = m.get('name')
    if (typeof name !== 'string') return
    const builtin = m.get('builtin')
    if (name.toLowerCase() === LEGACY_FOOTNOTE_NAME && builtin !== false) {
      changes.push(() => {
        m.set('name', FOOTNOTE_NAME)
        m.set('builtin', true)
      })
    } else if (builtin === undefined && builtinNames.has(name.toLowerCase())) {
      changes.push(() => m.set('builtin', true))
    }
  })
  if (changes.length === 0) return false
  doc.transact(() => changes.forEach((c) => c()))
  return true
}
