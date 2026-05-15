/**
 * renderer/objectRenderers/tableRenderer.ts
 *
 * M29 Phase 3 — Pixi renderer for the first-class TableObject.
 *
 * Each cell hosts a `Pixi.HTMLText` rendered through the SAME pipeline
 * the TextObject renderer uses (`buildHtml` / `buildStyleOpts` /
 * `wireRedrawOnAsyncTextureUpdate` / `scheduleAsyncTextureCatchup` /
 * `applyHorizontalAlign` / `applyVerticalAlign`). Per-cell HTMLText
 * sub-nodes are kept alive across rebuilds (keyed by the cell's Y.Text
 * identity) so:
 *   - Custom fonts, italic/underline/per-run color survive (HTMLText
 *     renders SVG).
 *   - Async rasterisation never collides with a synchronous destroy
 *     (the old "Cannot read properties of null (_getFinalPadding)"
 *     crash).
 *
 * Layout:
 *   Container (positioned/rotated as the TableObject)
 *   ├── Graphics  (cell fills + grid lines)
 *   └── per cell:
 *        Container (clip)  — positioned at cell bbox, masks overflow
 *           ├── Graphics  (mask)
 *           └── HTMLText  (anchored by `applyHorizontalAlign` /
 *                          `applyVerticalAlign` within the inner pad box)
 */

import { Container, Graphics, HTMLText, HTMLTextStyle } from 'pixi.js'
import * as Y from 'yjs'
import type { ObjectRenderer } from './index.js'
import { isTokenRef } from '@narrative/shared'
import type {
  TableObject,
  TableCell,
  TableBorderStyle,
  TextObject,
  FontWeight,
} from '@narrative/shared'
import {
  buildHtml,
  buildStyleOpts,
  applyHorizontalAlign,
  applyVerticalAlign,
  scheduleAsyncTextureCatchup,
  wireRedrawOnAsyncTextureUpdate,
} from './textRenderer.js'
import { applyFilterEffects, destroyFilterEffects } from '../filterEffects.js'
import { resolveColour } from '../colourResolver.js'

/** Default font stack — kept in lockstep with TextEditOverlay so cell
 *  text glyphs sit on the same baselines between edit and render. */
const DEFAULT_FONT_STACK = 'system-ui, -apple-system, sans-serif'

const GRID_TAG = Symbol('tableGrid')
const CELLS_TAG = Symbol('tableCellNodes')
const FADED_TAG = Symbol('tableFadedCell')

/**
 * One rendered cell — kept alive across rebuilds so Pixi's HTMLText
 * async rasterisation isn't torn down underneath itself. Keyed by the
 * cell's Y.Text identity in the parent map.
 */
interface CellNode {
  yText: Y.Text
  clip: Container
  mask: Graphics
  htmlText: HTMLText
}

function resolveBorderColour(b: TableBorderStyle | undefined, fallback: number): number {
  if (b === undefined) return fallback
  // Direct numeric value — return as-is so pure black (0x000000) survives.
  // The fallback-on-0 dance below is only meaningful for TokenRef inputs,
  // because `resolveColour` returns 0 BOTH for "not a token" and for
  // "token failed to resolve". For literal numbers there's nothing to
  // distinguish, so we trust the user's pick.
  if (typeof b.color === 'number') return b.color
  if (!isTokenRef(b.color)) return fallback
  const resolved = resolveColour(b.color)
  return resolved === 0 ? fallback : resolved
}

function applyObjectTransform(container: Container, data: TableObject): void {
  container.pivot.set(data.width / 2, data.height / 2)
  container.x = data.x + data.width / 2
  container.y = data.y + data.height / 2
  container.rotation = data.rotation
  container.alpha = data.opacity
}

