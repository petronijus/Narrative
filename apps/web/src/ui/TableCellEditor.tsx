/**
 * ui/TableCellEditor.tsx
 *
 * M29 Phase 3 — inline cell editor for the first-class TableObject.
 *
 * This is a thin wrapper around `TextEditOverlay` — the SAME editor
 * used by `TextObject` — so cells inherit every typography feature
 * we've already polished (custom fonts, B/I/U/color via Inspector,
 * inline-format Cmd+B/I/U, Y.Text two-way binding, peer-edit observer,
 * selection-publish for the inspector format toolbar, etc.).
 *
 * The trick: synthesize a `TextObject`-shaped value from the cell —
 * `obj.text` IS the cell's Y.Text reference, so all of TextEditOverlay's
 * diff/format pipeline operates directly on the same CRDT body the
 * renderer reads. `obj.id` follows the convention `${tableId}#${r},${c}`
 * which `SceneGraph.setTextNodeFaded` knows how to walk back to the
 * table's per-cell HTMLText.
 *
 * Cell-only keyboard nav (Tab / Shift+Tab → horizontal cell move,
 * Cmd/Ctrl+Enter → next row) is intercepted on `onKeyDownCapture` of
 * the wrapper div *before* the contenteditable inside TextEditOverlay
 * sees the key. Plain Enter (and Shift+Enter) fall through so the
 * user can compose multi-paragraph text inside a cell — same as a
 * regular text box. Moving past the last row appends one through
 * `table.row.insert` (the editor writes through commands, ADR 0010); the
 * typing itself is TextEditOverlay's binding (A2.11).
 *
 * Each cell gets its own TextEditOverlay (keyed by the cell): the overlay
 * builds its DOM and takes focus when it mounts, so reusing one instance
 * across cells showed the previous cell's text over the new cell's body —
 * and the first keystroke's diff then wrote that text into the new cell.
 */

import { useMemo } from 'react'
import * as Y from 'yjs'
import { yMapToPlainObject, type ObjectsMutationContext } from '@narrative/slide-model'
import { isTokenRef, type TableObject, type TextObject } from '@narrative/shared'
import type { TokenRef } from '@narrative/shared'
import { useTableEdit } from '../state/TableEditContext.js'
import { TextEditOverlay } from './TextEditOverlay.js'
import { DEFAULT_FONT_STACK } from '../renderer/objectRenderers/tableRenderer.js'
import { useCommand } from '../state/useCommand.js'

export interface TableCellEditorProps {
  table: TableObject
  /** The slide the table is on (commands address it). */
  slideId: string
  mutationCtx: ObjectsMutationContext
}

/**
 * The table as the document holds it right now. The slide snapshot the
 * editor renders from arrives a frame after a change (rAF-batched), so a
 * row this editor has just appended is in the document but not yet in the
 * `table` prop.
 */
function liveTable(ctx: ObjectsMutationContext, tableId: string): TableObject | null {
  const map = ctx.objects.toArray().find((m) => m.get('id') === tableId)
  return map === undefined ? null : yMapToPlainObject<TableObject>(map)
}

function hexResolve(n: number | TokenRef | undefined, fallback: number): number {
  if (n === undefined) return fallback
  if (typeof n === 'object' && isTokenRef(n)) return fallback
  return n as number
}

/**
 * Resolve the merge-origin coords for a cell. The continuation cells
 * carry pointers back to where the visible text lives; we always edit
 * the origin so a click anywhere in a merged area opens the right
 * editor.
 */
function resolveOrigin(table: TableObject, r: number, c: number): { r: number; c: number } {
  const cell = table.rows[r]?.[c]
  if (
    cell !== undefined &&
    typeof cell.mergeOriginR === 'number' &&
    typeof cell.mergeOriginC === 'number'
  ) {
    return { r: cell.mergeOriginR, c: cell.mergeOriginC }
  }
  return { r, c }
}

/**
 * Cell bbox in TABLE-LOCAL coords (top-left at the cell's origin in the
 * un-rotated table frame). Honours gridSpan/rowSpan so merged origins
 * cover the full merge area.
 */
