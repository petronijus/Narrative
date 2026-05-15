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
const CLIPS_TAG = Symbol('tableClips')
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

/**
 * For each cell, mount a sub-Container holding the Pixi.Text + a
 * Graphics mask that clips text to the cell's inner padding box.
 * Without the mask, a long string would draw past the cell border —
 * the user sees this as text "overflowing the cell" the moment the
 * inline editor closes. We return the masks alongside the texts so
 * `rebuild()` can destroy them on update.
 */
function paintTexts(
  parent: Container,
  table: TableObject,
  colX: number[],
  rowY: number[],
): { texts: Text[]; clips: Container[] } {
  const texts: Text[] = []
  const clips: Container[] = []
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r]!
    for (let c = 0; c < row.length; c++) {
      const bbox = cellBbox(table, r, c, colX, rowY)
      if (bbox === null) continue
      const cell = row[c]!
      const style = resolveCellStyle(table, cell)
      const textValue = typeof cell.text === 'string' ? cell.text : (cell.text?.toString() ?? '')
      if (textValue.length === 0) continue
      const innerW = Math.max(1, bbox.w - style.padding.left - style.padding.right)
      const innerH = Math.max(1, bbox.h - style.padding.top - style.padding.bottom)
      const styleObj: ConstructorParameters<typeof TextStyle>[0] = {
        fontSize: style.fontSize,
        fontWeight: style.fontWeight as TextStyle['fontWeight'],
        fill: style.color,
        align: style.align,
        wordWrap: true,
        wordWrapWidth: innerW,
        // Break mid-word too — without this, a long unbroken string
        // ("aaaaaaaaaaaaaaa") would only wrap on whitespace, blowing
        // past the cell border and getting clipped to a single line.
        breakWords: true,
      }
      if (style.fontFamily !== undefined) styleObj.fontFamily = style.fontFamily
      const t = new Text({ text: textValue, style: new TextStyle(styleObj) })
      t.anchor.set(0, 0)
      // Horizontal align inside the inner box.
      let tx = style.padding.left
      if (style.align === 'center') tx = style.padding.left + (innerW - t.width) / 2
      else if (style.align === 'right') tx = bbox.w - style.padding.right - t.width
      // Vertical align inside the inner box.
      let ty = style.padding.top
      if (style.vAlign === 'middle') ty = style.padding.top + (innerH - t.height) / 2
      else if (style.vAlign === 'bottom') ty = bbox.h - style.padding.bottom - t.height
      t.x = tx
      t.y = ty
      // Wrap the Text in a clip Container so overflowing glyphs don't
      // leak past the cell boundary (long words, multi-line text in a
      // short row, etc.). The mask Graphics covers exactly the cell
      // bbox; both are positioned at (bbox.x, bbox.y) so children draw
      // in local coords relative to the cell's top-left.
      const clip = new Container()
      clip.x = bbox.x
      clip.y = bbox.y
      const mask = new Graphics()
      mask.rect(0, 0, bbox.w, bbox.h).fill({ color: 0xffffff })
      clip.addChild(mask)
      clip.addChild(t)
      clip.mask = mask
      parent.addChild(clip)
      texts.push(t)
      clips.push(clip)
    }
  }
  return { texts, clips }
}

function rebuild(container: Container, data: TableObject): void {
  const colX = cumulativeCols(data)
  const rowY = cumulativeRows(data)
  const tagged = container as Container & { [k: symbol]: unknown }
  // Wipe previous state. Clip Containers own both their mask Graphics
  // and the Pixi.Text child, so destroying them with `children:true`
  // tears the whole sub-tree down in one call.
  const prevGrid = tagged[GRID_TAG] as Graphics | undefined
  const prevClips = tagged[CLIPS_TAG] as Container[] | undefined
  if (prevGrid !== undefined) prevGrid.destroy({ children: false, texture: false })
  if (prevClips !== undefined) {
    for (const clip of prevClips)
      clip.destroy({ children: true, texture: true, textureSource: true })
  }
  container.removeChildren()
  const grid = new Graphics()
  paintGrid(grid, data, colX, rowY)
  container.addChild(grid)
  const { texts, clips } = paintTexts(container, data, colX, rowY)
  tagged[GRID_TAG] = grid
  tagged[TEXTS_TAG] = texts
  tagged[CLIPS_TAG] = clips
  tagged[DATA_TAG] = data
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
    const tagged = node as Container & { [k: symbol]: unknown }
    const grid = tagged[GRID_TAG] as Graphics | undefined
    if (grid !== undefined) grid.destroy({ children: false, texture: false })
    const clips = tagged[CLIPS_TAG] as Container[] | undefined
    if (clips !== undefined) {
      for (const clip of clips) clip.destroy({ children: true, texture: true, textureSource: true })
    }
    destroyFilterEffects(node)
    node.destroy({ children: true })
  },
}
