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
 *   ├── Graphics  (per-cell fill — one small Graphics per cell, sized
 *   │              + positioned to the cell bbox; Pixi's default
 *   │              `textureSpace: 'local'` maps any gradient / image
 *   │              texture 1:1 to that single sub-path)
 *   │   (one of these per cell, stored in CELL_FILLS_TAG map)
 *   ├── per cell:
 *   │     Container (clip) — positioned at cell bbox, masks overflow
 *   │        ├── Graphics  (mask)
 *   │        └── HTMLText  (anchored by `applyHorizontalAlign` /
 *   │                       `applyVerticalAlign` within the inner pad box)
 *   └── Graphics  (shared border-stroke grid, drawn last so borders
 *                  sit above both fills and text)
 */

import { Container, Graphics, HTMLText } from 'pixi.js'
import * as Y from 'yjs'
import type { ObjectRenderer } from './index.js'
import { getEffectiveBorderSegment, isTokenRef } from '@narrative/shared'
import type {
  TableObject,
  TableCell,
  TableBorderStyle,
  TextObject,
  FontWeight,
  FillStyle,
} from '@narrative/shared'
import {
  buildHtml,
  createHtmlTextStyle,
  applyHorizontalAlign,
  applyVerticalAlign,
  scheduleAsyncTextureCatchup,
  wireRedrawOnAsyncTextureUpdate,
} from './textRenderer.js'
import { applyFilterEffects, destroyFilterEffects } from '../filterEffects.js'
import { resolveColour } from '../colourResolver.js'
import {
  clampStops,
  fillStyleToPixi,
  imageFillToPixiFill,
  releaseAllProceduralFills,
  releaseProceduralFill,
} from '../fillStyleToPixi.js'
import {
  ensureImageFillKeyed,
  getImageFillSlotKeys,
  releaseAllImageFillsKeyed,
  releaseImageFillKeyed,
} from '../imageFillLoader.js'

/** Default font stack — kept in lockstep with TextEditOverlay so cell
 *  text glyphs sit on the same baselines between edit and render. */
/** Face a cell renders in when the table names none. Exported so the cell
 *  editor lays its text out in the same face. */
export const DEFAULT_FONT_STACK = 'system-ui, -apple-system, sans-serif'

const GRID_TAG = Symbol('tableGrid')
const CELLS_TAG = Symbol('tableCellNodes')
const FADED_TAG = Symbol('tableFadedCell')
/** Last-applied data snapshot. applyPatch merges against this to
 *  decide whether the fast (transform-only) path or the full rebuild
 *  is required. */
const DATA_TAG = Symbol('tableData')
/**
 * Per-cell fill Graphics. Each cell paints its background on its own
 * tiny Graphics positioned at the cell's bbox; Pixi v8's `Graphics.fill`
 * uses the path-local AABB for texture mapping, so gradients / image
 * fills work cell-by-cell without matrix gymnastics on a shared
 * Graphics (whose AABB = the union of all cells = one gradient smeared
 * over the whole table).
 *
 * `FillNode.fillKey` caches the structural fingerprint of the painted
 * fill so a rebuild with unchanged fill skips canvas re-paint entirely.
 * `texture` is the cached gradient texture (when applicable) so it can
 * be destroyed when the fillKey changes.
 */
