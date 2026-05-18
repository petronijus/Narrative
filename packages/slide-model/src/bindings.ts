/**
 * slide-model/src/bindings.ts
 *
 * Konverze mezi plain SlideObject a Y.Map<unknown>.
 *
 * DŮLEŽITÉ: Y.Map musí být inicializován uvnitř Y.Doc před čtením/zápisem.
 * Standalone new Y.Map() bez doc kontextu nefunguje v Yjs 13+.
 * plainObjectToYMap() vrací Y.Map připravený pro insert do Y.Array uvnitř transact().
 *
 * Bindings nesmí importovat nic z Pixi ani React.
 */

import * as Y from 'yjs'
import type { SlideObject, TableCell, TableDefaults, TableObject } from '@narrative/shared'

/**
 * Konvertuje Y.Map na plain SlideObject.
 * Y.Map musí být integrovaný v Y.Doc (po insertu do Y.Array).
 *
 * @throws Pokud Y.Map neobsahuje platný `type` field.
 *
 * Shallow-passthrough — primitives, plain objects, Y.Text (TextObject
 * body) zůstávají jak jsou. The previous componentInstance overrides
 * deep-walk path is gone alongside the type itself.
 */
export function yMapToPlainObject<T extends SlideObject>(yMap: Y.Map<unknown>): T {
  const plain = Object.fromEntries(yMap.entries()) as Record<string, unknown>

  if (typeof plain['type'] !== 'string') {
    throw new Error('yMapToPlainObject: Y.Map missing required "type" field')
  }

  if (plain['type'] === 'table') {
    // Tables nest deeply (Y.Array of Y.Arrays of Y.Maps, each cell with
    // a Y.Text body). Unfold the structure so the renderer + inspector
    // see plain TableObject shape, but keep Y.Text bodies as references
    // — the HTMLText pipeline binds to them directly for collab typing.
    plain['rows'] = unwrapTableRows(yMap.get('rows'))
    plain['colWidths'] = unwrapNumberArray(yMap.get('colWidths'))
    plain['rowHeights'] = unwrapNumberArray(yMap.get('rowHeights'))
    plain['defaults'] = unwrapTableDefaults(yMap.get('defaults'))
    // `borderSegments` is a sparse Y.Map<string, plain-object>; absent
    // on freshly-created tables (legacy decks use cell.border instead
    // and the renderer derives effective segments at read time).
    const segs = yMap.get('borderSegments')
    if (segs instanceof Y.Map) {
      plain['borderSegments'] = Object.fromEntries(segs.entries())
    }
  }

  // Cast je justifikovaný: plainObjectToYMap() garantuje správný tvar při zápisu,
  // a yMapToPlainObject je vždy voláno na Y.Map vytvořené přes plainObjectToYMap.
  return plain as unknown as T
}

/**
 * Pull a Y.Array<number> out of a Y.Map slot to a plain number[].
 * Falls back to `[]` when the slot is missing or the wrong type.
 */
function unwrapNumberArray(value: unknown): number[] {
  if (!(value instanceof Y.Array)) return []
  const out: number[] = []
  for (let i = 0; i < value.length; i++) {
    const v = value.get(i)
    if (typeof v === 'number') out.push(v)
  }
  return out
}

/**
 * Y.Array<Y.Array<Y.Map>> → TableCell[][] preserving each cell's Y.Text
 * body. Pointer-cells (mergeOriginR/C set) stay in the grid so positional
 * indexing matches; renderer skips them.
 */
function unwrapTableRows(value: unknown): TableCell[][] {
  if (!(value instanceof Y.Array)) return []
  const rows: TableCell[][] = []
  for (let r = 0; r < value.length; r++) {
    const rowVal = value.get(r)
    if (!(rowVal instanceof Y.Array)) {
      rows.push([])
      continue
    }
    const row: TableCell[] = []
    for (let c = 0; c < rowVal.length; c++) {
      const cellY = rowVal.get(c)
      if (cellY instanceof Y.Map) {
        row.push(unwrapTableCell(cellY))
      } else {
        // Malformed cell — push an empty placeholder so [r][c] keeps lining up.
        row.push({ text: '' })
      }
    }
    rows.push(row)
  }
  return rows
}

