/**
 * slide-model/src/folderPack.ts — a folder's style pack (agentic A4.3) in
 * its document (`folder:<id>`), next to the tokens (schema doc §4: packs
 * live in the folder document).
 *
 *   stylePack: Y.Map
 *     ├─ schemaVersion, id, name, canvas, …   plain values
 *     ├─ tokens, fonts, textStyles, grid, furniture, assets, editorial,
 *     │  qa, imagery, archetypeMap, provenance — nested Y.Maps, so two
 *     │  people changing different colours or styles merge
 *     ├─ layouts:    Y.Array<Y.Map>  (one per layout; arrays inside a layout
 *     └─ components: Y.Array<Y.Map>   — its regions — are plain values)
 *
 * The shape is the commands' (`StylePackSchema` + `validateStylePack` in
 * @narrative/shared); this module stores what it is given and reads back
 * plain JSON. A change is a JSON merge patch (RFC 7386) with one addition:
 * `layouts` and `components` may be patched by id — an object keyed by id,
 * whose entries merge into that layout (`null` removes it, a new id
 * appends it) — so one layout changes without resending the rest.
 * `mergeStylePackPatch` applies the same patch to plain JSON, so a caller
 * validates the result before anything is written.
 */

import * as Y from 'yjs'

/** Top-level pack parts kept as arrays of maps, patched by id. */
const BY_ID_PARTS = ['layouts', 'components'] as const
type ByIdPart = (typeof BY_ID_PARTS)[number]

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isByIdPart(key: string): key is ByIdPart {
  return (BY_ID_PARTS as readonly string[]).includes(key)
}

function packMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>('stylePack')
}

/** A plain value as stored: objects become Y.Maps (deep), arrays stay plain values. */
function toY(value: unknown): unknown {
  if (!isPlainObject(value)) return value
  const m = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(value)) {
    if (k === '__proto__' || v === undefined) continue
    m.set(k, toY(v))
  }
  return m
}

function toYArrayOfMaps(items: unknown[]): Y.Array<unknown> {
  const arr = new Y.Array<unknown>()
  arr.push(items.map((item) => toY(item)))
  return arr
}

/** The folder's style pack as plain JSON, or null when it has none. */
export function readStylePack(doc: Y.Doc): Record<string, unknown> | null {
  const m = packMap(doc)
  if (m.size === 0) return null
  return m.toJSON() as Record<string, unknown>
}

/** Whether the folder has a style pack. */
export function hasStylePack(doc: Y.Doc): boolean {
  return packMap(doc).size > 0
}

/** Replace the folder's style pack with `pack` (validated by the caller), in one transaction. */
export function setStylePack(doc: Y.Doc, pack: Record<string, unknown>): void {
  doc.transact(() => {
    const m = packMap(doc)
    for (const key of [...m.keys()]) if (!(key in pack)) m.delete(key)
    for (const [key, value] of Object.entries(pack)) {
      if (value === undefined) continue
      m.set(key, isByIdPart(key) && Array.isArray(value) ? toYArrayOfMaps(value) : toY(value))
    }
  })
}

/** Remove the folder's style pack. */
export function deleteStylePack(doc: Y.Doc): void {
  doc.transact(() => {
    const m = packMap(doc)
    for (const key of [...m.keys()]) m.delete(key)
  })
}

// ---------------------------------------------------------------------------
// Merge patch
// ---------------------------------------------------------------------------

/** RFC 7386 on plain JSON. */
function mergePlain(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch
  const base: Record<string, unknown> = isPlainObject(target) ? { ...target } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__') continue
    if (v === null) delete base[k]
    else base[k] = mergePlain(base[k], v)
  }
  return base
}

/** A by-id patch of `layouts` / `components` on plain JSON. */
function mergeById(items: unknown, patch: Record<string, unknown>): unknown[] {
  const list = Array.isArray(items) ? [...items] : []
  for (const [id, entry] of Object.entries(patch)) {
    const at = list.findIndex((it) => isPlainObject(it) && it['id'] === id)
    if (entry === null) {
      if (at !== -1) list.splice(at, 1)
    } else if (at === -1) {
      list.push(mergePlain({ id }, entry))
    } else {
      list[at] = mergePlain(list[at], entry)
    }
  }
  return list
}

/**
 * `patch` applied to the plain pack `pack` (null = none yet), as
 * `patchStylePack` will apply it to the document — for validating the
 * result first.
 */
export function mergeStylePackPatch(
  pack: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(pack ?? {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__') continue
    if (v === null) delete out[k]
    else if (isByIdPart(k) && isPlainObject(v)) out[k] = mergeById(out[k], v)
    else out[k] = mergePlain(out[k], v)
  }
  return out
}

function mergeIntoMap(m: Y.Map<unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__') continue
    const current = m.get(k)
    if (v === null) m.delete(k)
    else if (isPlainObject(v) && current instanceof Y.Map) mergeIntoMap(current, v)
    else m.set(k, toY(v))
  }
}

function mergeIntoArray(arr: Y.Array<unknown>, patch: Record<string, unknown>): void {
  for (const [id, entry] of Object.entries(patch)) {
    const items = arr.toArray()
    const at = items.findIndex((it) => it instanceof Y.Map && it.get('id') === id)
    if (entry === null) {
      if (at !== -1) arr.delete(at, 1)
    } else if (at === -1) {
      arr.push([toY({ id, ...(isPlainObject(entry) ? entry : {}) })])
    } else if (isPlainObject(entry)) {
      mergeIntoMap(items[at] as Y.Map<unknown>, entry)
    }
  }
}

/**
 * Apply a merge patch (validated by the caller on `mergeStylePackPatch`'s
 * result) to the folder's pack, touching only what it names, in one
 * transaction.
 */
export function patchStylePack(doc: Y.Doc, patch: Record<string, unknown>): void {
  doc.transact(() => {
    const m = packMap(doc)
    for (const [k, v] of Object.entries(patch)) {
      if (k === '__proto__') continue
      const current = m.get(k)
      if (v === null) m.delete(k)
      else if (isByIdPart(k) && Array.isArray(v)) m.set(k, toYArrayOfMaps(v))
      else if (isByIdPart(k) && isPlainObject(v)) {
        if (current instanceof Y.Array) mergeIntoArray(current, v)
        else m.set(k, toYArrayOfMaps(mergeById([], v)))
      } else if (isPlainObject(v) && current instanceof Y.Map) mergeIntoMap(current, v)
      else m.set(k, toY(v))
    }
  })
}