const CELL_FILLS_TAG = Symbol('tableCellFills')
interface FillNode {
  graphics: Graphics
  fillKey: string
  /**
   * Identifies this cell's slot in the container's procedural-fill
   * cache (managed by `fillStyleToPixi` + `releaseProceduralFill`).
   * The actual gradient texture is owned + ref-counted by the
   * ResourceManager — `disposeFillNode` releases the slot but never
   * destroys the texture directly.
   */
  procSlotKey: string
  /**
   * True while a procedural slot is currently held for this cell.
   * Toggled when paint switches between gradient and solid/image so
   * the slot release pairs with the slot acquire.
   */
  hasProcedural: boolean
}

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
  /**
   * PERF-4: fingerprint of every input that `updateCellNode` consumes —
   * the resolved bbox, the resolved cell style, and the rendered HTML
   * string. A single cell Y.Text edit is emitted by state-sync as a
   * whole-`rows` patch, so `reconcileCells` walks EVERY cell. Without a
   * fingerprint each visit ran `new HTMLTextStyle(...)` + `buildHtml`
   * (Y.Text toDelta walk) + `applyVerticalAlign` (which reads
   * `htmlText.height`, forcing a Pixi/DOM measure). An 80-cell table
   * therefore re-measured 80 cells per keystroke. With the fingerprint
   * we skip `updateCellNode` for every cell whose resolved
   * bbox+style+html is byte-identical to the previous render, so only
   * the actually-edited cell pays the restyle + measure cost.
   */
  fingerprint: string
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
  italic: boolean
  underline: boolean
  lineHeight: number
  letterSpacing: number
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
  /** Paragraph spacing in px — table-wide only (no per-cell override).
   *  Now meaningful since plain Enter inside a cell inserts a paragraph. */
  paragraphSpaceBefore: number
  paragraphSpaceAfter: number
  color: number
  align: 'left' | 'center' | 'right'
  vAlign: 'top' | 'middle' | 'bottom'
  fontFamily: string
  fill: number | undefined
  fillAlpha: number
  /** Non-solid fill — linear / radial gradient or image. When present
   *  the renderer paints this instead of the flat `fill`. */
  fillStyle: FillStyle | undefined
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
  // 0 means "fill with black" and must survive. Cells inherit
  // `defaults.fill` when they don't carry their own override, mirroring
  // how `color` falls back above. Without the fallback, picking a
  // table-wide fill in the inspector silently no-ops on cells that
  // were never individually painted.
  const fillSrc = cell.fill ?? d.fill
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
    // Typography flags: cell wins, table default falls in next, then
    // a safe baseline. The cell.X ?? defaults.X chain matches the way
    // the inspector's Typography section resolves "current value"
    // before priming its controls.
    italic: cell.italic ?? d.italic ?? false,
    underline: cell.underline ?? d.underline ?? false,
    lineHeight: cell.lineHeight ?? d.lineHeight ?? 1.2,
    letterSpacing: cell.letterSpacing ?? d.letterSpacing ?? 0,
    textTransform: cell.textTransform ?? d.textTransform ?? 'none',
    paragraphSpaceBefore: d.paragraphSpaceBefore ?? 0,
    paragraphSpaceAfter: d.paragraphSpaceAfter ?? 0,
    color,
    align: cell.align ?? d.align,
    vAlign: cell.vAlign ?? d.vAlign,
    fontFamily: d.fontFamily ?? DEFAULT_FONT_STACK,
    fill,
    // Cells inherit `defaults.fillAlpha` when they don't carry their
    // own override. Mirrors the `fill` + `color` fallback above so the
    // inspector's table-wide "No color" (alpha=0) actually paints
    // every cell transparent.
    fillAlpha: cell.fillAlpha ?? d.fillAlpha ?? 1,
    // Cell wins; falling back to the table-wide gradient / image
    // default. `undefined` means "paint the solid color fallback".
    fillStyle: cell.fillStyle ?? d.fillStyle,
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
    italic: style.italic,
    underline: style.underline,
    color: style.color,
    align: style.align,
    vAlign: style.vAlign,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    textTransform: style.textTransform,
    paragraphSpaceBefore: style.paragraphSpaceBefore,
    paragraphSpaceAfter: style.paragraphSpaceAfter,
  }
}

type EdgeStroke = {
  color: number
  width: number
  dash: 'solid' | 'dash' | 'dot'
}

/**
 * Resolve the effective stroke spec for a single grid-line segment.
 * Reads from the table-wide flat `borderSegments` map first (with
 * fallback through the legacy per-cell `border` field for old decks
 * — see `getEffectiveBorderSegment`), then falls back to
 * `defaults.border`. Returns `null` when no level configures the
 * segment, so the caller can skip the stroke entirely.
 */
function resolveSegmentStroke(
  table: TableObject,
  key: string,
  defaultsBorder: TableBorderStyle | undefined,
): EdgeStroke | null {
  const seg = getEffectiveBorderSegment(table, key)
  if (seg !== undefined) {
    return {
      color: resolveBorderColour(seg, 0xcccccc),
      width: seg.width,
      dash: seg.dash ?? 'solid',
    }
  }
  if (defaultsBorder === undefined) return null
  return {
    color: resolveBorderColour(defaultsBorder, 0xcccccc),
    width: defaultsBorder.width,
    dash: defaultsBorder.dash ?? 'solid',
  }
}

/**
 * Identifies the merged-region "anchor" for a cell at (r, c):
 *   - A merge-continuation pointer returns its origin coords.
 *   - A merge origin (gridSpan or rowSpan > 1) returns its own coords.
 *   - Otherwise null — the cell isn't part of any merge.
 *
 * Two segments are "interior to the same merge" when both adjacent
 * cells share a non-null anchor; the renderer skips those segments
 * so the merge looks like one continuous region instead of having
 * the row/column dividers run through it.
 */
function mergeAnchor(table: TableObject, r: number, c: number): { r: number; c: number } | null {
  const cell = table.rows[r]?.[c]
  if (cell === undefined) return null
  if (typeof cell.mergeOriginR === 'number' && typeof cell.mergeOriginC === 'number') {
    return { r: cell.mergeOriginR, c: cell.mergeOriginC }
  }
  const colSpan = cell.gridSpan ?? 1
  const rowSpan = cell.rowSpan ?? 1
  if (colSpan > 1 || rowSpan > 1) return { r, c }
  return null
}

/**
 * Per-cell key (used for image-fill slot tracking + the cell-fill
 * Graphics map). Row / column inserts and deletes rebuild the whole
 * grid via `paintCellFills`, which sweeps stale keys at the end of
 * the pass — no need for stable per-cell ids.
 */
function cellSlotKey(r: number, c: number): string {
  return `cell:${r},${c}`
}

/**
 * Structural fingerprint of a cell's fill — bumped only when a real
 * visual change occurs (color, alpha, gradient stops / angle / focal
 * point, image asset, dimensions). Used by the per-cell fill cache to
 * skip canvas repaint + Graphics re-trace when nothing changed.
 */