function unwrapTableCell(yMap: Y.Map<unknown>): TableCell {
  const cell: Record<string, unknown> = {}
  yMap.forEach((value, key) => {
    if (key === 'border' || key === 'padding') {
      // Both are flat sub-objects — copy out keys.
      if (value instanceof Y.Map) {
        cell[key] = Object.fromEntries(value.entries())
      } else if (value !== null && typeof value === 'object') {
        cell[key] = { ...(value as Record<string, unknown>) }
      }
      return
    }
    cell[key] = value
  })
  if (!('text' in cell)) cell['text'] = ''
  return cell as unknown as TableCell
}

function unwrapTableDefaults(value: unknown): TableDefaults | undefined {
  if (!(value instanceof Y.Map)) {
    return value as TableDefaults | undefined
  }
  const out: Record<string, unknown> = {}
  value.forEach((v, k) => {
    if ((k === 'border' || k === 'padding') && v instanceof Y.Map) {
      out[k] = Object.fromEntries(v.entries())
    } else {
      out[k] = v
    }
  })
  return out as unknown as TableDefaults
}

/**
 * Vytvoří Y.Map naplněný daty z plain SlideObject.
 *
 * POZNÁMKA: Vrácený Y.Map musí být ihned vložen do Y.Array uvnitř doc.transact(),
 * než bude čten. Standalone Y.Map bez doc kontextu vrací undefined pro get().
 * Viz mutations.ts addObject() pro správné použití.
 */
export function plainObjectToYMap<T extends SlideObject>(obj: T): Y.Map<unknown> {
  const yMap = new Y.Map<unknown>()

  // Tables need nested Yjs containers — Y.Array for rows + col/row sizes,
  // Y.Map per cell, Y.Text for cell text. The standard flat copy below
  // would store plain JS arrays + objects which kills collab granularity
  // (any mutation would replace the whole rows array). Branch first.
  if (obj.type === 'table') {
    return buildTableYMap(obj as TableObject)
  }

  // Iterujeme přes entries — obj je plain object, unknown cast přes any je nutný
  // protože SlideObject diskriminované union nemá index signature.
  const entries = Object.entries(obj as unknown as Record<string, unknown>)
  for (const [key, value] of entries) {
    yMap.set(key, value)
  }

  return yMap
}

/**
 * Build the nested Yjs structure for a TableObject:
 *
 *   Y.Map {
 *     ...base fields (id, type, x, y, width, height, ...)
 *     colWidths:  Y.Array<number>
 *     rowHeights: Y.Array<number>
 *     defaults:   Y.Map (with `border` / `padding` as nested Y.Maps)
 *     rows:       Y.Array<Y.Array<Y.Map>>   ← cells
 *   }
 *
 * Each cell Y.Map carries its overrides as flat keys, plus a Y.Text
 * body keyed under `text`. Plain-string `cell.text` values get promoted
 * to Y.Text here so the renderer can bind HTMLText to them.
 *
 * NOTE: like the existing `plainObjectToYMap` the returned Y.Map MUST be
 * inserted into a Y.Array inside a `doc.transact()` before any read.
 */
function buildTableYMap(table: TableObject): Y.Map<unknown> {
  const yMap = new Y.Map<unknown>()

  // Base fields first — skip the nested ones; we set those explicitly
  // below with proper Yjs containers.
  const NESTED = new Set(['rows', 'colWidths', 'rowHeights', 'defaults', 'borderSegments'])
  for (const [key, value] of Object.entries(table as unknown as Record<string, unknown>)) {
    if (NESTED.has(key)) continue
    yMap.set(key, value)
  }

  const colWidths = new Y.Array<number>()
  if (table.colWidths.length > 0) colWidths.push(table.colWidths.slice())
  yMap.set('colWidths', colWidths)

  const rowHeights = new Y.Array<number>()
  if (table.rowHeights.length > 0) rowHeights.push(table.rowHeights.slice())
  yMap.set('rowHeights', rowHeights)

  yMap.set('defaults', buildTableDefaultsYMap(table.defaults))

  const rows = new Y.Array<Y.Array<Y.Map<unknown>>>()
  for (const row of table.rows) {
    const rowY = new Y.Array<Y.Map<unknown>>()
    for (const cell of row) {
      rowY.push([buildTableCellYMap(cell)])
    }
    rows.push([rowY])
  }
  yMap.set('rows', rows)

  if (table.borderSegments !== undefined) {
    const segs = new Y.Map<unknown>()
    for (const [k, v] of Object.entries(table.borderSegments)) segs.set(k, v)
    yMap.set('borderSegments', segs)
  }

  return yMap
}