/**
 * Cumulative column edges scaled to fit `table.width`. The CRDT stores
 * `colWidths` as a proportion vector; the renderer rescales uniformly
 * so the user's bbox resize (Phase 1 transform handles) updates the
 * cell layout without mutating the proportions.
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

interface ResolvedCellStyle {
  fontSize: number
  fontWeight: FontWeight
  color: number
  align: 'left' | 'center' | 'right'
  vAlign: 'top' | 'middle' | 'bottom'
  fontFamily: string
  fill: number | undefined
  fillAlpha: number
  padding: { top: number; right: number; bottom: number; left: number }
}

function resolveCellStyle(table: TableObject, cell: TableCell): ResolvedCellStyle {
  const d = table.defaults
  const padding = cell.padding ?? d.padding
  const fontWeight = (cell.fontWeight ?? d.fontWeight) as FontWeight
  // Distinguish literal numbers (trust as-is — preserves pure black /
  // 0x000000) from TokenRef inputs (fall back when the token didn't
  // resolve). The legacy `resolveColour(x) === 0 ? fallback : x` pattern
  // can't tell the two apart because resolveColour returns 0 for both
  // "input was the number 0" and "token failed to resolve".
  const colorSrc = cell.color ?? d.color
  const color =
    typeof colorSrc === 'number'
      ? colorSrc
      : isTokenRef(colorSrc)
        ? resolveColour(colorSrc) || 0x111111
        : 0x111111
  // Same logic for the cell fill — undefined means "no fill"; a literal
  // 0 means "fill with black" and must survive.
  const fillSrc = cell.fill
  const fill =
    fillSrc === undefined
      ? undefined
      : typeof fillSrc === 'number'
        ? fillSrc
        : isTokenRef(fillSrc)
          ? resolveColour(fillSrc) || 0xffffff
          : 0xffffff
  return {
    fontSize: cell.fontSize ?? d.fontSize,
    fontWeight,
    color,
    align: cell.align ?? d.align,
    vAlign: cell.vAlign ?? d.vAlign,
    fontFamily: d.fontFamily ?? DEFAULT_FONT_STACK,
    fill,
    fillAlpha: cell.fillAlpha ?? 1,
    padding,
  }
}

/**
 * Synthesize a TextObject snapshot from a cell so the shared text
 * pipeline (buildHtml / buildStyleOpts / applyVerticalAlign / …) can
 * paint it. `x`/`y` are 0 here — the parent clip Container handles
 * cell positioning. `width`/`height` are the cell's *inner* box
 * (bbox minus padding) so wordWrap and vertical alignment respect the
 * pad.
 */
function syntheticCellTextObject(
  cellId: string,
  cell: TableCell,
  style: ResolvedCellStyle,
  innerW: number,
  innerH: number,
): TextObject {
  const text = cell.text instanceof Y.Text ? cell.text : (cell.text ?? '')
  return {
    id: cellId,
    type: 'text',
    x: 0,
    y: 0,
    width: innerW,
    height: innerH,
    rotation: 0,
    opacity: 1,
    text,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    color: style.color,
    align: style.align,
    vAlign: style.vAlign,
    lineHeight: 1.2,
  }
}

function paintGrid(grid: Graphics, table: TableObject, colX: number[], rowY: number[]): void {
  grid.clear()
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
 * Mount a fresh HTMLText subtree for one cell. Returns the CellNode
 * so the caller can store it for cross-update reuse.
 */
function mountCellNode(
  parent: Container,
  cellId: string,
  cell: TableCell,
  table: TableObject,
  bbox: { x: number; y: number; w: number; h: number },
): CellNode | null {
  if (!(cell.text instanceof Y.Text)) return null
  const style = resolveCellStyle(table, cell)
  const innerW = Math.max(1, bbox.w - style.padding.left - style.padding.right)
  const innerH = Math.max(1, bbox.h - style.padding.top - style.padding.bottom)
  const syn = syntheticCellTextObject(cellId, cell, style, innerW, innerH)

  const htmlText = new HTMLText({ text: '', style: new HTMLTextStyle(buildStyleOpts(syn)) })
  // Per-cell uid prefix avoids Pixi's HTMLText global texture cache
  // collision when two cells happen to carry byte-identical content
  // (same comment as in textRenderer.buildHtmlForNode).
  htmlText.text = `<!--n:${htmlText.uid}-->${buildHtml(syn)}`
  wireRedrawOnAsyncTextureUpdate(htmlText)
  scheduleAsyncTextureCatchup(
    htmlText as unknown as { __narrativeCatchupActive?: boolean; destroyed?: boolean },
  )
  applyHorizontalAlign(htmlText, syn)
  applyVerticalAlign(htmlText, syn)
  // Shift into the inner-padding box.
  htmlText.x += style.padding.left
  htmlText.y += style.padding.top

  const clip = new Container()
  clip.x = bbox.x
  clip.y = bbox.y
  const mask = new Graphics()
  mask.rect(0, 0, bbox.w, bbox.h).fill({ color: 0xffffff })
  clip.addChild(mask)
  clip.addChild(htmlText)
  clip.mask = mask
  parent.addChild(clip)

  return { yText: cell.text, clip, mask, htmlText }
}

/**
 * Reposition / restyle an existing cell node when the cell's style or
 * containing bbox changed. Reuses the HTMLText so its async raster
 * lifecycle isn't disrupted — Pixi's HTMLText only re-rasterises when
 * the `text` string actually differs.
 */
function updateCellNode(
  node: CellNode,
  cellId: string,
  cell: TableCell,
  table: TableObject,
  bbox: { x: number; y: number; w: number; h: number },
): void {
  const style = resolveCellStyle(table, cell)
  const innerW = Math.max(1, bbox.w - style.padding.left - style.padding.right)
  const innerH = Math.max(1, bbox.h - style.padding.top - style.padding.bottom)
  const syn = syntheticCellTextObject(cellId, cell, style, innerW, innerH)

  node.htmlText.text = `<!--n:${node.htmlText.uid}-->${buildHtml(syn)}`
  node.htmlText.style = new HTMLTextStyle(buildStyleOpts(syn))
  applyHorizontalAlign(node.htmlText, syn)
  applyVerticalAlign(node.htmlText, syn)
  node.htmlText.x += style.padding.left
  node.htmlText.y += style.padding.top

  node.clip.x = bbox.x
  node.clip.y = bbox.y
  node.mask.clear()
  node.mask.rect(0, 0, bbox.w, bbox.h).fill({ color: 0xffffff })
}

/**
 * Per-cell diff: reuse HTMLText subtrees keyed by the cell's Y.Text
 * identity. Cells that disappear get destroyed; new cells get freshly
 * mounted. Crucially, an unchanged cell keeps its same HTMLText node
 * across the whole rebuild, so the async rasterisation pipeline is
 * never torn down underneath itself.
 *
 * Returns the new map; the caller stores it on the container.
 */
function reconcileCells(
  parent: Container,
  table: TableObject,
  colX: number[],
  rowY: number[],
  prevCells: Map<Y.Text, CellNode>,
  fadedYText: Y.Text | null,
): Map<Y.Text, CellNode> {
  const next = new Map<Y.Text, CellNode>()
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r]!
    for (let c = 0; c < row.length; c++) {
      const bbox = cellBbox(table, r, c, colX, rowY)
      if (bbox === null) continue
      const cell = row[c]!
      const yText = cell.text instanceof Y.Text ? cell.text : null
      if (yText === null) continue
      const cellId = `${table.id}#${r},${c}`
      let cn = prevCells.get(yText)
      if (cn === undefined) {
        const mounted = mountCellNode(parent, cellId, cell, table, bbox)
        if (mounted === null) continue
        cn = mounted
      } else {
        updateCellNode(cn, cellId, cell, table, bbox)
        // Re-attach to ensure z-order is post-grid.
        parent.addChild(cn.clip)
      }
      cn.htmlText.alpha = fadedYText !== null && fadedYText === yText ? 0 : 1
      next.set(yText, cn)
    }
  }
  // Destroy nodes whose Y.Text no longer appears.
  for (const [yText, cn] of prevCells) {
    if (!next.has(yText)) cn.clip.destroy({ children: true, texture: true, textureSource: true })
  }
  return next
}