function cellFillKey(style: ResolvedCellStyle, w: number, h: number): string {
  const fs = style.fillStyle
  const dims = `${Math.round(w)}x${Math.round(h)}`
  const solid = style.fill === undefined ? '_' : `${style.fill}@${style.fillAlpha.toFixed(3)}`
  if (fs === undefined) return `s:${dims}:${solid}`
  if (fs.kind === 'linearGradient') {
    const stops = clampStops(fs.stops)
      .map((s) => `${s.offset.toFixed(3)}@${s.color.toString(16)}x${s.alpha.toFixed(3)}`)
      .join(',')
    return `l:${dims}:${fs.angleDeg.toFixed(2)}:${stops}:a${style.fillAlpha.toFixed(3)}`
  }
  if (fs.kind === 'radialGradient') {
    const stops = clampStops(fs.stops)
      .map((s) => `${s.offset.toFixed(3)}@${s.color.toString(16)}x${s.alpha.toFixed(3)}`)
      .join(',')
    return `r:${dims}:${(fs.centerX ?? 0.5).toFixed(3)},${(fs.centerY ?? 0.5).toFixed(3)}:${stops}:a${style.fillAlpha.toFixed(3)}`
  }
  // image
  return `i:${dims}:${fs.assetId}:${fs.fit ?? 'cover'}:a${style.fillAlpha.toFixed(3)}`
}

function getCellFillsMap(container: Container): Map<string, FillNode> {
  const tagged = container as Container & { [k: symbol]: unknown }
  let map = tagged[CELL_FILLS_TAG] as Map<string, FillNode> | undefined
  if (map === undefined) {
    map = new Map()
    tagged[CELL_FILLS_TAG] = map
  }
  return map
}

function disposeFillNode(container: Container, node: FillNode): void {
  node.graphics.parent?.removeChild(node.graphics)
  // Release the procedural cache slot (ref-counted by ResourceManager;
  // we don't destroy the texture ourselves — another cell or shape
  // sharing the same gradient key may still be using it).
  if (node.hasProcedural) releaseProceduralFill(container, node.procSlotKey)
  node.graphics.destroy({ children: false, texture: false })
}

/**
 * Paint or reuse the per-cell fill Graphics. Each cell is its own tiny
 * Graphics sized to the cell bbox; Pixi v8's default `textureSpace:
 * 'local'` then maps any gradient / image texture 1:1 to that single
 * sub-path. No cross-cell smearing.
 *
 * Cache key encodes every visual input — `cellFillKey` returns the
 * same string when nothing changed, so we early-out before re-tracing
 * the rect or re-painting the gradient canvas. That's the main win on
 * laggy rebuilds: a 50-cell table with one gradient default + frequent
 * unrelated edits used to repaint 50 canvases per rebuild; now it
 * repaints zero.
 */
function paintCellFill(
  container: Container,
  r: number,
  c: number,
  style: ResolvedCellStyle,
  bbox: { x: number; y: number; w: number; h: number },
  onReady: () => void,
): void {
  const map = getCellFillsMap(container)
  const key = cellSlotKey(r, c)
  const fillKey = cellFillKey(style, bbox.w, bbox.h)
  let node = map.get(key)

  // Fast path — fillKey unchanged: only re-position (cheap) and bail.
  // Skips Graphics re-trace + Graphics.fill + texture upload, which is
  // what kept the inspector responsive during animation frames that
  // don't actually change visuals.
  if (node !== undefined && node.fillKey === fillKey) {
    node.graphics.x = bbox.x
    node.graphics.y = bbox.y
    return
  }

  // Slow path — fill changed. Replace the Graphics's contents.
  if (node === undefined) {
    node = {
      graphics: new Graphics(),
      fillKey: '',
      procSlotKey: key,
      hasProcedural: false,
    }
    container.addChildAt(node.graphics, 0)
    map.set(key, node)
  }
  node.graphics.clear()
  node.graphics.x = bbox.x
  node.graphics.y = bbox.y
  node.graphics.rect(0, 0, bbox.w, bbox.h)

  const fs = style.fillStyle
  if (fs?.kind === 'linearGradient' || fs?.kind === 'radialGradient') {
    releaseImageFillKeyed(container, key)
    // Route through the shared procedural cache — `fillStyleToPixi`
    // builds the gradient key, acquires (or hits) a ref-counted
    // texture, and tracks the held key on the container under
    // `procSlotKey` so N cells sharing the same gradient + bbox
    // dimensions share one Texture. Drag-painting the stops only
    // repaints the canvas once per unique key per tick.
    const resolved = fillStyleToPixi(fs, 0, bbox.w, bbox.h, container, node.procSlotKey)
    node.hasProcedural = true
    node.graphics.fill({ ...resolved.input, alpha: style.fillAlpha })
  } else if (fs?.kind === 'image') {
    // Image-fill doesn't use the procedural slot; release if we held one.
    if (node.hasProcedural) {
      releaseProceduralFill(container, node.procSlotKey)
      node.hasProcedural = false
    }
    const texture = ensureImageFillKeyed(container, key, fs, onReady)
    if (texture !== null) {
      node.graphics.fill({
        ...imageFillToPixiFill(fs, texture, bbox.w, bbox.h),
        alpha: style.fillAlpha,
      })
    } else if (style.fill !== undefined && style.fillAlpha > 0) {
      node.graphics.fill({ color: style.fill, alpha: style.fillAlpha })
    }
  } else {
    releaseImageFillKeyed(container, key)
    if (node.hasProcedural) {
      releaseProceduralFill(container, node.procSlotKey)
      node.hasProcedural = false
    }
    if (style.fill !== undefined && style.fillAlpha > 0) {
      node.graphics.fill({ color: style.fill, alpha: style.fillAlpha })
    }
  }

  node.fillKey = fillKey
}