function cellLocalBbox(
  table: TableObject,
  r: number,
  c: number,
): { x: number; y: number; w: number; h: number } | null {
  const cell = table.rows[r]?.[c]
  if (cell === undefined) return null
  const colSum = table.colWidths.reduce((a, b) => a + b, 0) || 1
  const rowSum = table.rowHeights.reduce((a, b) => a + b, 0) || 1
  const sx = table.width / colSum
  const sy = table.height / rowSum
  let lx = 0
  for (let i = 0; i < c; i++) lx += (table.colWidths[i] ?? 0) * sx
  let ty = 0
  for (let i = 0; i < r; i++) ty += (table.rowHeights[i] ?? 0) * sy
  const colSpan = Math.max(1, cell.gridSpan ?? 1)
  const rowSpan = Math.max(1, cell.rowSpan ?? 1)
  let w = 0
  for (let i = c; i < c + colSpan && i < table.colWidths.length; i++) {
    w += (table.colWidths[i] ?? 0) * sx
  }
  let h = 0
  for (let i = r; i < r + rowSpan && i < table.rowHeights.length; i++) {
    h += (table.rowHeights[i] ?? 0) * sy
  }
  return { x: lx, y: ty, w, h }
}

/**
 * Rotate a local-frame point around the table's centre into world
 * coords. The TextEditOverlay positions itself at world (obj.x, obj.y)
 * and applies `transform: rotate(obj.rotation)` with `transformOrigin:
 * top-left`, so we feed it the cell's INNER top-left in world space.
 * The overlay's transform then rotates the cell-content frame by the
 * same angle, producing the same visual orientation as the rotated
 * Pixi cells underneath.
 */
function localToWorld(table: TableObject, lx: number, ly: number): { x: number; y: number } {
  const cx = table.x + table.width / 2
  const cy = table.y + table.height / 2
  const dx = lx - table.width / 2
  const dy = ly - table.height / 2
  const cos = Math.cos(table.rotation)
  const sin = Math.sin(table.rotation)
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
}