function rebuild(container: Container, data: TableObject): void {
  const colX = cumulativeCols(data)
  const rowY = cumulativeRows(data)
  const tagged = container as Container & { [k: symbol]: unknown }

  // Grid Graphics — single one, reused across updates.
  let grid = tagged[GRID_TAG] as Graphics | undefined
  if (grid === undefined) {
    grid = new Graphics()
    container.addChild(grid)
    tagged[GRID_TAG] = grid
  } else {
    // Re-attach to keep the grid behind the per-cell text containers.
    container.addChildAt(grid, 0)
  }
  paintGrid(grid, data, colX, rowY)

  // Per-cell HTMLText sub-trees.
  const prevCells =
    (tagged[CELLS_TAG] as Map<Y.Text, CellNode> | undefined) ?? new Map<Y.Text, CellNode>()
  const fadedYText = tagged[FADED_TAG] as Y.Text | null | undefined
  const nextCells = reconcileCells(container, data, colX, rowY, prevCells, fadedYText ?? null)
  tagged[CELLS_TAG] = nextCells

  applyObjectTransform(container, data)
}

/**
 * Public hook — fades the HTMLText backing a specific cell so the
 * inline editor overlay can render in front without double-drawing.
 * Returns true when the cell was found and fading applied (false when
 * the cell isn't currently mounted, e.g. its Y.Text isn't in the map).
 */
export function setTableCellFaded(node: Container, yText: Y.Text | null, faded: boolean): boolean {
  const tagged = node as Container & { [k: symbol]: unknown }
  tagged[FADED_TAG] = faded && yText !== null ? yText : null
  const cells = tagged[CELLS_TAG] as Map<Y.Text, CellNode> | undefined
  if (cells === undefined) return false
  let any = false
  for (const [k, cn] of cells) {
    const alpha = faded && yText !== null && yText === k ? 0 : 1
    if (cn.htmlText.alpha !== alpha) {
      cn.htmlText.alpha = alpha
      any = true
    }
  }
  return any
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
    const cells = tagged[CELLS_TAG] as Map<Y.Text, CellNode> | undefined
    if (cells !== undefined) {
      for (const cn of cells.values()) {
        cn.clip.destroy({ children: true, texture: true, textureSource: true })
      }
    }
    destroyFilterEffects(node)
    node.destroy({ children: true })
  },
}