/**
 * Pass 1 — per-cell fill Graphics (gradient / image / solid). Each
 * cell paints onto its own tiny Graphics positioned at (bbox.x,
 * bbox.y); the cache in `paintCellFill` early-outs when the cell's
 * fill key is unchanged. Sweeps abandoned per-cell fill nodes and
 * image-fill slots at the end so a deleted row / column doesn't
 * leak.
 */
function paintCellFills(
  container: Container,
  table: TableObject,
  colX: number[],
  rowY: number[],
  onAsyncImageReady: () => void,
): void {
  const liveKeys = new Set<string>()
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r]!
    for (let c = 0; c < row.length; c++) {
      const bbox = cellBbox(table, r, c, colX, rowY)
      if (bbox === null) continue
      liveKeys.add(cellSlotKey(r, c))
      const style = resolveCellStyle(table, row[c]!)
      paintCellFill(container, r, c, style, bbox, onAsyncImageReady)
    }
  }
  const fillsMap = getCellFillsMap(container)
  for (const [key, node] of fillsMap) {
    if (liveKeys.has(key)) continue
    disposeFillNode(container, node)
    fillsMap.delete(key)
  }
  for (const key of getImageFillSlotKeys(container)) {
    if (!liveKeys.has(key)) releaseImageFillKeyed(container, key)
  }
}

/**
 * Pass 2 — borders. Each grid line in the table is a single segment
 * with a single stroke spec, so we paint exactly once per line. The
 * row of horizontal lines runs `0..R` (inclusive), `0` being the
 * outer top edge, `R` the outer bottom; vertical lines run `0..C`.
 * Segments interior to a merged region are skipped so the merge
 * looks like one continuous area.
 */
function paintBorders(grid: Graphics, table: TableObject, colX: number[], rowY: number[]): void {
  grid.clear()
  const R = table.rows.length
  const C = table.colWidths.length
  const dflt = table.defaults.border
  // Horizontal: `row` is the row INDEX whose top edge this is, so
  // `row === R` is the table's outer bottom.
  for (let row = 0; row <= R; row++) {
    const y = rowY[row]
    if (y === undefined) continue
    // Outer rim alignment trick — shift outer-rim strokes INSIDE
    // the table by half their width so the stroke's full thickness
    // sits below (or above) the rim line instead of straddling it.
    // Matches how Keynote / Excel paint table outer borders: nothing
    // bulges past the visible table bounds, so a thick cell border
    // adjacent to a thin neighbour doesn't overhang the rim.
    for (let col = 0; col < C; col++) {
      // Skip interior of a merge — only relevant when both sides exist.
      if (row > 0 && row < R) {
        const up = mergeAnchor(table, row - 1, col)
        const lo = mergeAnchor(table, row, col)
        if (up !== null && lo !== null && up.r === lo.r && up.c === lo.c) continue
      }
      const stroke = resolveSegmentStroke(table, `h:${row}:${col}`, dflt)
      if (stroke === null) continue
      const x1 = colX[col]
      const x2 = colX[col + 1]
      if (x1 === undefined || x2 === undefined) continue
      const drawY = row === 0 ? y + stroke.width / 2 : row === R ? y - stroke.width / 2 : y
      strokeEdge(grid, stroke, x1, drawY, x2, drawY)
    }
  }
  // Vertical: `col === C` is the table's outer right.
  for (let row = 0; row < R; row++) {
    const y1 = rowY[row]
    const y2 = rowY[row + 1]
    if (y1 === undefined || y2 === undefined) continue
    for (let col = 0; col <= C; col++) {
      if (col > 0 && col < C) {
        const lf = mergeAnchor(table, row, col - 1)
        const rt = mergeAnchor(table, row, col)
        if (lf !== null && rt !== null && lf.r === rt.r && lf.c === rt.c) continue
      }
      const stroke = resolveSegmentStroke(table, `v:${row}:${col}`, dflt)
      if (stroke === null) continue
      const x = colX[col]
      if (x === undefined) continue
      // Same outer-rim shift as horizontals — outer left/right
      // columns get aligned INSIDE the table.
      const drawX = col === 0 ? x + stroke.width / 2 : col === C ? x - stroke.width / 2 : x
      strokeEdge(grid, stroke, drawX, y1, drawX, y2)
    }
  }
  paintCornerPatches(grid, table, colX, rowY, R, C, dflt)
}

/**
 * Pass 3 — corner patches. At every grid intersection, paint a small
 * filled square sized to the THICKEST adjacent stroke's width, colored
 * with that stroke's colour. Fills the tiny notches that butt-cap
 * strokes leave behind when same-style segments meet, and ensures the
 * corner colour is consistent (the thicker stroke "wins") when mixed
 * styles meet — matches Excel / Keynote's corner-priority behaviour.
 *
 * Outer-rim corners get the same alignment-inside shift as their
 * strokes so the patch doesn't bulge past the visible table bounds.
 * Interior corners are centered on the grid line.
 */