function buildTableDefaultsYMap(defaults: TableDefaults): Y.Map<unknown> {
  const y = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(defaults as unknown as Record<string, unknown>)) {
    if (k === 'border' && v !== undefined && v !== null && typeof v === 'object') {
      const sub = new Y.Map<unknown>()
      for (const [bk, bv] of Object.entries(v as Record<string, unknown>)) sub.set(bk, bv)
      y.set(k, sub)
    } else if (k === 'padding' && v !== undefined && v !== null && typeof v === 'object') {
      const sub = new Y.Map<unknown>()
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) sub.set(pk, pv)
      y.set(k, sub)
    } else {
      y.set(k, v)
    }
  }
  return y
}

function buildTableCellYMap(cell: TableCell): Y.Map<unknown> {
  const y = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(cell as unknown as Record<string, unknown>)) {
    if (k === 'text') {
      // Promote any incoming string to an EMPTY Y.Text — the actual
      // content gets inserted post-integration by the caller (addObject
      // does this inside its transact). Why: a standalone Y.Text's
      // `_pending` ops don't fire when the Y.Text is integrated via
      // deeply-nested Y.Array containers (cell → row Y.Array → rows
      // Y.Array → table Y.Map). Two-phase init avoids the trap.
      // Existing Y.Text references (already integrated) pass through.
      if (v instanceof Y.Text) {
        y.set('text', v)
      } else {
        y.set('text', new Y.Text())
      }
    } else if (
      (k === 'border' || k === 'padding') &&
      v !== undefined &&
      v !== null &&
      typeof v === 'object'
    ) {
      const sub = new Y.Map<unknown>()
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) sub.set(sk, sv)
      y.set(k, sub)
    } else {
      y.set(k, v)
    }
  }
  // Note: don't call y.has('text') here — Y.Map operations before integration
  // emit "premature access" warnings. The loop above already guarantees a
  // 'text' entry whenever cell.text is defined; cells should always carry it.
  return y
}

/**
 * Companion to `buildTableYMap`: extracts initial cell text values from
 * a plain TableObject so the caller can apply them via `yText.insert()`
 * AFTER the Y.Map is integrated into the doc. Standalone-Y.Text
 * `_pending` doesn't survive deep-nested integration in Yjs 13; this is
 * the canonical workaround.
 *
 * Returns `[{ r, c, initial }]` for every cell whose `.text` is a
 * non-empty string. Cells with empty strings or pre-built Y.Text
 * references are skipped.
 */
export interface PendingCellTextInsert {
  r: number
  c: number
  initial: string
}

export function collectPendingCellTextInserts(table: {
  rows: TableCell[][]
}): PendingCellTextInsert[] {
  const out: PendingCellTextInsert[] = []
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r]!
    for (let c = 0; c < row.length; c++) {
      const t = row[c]!.text
      if (typeof t === 'string' && t.length > 0) {
        out.push({ r, c, initial: t })
      }
    }
  }
  return out
}

/**
 * Varianta pro testování: vytvoří Y.Map integrovaný v doc.
 * Hodnoty jsou čitelné ihned po volání (doc kontext je zajištěn).
 *
 * @internal Pro použití v bindings.test.ts a jiných testech
 */
export function plainObjectToYMapInDoc<T extends SlideObject>(doc: Y.Doc, obj: T): Y.Map<unknown> {
  const tempArr = doc.getArray<Y.Map<unknown>>('__temp_bindings_test')
  const yMap = new Y.Map<unknown>()

  doc.transact(() => {
    const entries = Object.entries(obj as unknown as Record<string, unknown>)
    for (const [key, value] of entries) {
      yMap.set(key, value)
    }
    tempArr.push([yMap])
  })

  return yMap
}
