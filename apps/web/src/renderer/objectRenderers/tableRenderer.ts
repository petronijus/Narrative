/**
 * renderer/objectRenderers/tableRenderer.ts
 *
 * M29 Phase 1 — read-only Pixi renderer for the first-class TableObject.
 *
 * Layout:
 *   Container (positioned at table.x/table.y, rotated, opacity)
 *   ├── Graphics  (cell fills + grid lines + borders)
 *   └── Text × (rows × cols)  (per-cell text, single style per cell)
 *
 * Cell text uses Pixi.Text — Phase 2 swaps in HTMLText for per-run rich
 * formatting. Pointer cells (mergeOriginR/C set) skip drawing so the
 * origin cell can paint over the full merged area.
 *
 * Diffing is whole-table for Phase 1: any change to the table triggers
 * a full re-mount of the cells. Per-cell diff (Phase 5 polish) keeps the
 * existing children alive when only one cell changed.
 */

import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import type { ObjectRenderer } from './index.js'
import type { TableObject, TableCell, TableBorderStyle } from '@narrative/shared'
import { applyFilterEffects, destroyFilterEffects } from '../filterEffects.js'
import { resolveColour } from '../colourResolver.js'

const GRID_TAG = Symbol('tableGrid')
const TEXTS_TAG = Symbol('tableTexts')
const DATA_TAG = Symbol('tableData')

/**
 * Convert a TableBorderStyle's color slot (may be a TokenRef) to a
 * concrete hex number. Falls back to the default border colour when
 * the resolution fails — keeps the grid visible during token loading.
 */
function resolveBorderColour(b: TableBorderStyle | undefined, fallback: number): number {
  if (b === undefined) return fallback
  const resolved = resolveColour(b.color)
  return resolved === 0 ? fallback : resolved
}

function applyObjectTransform(container: Container, data: TableObject): void {
  // Pivot at centre for natural rotation; compensate position so that
  // data.x/data.y remain the table's top-left in world space (matches
  // rectangle / ellipse renderer convention — see rectangleRenderer.ts).
  container.pivot.set(data.width / 2, data.height / 2)
  container.x = data.x + data.width / 2
  container.y = data.y + data.height / 2
  container.rotation = data.rotation
  container.alpha = data.opacity
}

/**
 * Compute cumulative x offsets for column boundaries. Returns an array
 * of length `colWidths.length + 1`, where `[i]` is the left edge of
 * column `i` (and `[length-1]` is the right edge of the table). Same
 * scheme for row Y offsets via `cumulativeRows`.
 */
/**
 * Cumulative column edges scaled to fit `table.width`. `colWidths` is
 * treated as a proportion vector — its sum may not match `table.width`
 * after a bbox resize, so we rescale uniformly. Phase 2 column drag
 * handles will mutate the entries directly; this scaling keeps things
 * consistent until then. `cumulativeRows` does the same for height.
 */
function cumulativeCols(table: TableObject): number[] {
  const out: number[] = [0]
  const total = table.colWidths.reduce((a, b) => a + b, 0) || 1
  const scale = table.width / total
  let acc = 0
  for (const w of table.colWidths) {
    acc += w * scale
    out.push(acc)
  }
  return out
}

function cumulativeRows(table: TableObject): number[] {
  const out: number[] = [0]
  const total = table.rowHeights.reduce((a, b) => a + b, 0) || 1
  const scale = table.height / total
  let acc = 0
  for (const h of table.rowHeights) {
    acc += h * scale
    out.push(acc)
  }
  return out
}

/**
 * Compute the (x, y, w, h) bbox of one cell, accounting for merge spans.
 * Pointer cells (mergeOrigin set) return `null` so the renderer can skip
 * them — the origin draws their area instead.
 */
function cellBbox(
  table: TableObject,
  r: number,
  c: number,
  colX: number[],
  rowY: number[],
): { x: number; y: number; w: number; h: number } | null {
  const cell = table.rows[r]?.[c]
  if (cell === undefined) return null
  if (cell.mergeOriginR !== undefined || cell.mergeOriginC !== undefined) return null
  const span = Math.max(1, cell.gridSpan ?? 1)
  const rowSpan = Math.max(1, cell.rowSpan ?? 1)
  const x = colX[c]!
  const y = rowY[r]!
  const right = colX[Math.min(c + span, colX.length - 1)]!
  const bottom = rowY[Math.min(r + rowSpan, rowY.length - 1)]!
  return { x, y, w: right - x, h: bottom - y }
}

/**
 * Resolve a cell's effective styling — falls through cell override →
 * table default → built-in safe value.
 */
interface ResolvedCellStyle {
  fontSize: number
  fontWeight: string | number
  color: number
  align: 'left' | 'center' | 'right'
  vAlign: 'top' | 'middle' | 'bottom'
  fontFamily: string | undefined
  fill: number | undefined
  fillAlpha: number
  padding: { top: number; right: number; bottom: number; left: number }
}

function resolveCellStyle(table: TableObject, cell: TableCell): ResolvedCellStyle {
  const d = table.defaults
  const padding = cell.padding ?? d.padding
  const fontWeight = cell.fontWeight ?? d.fontWeight
  const colorRaw = resolveColour(cell.color ?? d.color)
  return {
    fontSize: cell.fontSize ?? d.fontSize,
    fontWeight,
    color: colorRaw === 0 ? 0x111111 : colorRaw,
    align: cell.align ?? d.align,
    vAlign: cell.vAlign ?? d.vAlign,
    fontFamily: d.fontFamily,
    fill: cell.fill !== undefined ? resolveColour(cell.fill) || 0xffffff : undefined,
    fillAlpha: cell.fillAlpha ?? 1,
    padding,
  }
}