function paintCornerPatches(
  grid: Graphics,
  table: TableObject,
  colX: number[],
  rowY: number[],
  R: number,
  C: number,
  dflt: TableBorderStyle | undefined,
): void {
  for (let row = 0; row <= R; row++) {
    const cy = rowY[row]
    if (cy === undefined) continue
    for (let col = 0; col <= C; col++) {
      const cx = colX[col]
      if (cx === undefined) continue
      // Interior of a merged region — no border lines cross here.
      if (row > 0 && row < R && col > 0 && col < C) {
        const nw = mergeAnchor(table, row - 1, col - 1)
        const ne = mergeAnchor(table, row - 1, col)
        const sw = mergeAnchor(table, row, col - 1)
        const se = mergeAnchor(table, row, col)
        if (
          nw !== null &&
          ne !== null &&
          sw !== null &&
          se !== null &&
          nw.r === ne.r &&
          nw.c === ne.c &&
          nw.r === sw.r &&
          nw.c === sw.c &&
          nw.r === se.r &&
          nw.c === se.c
        ) {
          continue
        }
      }
      // Collect adjacent strokes (up to 4: h-left, h-right, v-up, v-down).
      let thickest: EdgeStroke | null = null
      const consider = (s: EdgeStroke | null): void => {
        if (s === null || s.width <= 0) return
        if (thickest === null || s.width > thickest.width) thickest = s
      }
      if (col > 0) consider(resolveSegmentStroke(table, `h:${row}:${col - 1}`, dflt))
      if (col < C) consider(resolveSegmentStroke(table, `h:${row}:${col}`, dflt))
      if (row > 0) consider(resolveSegmentStroke(table, `v:${row - 1}:${col}`, dflt))
      if (row < R) consider(resolveSegmentStroke(table, `v:${row}:${col}`, dflt))
      if (thickest === null) continue
      // Some TS narrowing dance — TS thinks thickest could still be null
      // inside the closures. Pull the value into a local.
      const s: EdgeStroke = thickest
      // Patch geometry — centered on (cx, cy), aligned inside the
      // table on outer rim corners. Square of side = thickest's width.
      const w = s.width
      let x0 = cx - w / 2
      let y0 = cy - w / 2
      if (col === 0) x0 = cx
      else if (col === C) x0 = cx - w
      if (row === 0) y0 = cy
      else if (row === R) y0 = cy - w
      grid.rect(x0, y0, w, w)
      grid.fill({ color: s.color, alpha: 1 })
    }
  }
}

/**
 * Dash pattern (on, off) in MULTIPLES of the stroke width, so the
 * pattern keeps its visual proportions as the user scales border
 * thickness. Matches the spacing the regular line-renderer uses.
 */
function dashPattern(style: 'dash' | 'dot'): [number, number] {
  if (style === 'dot') return [1, 2]
  return [4, 2.5]
}

function strokeEdge(
  grid: Graphics,
  border: EdgeStroke,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  if (border.width <= 0) return
  if (border.dash === 'solid') {
    grid.moveTo(x1, y1)
    grid.lineTo(x2, y2)
    // `cap: 'butt'` ends the stroke perpendicular to its direction
    // at the exact endpoint — no half-width overshoot past the
    // corner. The square cap we used before kept inner corners
    // crisp (the half-width overshoot from two perpendicular
    // segments overlapped to fill the outer corner), but on the
    // table's OUTER rim it bulged the stroke past the table's
    // visual bounds — visible as a thick segment extending beyond
    // a thinner adjacent segment. Butt trades a tiny missing-pixel
    // notch at same-style outer corners for a clean rim everywhere
    // (the notch is half-width × half-width, so invisible for thin
    // borders and an acceptable trade for thick ones).
    grid.stroke({ color: border.color, width: border.width, alpha: 1, cap: 'butt' })
    return
  }
  // Dashed / dotted: emit a series of short solid segments. Pixi v8's
  // Graphics has no native dash, so the cheapest approach is one
  // moveTo+lineTo+stroke per dash. Tables aren't dense enough for the
  // per-segment overhead to matter visually. `cap: 'butt'` here so
  // dashes stay distinct — `square` would extend each dash by half
  // its width and run them into each other.
  const [onMul, offMul] = dashPattern(border.dash)
  const onLen = Math.max(border.width * onMul, 0.5)
  const offLen = Math.max(border.width * offMul, 0.5)
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy)
  if (len === 0) return
  const ux = dx / len
  const uy = dy / len
  let consumed = 0
  let drawing = true
  while (consumed < len) {
    const segLen = Math.min(drawing ? onLen : offLen, len - consumed)
    if (drawing) {
      const sx = x1 + ux * consumed
      const sy = y1 + uy * consumed
      const ex = x1 + ux * (consumed + segLen)
      const ey = y1 + uy * (consumed + segLen)
      grid.moveTo(sx, sy)
      grid.lineTo(ex, ey)
      grid.stroke({ color: border.color, width: border.width, alpha: 1, cap: 'butt' })
    }
    consumed += segLen
    drawing = !drawing
  }
}