export function TableCellEditor({ table, slideId, mutationCtx }: TableCellEditorProps) {
  const { active, setActive, beginEdit, endEdit } = useTableEdit()
  const command = useCommand()

  // Resolve the target cell + its Y.Text body + bounding box. Returns
  // null when the editor shouldn't mount (no active cell, wrong table,
  // editing flag off, cell missing).
  const binding = useMemo(() => {
    if (active === null || !active.editing || active.tableId !== table.id) return null
    // A cell the snapshot does not have yet (a row appended by Tab a
    // moment ago) is read from the document, so the editor moves into it
    // in this render and no keystroke falls between two editors.
    const source =
      table.rows[active.r]?.[active.c] !== undefined
        ? table
        : (liveTable(mutationCtx, table.id) ?? table)
    const origin = resolveOrigin(source, active.r, active.c)
    const cell = source.rows[origin.r]?.[origin.c]
    if (cell === undefined) return null
    if (!(cell.text instanceof Y.Text)) return null
    const local = cellLocalBbox(source, origin.r, origin.c)
    if (local === null) return null
    return { table: source, r: origin.r, c: origin.c, cell, yText: cell.text, local }
  }, [active, table, mutationCtx])

  // Synthetic TextObject driving TextEditOverlay. `obj.id` is the
  // `${tableId}#${r},${c}` form SceneGraph.setTextNodeFaded walks back
  // to the per-cell HTMLText.
  const synthetic = useMemo<TextObject | null>(() => {
    if (binding === null) return null
    const table = binding.table
    const d = table.defaults
    const cell = binding.cell
    const padding = cell.padding ?? d.padding
    const innerX = binding.local.x + padding.left
    const innerY = binding.local.y + padding.top
    const innerW = Math.max(1, binding.local.w - padding.left - padding.right)
    const innerH = Math.max(1, binding.local.h - padding.top - padding.bottom)
    const world = localToWorld(table, innerX, innerY)
    const obj: TextObject = {
      id: `${table.id}#${binding.r},${binding.c}`,
      type: 'text',
      x: world.x,
      y: world.y,
      width: innerW,
      height: innerH,
      rotation: table.rotation,
      opacity: 1,
      text: binding.yText,
      fontSize: cell.fontSize ?? d.fontSize,
      fontWeight: cell.fontWeight ?? d.fontWeight,
      color: hexResolve(cell.color ?? d.color, 0x111111),
      align: cell.align ?? d.align,
      vAlign: cell.vAlign ?? d.vAlign,
      // Every value below that shapes the line boxes is resolved exactly as
      // the table renderer's cell style resolves it (tableRenderer.ts,
      // resolveCellStyle). The editor used to pin 1.2 and drop the rest, so
      // on any table whose cells were not 1.2 — every imported one — the
      // caret ran on different lines from the glyphs under it.
      lineHeight: cell.lineHeight ?? d.lineHeight ?? 1.2,
      italic: cell.italic ?? d.italic ?? false,
      letterSpacing: cell.letterSpacing ?? d.letterSpacing ?? 0,
      textTransform: cell.textTransform ?? d.textTransform ?? 'none',
      fontFamily: d.fontFamily ?? DEFAULT_FONT_STACK,
    }
    return obj
  }, [binding])

  // The cell body as commands address it.
  const row = binding?.r
  const col = binding?.c
  const cellTarget = useMemo(
    () =>
      row === undefined || col === undefined
        ? null
        : { slide: slideId, object: table.id, cell: { row, col } },
    [row, col, slideId, table.id],
  )

  if (binding === null || synthetic === null || cellTarget === null) return null
  const current = binding.table

  // Cell nav — intercept Tab / Shift+Tab BEFORE TextEditOverlay's
  // onKeyDown sees them. `onKeyDownCapture` fires on the wrapper
  // before the contenteditable inside. Enter is intentionally NOT
  // intercepted — it falls through to the contenteditable so the
  // user can write multi-paragraph text in a cell (matches the way
  // Enter behaves inside a regular text box). Cmd/Ctrl+Enter still
  // jumps to the next row for spreadsheet-style fast entry.
  const moveTo = (nr: number, nc: number): void => {
    setActive({ tableId: table.id, r: nr, c: nc })
    beginEdit({ tableId: table.id, r: nr, c: nc })
  }
  /** Append a row to move into; false when it could not be added (the table is at its row limit, or gone). */
  const appendRow = (): boolean =>
    command.tryRun('table.row.insert', { slide: slideId, table: table.id }) !== null
  const tabNext = (): void => {
    const cols = current.colWidths.length
    const rows = current.rows.length
    let nr = binding.r
    let nc = binding.c + 1
    if (nc >= cols) {
      nc = 0
      nr += 1
      if (nr >= rows) {
        if (!appendRow()) return
        nr = rows
      }
    }
    moveTo(nr, nc)
  }
  const tabPrev = (): void => {
    const cols = current.colWidths.length
    let nr = binding.r
    let nc = binding.c - 1
    if (nc < 0) {
      if (nr === 0) return
      nr -= 1
      nc = cols - 1
    }
    moveTo(nr, nc)
  }
  const enterRow = (): void => {
    const rows = current.rows.length
    let nr = binding.r + 1
    if (nr >= rows) {
      if (!appendRow()) return
      nr = rows
    }
    moveTo(nr, binding.c)
  }

  return (
    <div
      data-testid="table-cell-editor"
      onKeyDownCapture={(e) => {
        if (e.key === 'Tab') {
          e.preventDefault()
          e.stopPropagation()
          if (e.shiftKey) tabPrev()
          else tabNext()
          return
        }
        // Cmd/Ctrl+Enter — spreadsheet-style "commit + move down".
        // Plain Enter (and Shift+Enter) fall through to the contenteditable
        // so the user can insert paragraph / soft-line breaks inside the
        // cell. Esc is handled by TextEditOverlay itself (calls onEnd →
        // endEdit).
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.stopPropagation()
          enterRow()
          return
        }
      }}
    >
      <TextEditOverlay key={synthetic.id} obj={synthetic} target={cellTarget} onEnd={endEdit} />
    </div>
  )
}