function paintGrid(grid: Graphics, table: TableObject, colX: number[], rowY: number[]): void {
  grid.clear()
  // 1) Per-cell fills first — drawn under the borders.
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r]!
    for (let c = 0; c < row.length; c++) {
      const bbox = cellBbox(table, r, c, colX, rowY)
      if (bbox === null) continue
      const style = resolveCellStyle(table, row[c]!)
      if (style.fill !== undefined) {
        grid.rect(bbox.x, bbox.y, bbox.w, bbox.h)
        grid.fill({ color: style.fill, alpha: style.fillAlpha })
      }
    }
  }
  // 2) Per-cell borders — single uniform stroke per cell for Phase 1.
  //    Phase 2 expands to honour per-edge cell.border overrides.
  const defaultBorder = table.defaults.border
  const defaultColor = resolveBorderColour(defaultBorder, 0xcccccc)
  const defaultWidth = defaultBorder?.width ?? 1
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r]!
    for (let c = 0; c < row.length; c++) {
      const bbox = cellBbox(table, r, c, colX, rowY)
      if (bbox === null) continue
      grid.rect(bbox.x, bbox.y, bbox.w, bbox.h)
      grid.stroke({ color: defaultColor, width: defaultWidth, alpha: 1 })
    }
  }
}

function paintTexts(parent: Container, table: TableObject, colX: number[], rowY: number[]): Text[] {
  const out: Text[] = []
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r]!
    for (let c = 0; c < row.length; c++) {
      const bbox = cellBbox(table, r, c, colX, rowY)
      if (bbox === null) continue
      const cell = row[c]!
      const style = resolveCellStyle(table, cell)
      const textValue = typeof cell.text === 'string' ? cell.text : (cell.text?.toString() ?? '')
      if (textValue.length === 0) continue
      const styleObj: ConstructorParameters<typeof TextStyle>[0] = {
        fontSize: style.fontSize,
        fontWeight: style.fontWeight as TextStyle['fontWeight'],
        fill: style.color,
        align: style.align,
        wordWrap: true,
        wordWrapWidth: Math.max(1, bbox.w - style.padding.left - style.padding.right),
      }
      if (style.fontFamily !== undefined) styleObj.fontFamily = style.fontFamily
      const t = new Text({ text: textValue, style: new TextStyle(styleObj) })
      // Anchor at top-left to make manual positioning predictable.
      t.anchor.set(0, 0)
      const innerW = bbox.w - style.padding.left - style.padding.right
      const innerH = bbox.h - style.padding.top - style.padding.bottom
      // Horizontal align inside the inner box.
      let tx = bbox.x + style.padding.left
      if (style.align === 'center') tx = bbox.x + style.padding.left + (innerW - t.width) / 2
      else if (style.align === 'right') tx = bbox.x + bbox.w - style.padding.right - t.width
      // Vertical align inside the inner box.
      let ty = bbox.y + style.padding.top
      if (style.vAlign === 'middle') ty = bbox.y + style.padding.top + (innerH - t.height) / 2
      else if (style.vAlign === 'bottom') ty = bbox.y + bbox.h - style.padding.bottom - t.height
      t.x = tx
      t.y = ty
      parent.addChild(t)
      out.push(t)
    }
  }
  return out
}

function rebuild(container: Container, data: TableObject): void {
  const colX = cumulativeCols(data)
  const rowY = cumulativeRows(data)
  // Wipe previous state — grid + per-cell Texts are stored under separate
  // symbol tags (see end of this function), so look both up directly.
  const prevGrid = (container as Container & { [k: symbol]: unknown })[GRID_TAG] as
    | Graphics
    | undefined
  const prevTexts = (container as Container & { [k: symbol]: unknown })[TEXTS_TAG] as
    | Text[]
    | undefined
  if (prevGrid !== undefined) prevGrid.destroy({ children: false, texture: false })
  if (prevTexts !== undefined) {
    for (const t of prevTexts) t.destroy({ children: false, texture: true, textureSource: true })
  }
  container.removeChildren()
  const grid = new Graphics()
  paintGrid(grid, data, colX, rowY)
  container.addChild(grid)
  const texts = paintTexts(container, data, colX, rowY)
  ;(container as Container & { [k: symbol]: unknown })[GRID_TAG] = grid
  ;(container as Container & { [k: symbol]: unknown })[TEXTS_TAG] = texts
  ;(container as Container & { [k: symbol]: unknown })[DATA_TAG] = data
  applyObjectTransform(container, data)
}

export const tableRenderer: ObjectRenderer<TableObject> = {
  type: 'table',
  mount(data) {
    const container = new Container()
    rebuild(container, data)
    applyFilterEffects(container, data.shadow, data.blur)
    return container
  },
  update(node, _prev, next) {
    rebuild(node, next)
    applyFilterEffects(node, next.shadow, next.blur)
  },
  destroy(node) {
    const cache = (node as Container & { [k: symbol]: unknown })[GRID_TAG] as Graphics | undefined
    if (cache !== undefined) cache.destroy({ children: false, texture: false })
    const texts = (node as Container & { [k: symbol]: unknown })[TEXTS_TAG] as Text[] | undefined
    if (texts !== undefined) {
      for (const t of texts) {
        t.destroy({ children: false, texture: true, textureSource: true })
      }
    }
    destroyFilterEffects(node)
    node.destroy({ children: true })
  },
}