/**
 * PERF-4: fingerprint of every input `updateCellNode` consumes. A whole-
 * `rows` patch (state-sync emits one for a single cell Y.Text edit)
 * walks every cell; this string lets `reconcileCells` skip the restyle
 * + measure for cells whose visual inputs are unchanged.
 *
 * Inputs:
 *   - bbox geometry (drives clip position, mask, wordWrap width, vAlign)
 *   - the resolved style fields that feed `buildStyleOpts` /
 *     `applyHorizontalAlign` / `applyVerticalAlign`
 *   - the rendered HTML (captures Y.Text content + per-run formatting,
 *     which never surface as a `cell` field diff because they mutate
 *     inside the same Y.Text instance)
 *
 * The HTML is the load-bearing part for the typing path: an edit to one
 * cell's Y.Text changes only that cell's `html`, so only that cell's
 * fingerprint moves and only it gets re-styled.
 */
function cellRenderFingerprint(
  bbox: { x: number; y: number; w: number; h: number },
  style: ResolvedCellStyle,
  html: string,
): string {
  const geom = `${bbox.x.toFixed(2)},${bbox.y.toFixed(2)},${bbox.w.toFixed(2)},${bbox.h.toFixed(2)}`
  const pad = `${style.padding.top},${style.padding.right},${style.padding.bottom},${style.padding.left}`
  const sty = [
    style.fontSize,
    style.fontWeight,
    style.italic ? 1 : 0,
    style.underline ? 1 : 0,
    style.lineHeight,
    style.letterSpacing,
    style.textTransform,
    style.paragraphSpaceBefore,
    style.paragraphSpaceAfter,
    style.color,
    style.align,
    style.vAlign,
    style.fontFamily,
  ].join('|')
  return `${geom}|${pad}|${sty}|${html}`
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

  const html = buildHtml(syn)
  const htmlText = new HTMLText({ text: '', style: createHtmlTextStyle(syn) })
  // Per-cell uid prefix avoids Pixi's HTMLText global texture cache
  // collision when two cells happen to carry byte-identical content
  // (same comment as in textRenderer.buildHtmlForNode).
  htmlText.text = `<!--n:${htmlText.uid}-->${html}`
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

  return {
    yText: cell.text,
    clip,
    mask,
    htmlText,
    fingerprint: cellRenderFingerprint(bbox, style, html),
  }
}

/**
 * Reposition / restyle an existing cell node when the cell's style or
 * containing bbox changed. Reuses the HTMLText so its async raster
 * lifecycle isn't disrupted — Pixi's HTMLText only re-rasterises when
 * the `text` string actually differs.
 *
 * PERF-4: returns early when the cell's resolved bbox + style + html is
 * byte-identical to the last render (`node.fingerprint`). This is the
 * hot-path win on the typing flow — a one-cell edit arrives as a whole-
 * `rows` patch, so every cell is visited, but only the edited cell's
 * fingerprint actually moves. The `new HTMLTextStyle(...)` +
 * `applyVerticalAlign` (which reads `htmlText.height`, forcing a
 * Pixi/DOM measure) now run for that single cell instead of all N.
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

  const html = buildHtml(syn)
  const fingerprint = cellRenderFingerprint(bbox, style, html)
  if (fingerprint === node.fingerprint) return

  node.htmlText.text = `<!--n:${node.htmlText.uid}-->${html}`
  node.htmlText.style = createHtmlTextStyle(syn)
  applyHorizontalAlign(node.htmlText, syn)
  applyVerticalAlign(node.htmlText, syn)
  node.htmlText.x += style.padding.left
  node.htmlText.y += style.padding.top

  node.clip.x = bbox.x
  node.clip.y = bbox.y
  node.mask.clear()
  node.mask.rect(0, 0, bbox.w, bbox.h).fill({ color: 0xffffff })

  node.fingerprint = fingerprint
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
  // Destroy nodes whose Y.Text no longer appears. We MUST NOT destroy
  // the HTMLText synchronously here: Pixi's `addRenderable` returns a
  // Promise.catch chain that can fire on a later render frame. If we
  // destroy the node before that catch runs, `updateTextBounds` reads
  // `htmlText._view` (now null) and crashes with the classic
  // `_getFinalPadding` of null trace.
  //
  // The two-step dance: detach from parent immediately (so Pixi's
  // next collectRenderables pass doesn't see it and re-queue work),
  // then queue the actual destroy for after the current render tick
  // has settled — `requestIdleCallback`-or-rAF-pair is enough
  // because Pixi's SVG→texture promise resolves within at most one
  // microtask + one rAF after the imageBitmap loads.
  for (const [yText, cn] of prevCells) {
    if (next.has(yText)) continue
    if (cn.clip.parent !== null) cn.clip.parent.removeChild(cn.clip)
    queueDeferredDestroy(cn.clip)
  }
  return next
}

/**
 * Tear an orphaned cell subtree down off the render path. We wait a
 * few rAFs so Pixi's HTMLTextPipe has finished its async SVG raster +
 * texture upload + Promise.catch chain BEFORE we null the node's view
 * (destroy sets `_view = null` and any in-flight `updateTextBounds`
 * would NPE otherwise). A `setTimeout` would do, but rAFs keep the
 * delay tied to actual paint cycles instead of wall-clock — quicker
 * on idle, longer when the tab is throttled.
 */
function queueDeferredDestroy(clip: Container): void {
  const tick = (n: number): void => {
    if (n <= 0) {
      try {
        clip.destroy({ children: true, texture: true, textureSource: true })
      } catch {
        // Pixi internals may throw if we lost a race with a peer
        // destroying the same subtree — already gone, no-op.
      }
      return
    }
    requestAnimationFrame(() => tick(n - 1))
  }
  // Three frames covers the worst-case Pixi.HTMLText catchup window
  // (see `scheduleAsyncTextureCatchup` in textRenderer for the same
  // empirical bound).
  requestAnimationFrame(() => tick(2))
}

function rebuild(container: Container, data: TableObject): void {
  const colX = cumulativeCols(data)
  const rowY = cumulativeRows(data)
  const tagged = container as Container & { [k: symbol]: unknown }

  // Grid Graphics — single one, reused across updates. Now holds ONLY
  // borders (per-cell fills live on their own Graphics children).
  let grid = tagged[GRID_TAG] as Graphics | undefined
  if (grid === undefined) {
    grid = new Graphics()
    container.addChild(grid)
    tagged[GRID_TAG] = grid
  }
  // Async image-fill loads invoke this callback when the texture
  // lands — re-enter `rebuild` so the cell repaints with the resolved
  // texture instead of the solid fallback. Reads from DATA_TAG so the
  // closure tracks the freshest state when multiple edits queue up
  // before the load completes.
  const onAsyncImageReady = (): void => {
    const latest = (tagged[DATA_TAG] as TableObject | undefined) ?? data
    rebuild(container, latest)
  }
  paintCellFills(container, data, colX, rowY, onAsyncImageReady)
  paintBorders(grid, data, colX, rowY)

  // Per-cell HTMLText sub-trees.
  const prevCells =
    (tagged[CELLS_TAG] as Map<Y.Text, CellNode> | undefined) ?? new Map<Y.Text, CellNode>()
  const fadedYText = tagged[FADED_TAG] as Y.Text | null | undefined
  const nextCells = reconcileCells(container, data, colX, rowY, prevCells, fadedYText ?? null)
  tagged[CELLS_TAG] = nextCells

  // Z-order: cell-fill Graphics (added at index 0 by paintCellFills),
  // HTMLText cell containers (appended by reconcileCells), borders
  // Graphics on top. Re-attach grid last so it stays above any
  // HTMLText nodes that were just appended.
  container.addChild(grid)

  applyObjectTransform(container, data)
  tagged[DATA_TAG] = data
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

/**
 * Fields whose change forces a full per-cell rebuild. Anything outside
 * this set hits the fast path in `applyPatch` (transform / filter
 * effects only — touches the outer Container without iterating cells).
 *
 * Dragging a table updates `x` / `y` 60 times a second; at N×M cells
 * the rebuild path's per-cell `htmlText.style = new HTMLTextStyle(...)`
 * + `applyHorizontalAlign` + `applyVerticalAlign` is what was making
 * the drag visibly stutter. Filtering to the cheap path keeps the
 * cells untouched and the drag responsive.
 */
const STRUCTURAL_KEYS: ReadonlyArray<keyof TableObject> = [
  'width',
  'height',
  'rows',
  'colWidths',
  'rowHeights',
  'defaults',
]

/**
 * Fill-related defaults keys — when ONLY these differ between two
 * `defaults` snapshots, the cells' HTMLText renderers and the borders
 * don't need a pass: only `paintCellFills` does. Used by the mid-path
 * in `applyPatch` to skip the per-cell HTMLTextStyle reassignment +
 * border re-stroke during table-wide gradient stop drags.
 *
 * Stop-dragging a gradient fires one Yjs `defaults` update per
 * animation frame. Each update fully re-rasterises every cell's
 * SVG-backed HTMLText if we hit the rebuild path, which is what made
 * the inspector slider feel sticky on a multi-cell table even after
 * the procedural cache made the fill paint itself cheap.
 */
const DEFAULTS_FILL_KEYS = new Set(['fill', 'fillAlpha', 'fillStyle'])

function isFillOnlyDefaultsChange(
  prev: TableObject['defaults'],
  next: TableObject['defaults'],
): boolean {
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<string>
  const prevR = prev as unknown as Record<string, unknown>
  const nextR = next as unknown as Record<string, unknown>
  for (const k of allKeys) {
    if (DEFAULTS_FILL_KEYS.has(k)) continue
    const a = prevR[k]
    const b = nextR[k]
    if (a === b) continue
    // Nested objects (border, padding, textStyleOverrides) get a
    // shallow JSON compare — cheap because they're small, sufficient
    // because Yjs always emits fresh references but the JSON shape is
    // stable when nothing changed.
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      if (JSON.stringify(a) === JSON.stringify(b)) continue
    }
    return false
  }
  return true
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
  applyPatch(node, patch) {
    const tagged = node as Container & { [k: symbol]: unknown }
    const prev = tagged[DATA_TAG] as TableObject | undefined
    if (prev === undefined) return // shouldn't happen — mount stores DATA_TAG
    const structural = STRUCTURAL_KEYS.some((k) => k in patch)
    const borderSegmentsChanged = 'borderSegments' in patch
    if (!structural) {
      // Fast path — transform / opacity / filter only. Move the outer
      // container; cells stay put in container-local coords.
      if (patch.x !== undefined) node.x = patch.x + node.pivot.x
      if (patch.y !== undefined) node.y = patch.y + node.pivot.y
      if (patch.rotation !== undefined) node.rotation = patch.rotation
      if (patch.opacity !== undefined) node.alpha = patch.opacity
      if ('shadow' in patch || 'blur' in patch) {
        applyFilterEffects(node, patch.shadow ?? prev.shadow, patch.blur ?? prev.blur)
      }
      // Border edit: `borderSegments` isn't structural (cell text + cell
      // fill aren't affected), but the grid Graphics needs to repaint
      // to reflect the new segment values. Skip the HTMLText reconcile
      // and the per-cell fill repaint — only `paintBorders` matters.
      if (borderSegmentsChanged) {
        const grid = tagged[GRID_TAG] as Graphics | undefined
        if (grid !== undefined) {
          const merged = { ...prev, ...patch } as TableObject
          const colX = cumulativeCols(merged)
          const rowY = cumulativeRows(merged)
          paintBorders(grid, merged, colX, rowY)
        }
      }
      tagged[DATA_TAG] = { ...prev, ...patch } as TableObject
      return
    }
    // Structural change. Two paths:
    //   - Defaults changed but only fill-related fields → repaint the
    //     per-cell fill Graphics (cheap, hits the procedural cache)
    //     and skip the HTMLText reconcile (which would re-rasterise
    //     every cell's SVG synchronously per pointer tick).
    //   - Anything else → full rebuild (width/height/rows/colWidths/
    //     rowHeights or a non-fill defaults edit).
    const merged = { ...prev, ...patch } as TableObject
    const onlyDefaults =
      'defaults' in patch &&
      !('width' in patch) &&
      !('height' in patch) &&
      !('rows' in patch) &&
      !('colWidths' in patch) &&
      !('rowHeights' in patch)
    if (onlyDefaults && isFillOnlyDefaultsChange(prev.defaults, merged.defaults)) {
      // Only fill-related defaults changed — repaint per-cell fills
      // (the procedural cache short-circuits the texture cost). Skip
      // both `paintBorders` and `reconcileCells`: nothing about the
      // borders or the cells' text rendering changed. The grid's
      // z-order doesn't need re-attaching — new cell-fill Graphics
      // insert at index 0 via `addChildAt`, leaving the grid where
      // it was (on top).
      const colX = cumulativeCols(merged)
      const rowY = cumulativeRows(merged)
      const onAsyncImageReady = (): void => {
        const latest = (tagged[DATA_TAG] as TableObject | undefined) ?? merged
        rebuild(node, latest)
      }
      paintCellFills(node, merged, colX, rowY, onAsyncImageReady)
      tagged[DATA_TAG] = merged
      applyFilterEffects(node, merged.shadow, merged.blur)
      return
    }
    rebuild(node, merged)
    applyFilterEffects(node, merged.shadow, merged.blur)
  },
  /**
   * Cell text colours, cell fills and borders resolve token colours. A
   * rebuild from the same data repaints exactly the ones whose resolution
   * changed: each cell's fill is keyed by its resolved fill (`cellFillKey`),
   * each cell's text by its resolved style (`cellRenderFingerprint`), so an
   * untouched cell keeps its raster; the borders are one cheap re-stroke.
   */
  repaintColours(node, data) {
    rebuild(node, data)
  },
  destroy(node) {
    const tagged = node as Container & { [k: symbol]: unknown }
    const grid = tagged[GRID_TAG] as Graphics | undefined
    if (grid !== undefined) grid.destroy({ children: false, texture: false })
    // Dispose per-cell fill Graphics + drop procedural cache refs.
    const fills = tagged[CELL_FILLS_TAG] as Map<string, FillNode> | undefined
    if (fills !== undefined) {
      for (const fn of fills.values()) disposeFillNode(node, fn)
      fills.clear()
    }
    const cells = tagged[CELLS_TAG] as Map<Y.Text, CellNode> | undefined
    if (cells !== undefined) {
      // Same deferred-destroy reasoning as `reconcileCells`: detach
      // each cell now so Pixi's next render frame doesn't try to draw
      // it, then queue the real destroy a few frames later so any
      // in-flight HTMLText async work resolves before we null _view.
      for (const cn of cells.values()) {
        if (cn.clip.parent !== null) cn.clip.parent.removeChild(cn.clip)
        queueDeferredDestroy(cn.clip)
      }
    }
    // Drop every image-fill ref + procedural-fill ref this table
    // acquired across all cells. Mirrors how the shape renderers call
    // `releaseImageFill` + `releaseProceduralFill` on destroy — without
    // this the texture cache leaks one ref per filled cell every time
    // a table is removed from the slide. (Per-FillNode releases above
    // already covered each slot, but `releaseAllProceduralFills` is
    // belt-and-braces in case a code path adds a slot without a
    // matching FillNode entry.)
    releaseAllImageFillsKeyed(node)
    releaseAllProceduralFills(node)
    destroyFilterEffects(node)
    node.destroy({ children: false })
  },
}
