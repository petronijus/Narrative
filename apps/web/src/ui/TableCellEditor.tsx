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
 * Cell-only keyboard nav (Tab / Shift+Tab / Enter → next-row) is
 * intercepted on `onKeyDownCapture` of the wrapper div *before* the
 * contenteditable inside TextEditOverlay sees the key. Shift+Enter
 * still inserts a soft line break inside the cell.
 */

import { useMemo, useRef } from 'react'
import * as Y from 'yjs'
import { type ObjectsMutationContext, insertTableRow } from '@narrative/slide-model'
import { isTokenRef, type TableObject, type TextObject } from '@narrative/shared'
import type { TokenRef } from '@narrative/shared'
import { useTableEdit } from '../state/TableEditContext.js'
import { TextEditOverlay } from './TextEditOverlay.js'

export interface TableCellEditorProps {
  table: TableObject
  mutationCtx: ObjectsMutationContext
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

export function TableCellEditor({ table, mutationCtx }: TableCellEditorProps) {
  const { active, setActive, beginEdit, endEdit } = useTableEdit()
  const mutationCtxRef = useRef(mutationCtx)
  mutationCtxRef.current = mutationCtx

  // Resolve the target cell + its Y.Text body + bounding box. Returns
  // null when the editor shouldn't mount (no active cell, wrong table,
  // editing flag off, cell missing).
  const binding = useMemo(() => {
    if (active === null || !active.editing || active.tableId !== table.id) return null
    const origin = resolveOrigin(table, active.r, active.c)
    const cell = table.rows[origin.r]?.[origin.c]
    if (cell === undefined) return null
    if (!(cell.text instanceof Y.Text)) return null
    const local = cellLocalBbox(table, origin.r, origin.c)
    if (local === null) return null
    return { r: origin.r, c: origin.c, cell, yText: cell.text, local }
  }, [active, table])

  // Synthetic TextObject driving TextEditOverlay. `obj.id` is the
  // `${tableId}#${r},${c}` form SceneGraph.setTextNodeFaded walks back
  // to the per-cell HTMLText.
  const synthetic = useMemo<TextObject | null>(() => {
    if (binding === null) return null
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
      lineHeight: 1.2,
    }
    if (d.fontFamily !== undefined) obj.fontFamily = d.fontFamily
    return obj
  }, [binding, table])

  if (binding === null || synthetic === null) return null

  // Cell nav — intercept Tab / Shift+Tab / plain Enter BEFORE
  // TextEditOverlay's onKeyDown sees them. `onKeyDownCapture` fires
  // on the wrapper before the contenteditable inside.
  const moveTo = (nr: number, nc: number): void => {
    setActive({ tableId: table.id, r: nr, c: nc })
    beginEdit({ tableId: table.id, r: nr, c: nc })
  }
  const tabNext = (): void => {
    const cols = table.colWidths.length
    const rows = table.rows.length
    let nr = binding.r
    let nc = binding.c + 1
    if (nc >= cols) {
      nc = 0
      nr += 1
      if (nr >= rows) {
        insertTableRow(mutationCtxRef.current, table.id, -1)
        nr = rows
      }
    }
    moveTo(nr, nc)
  }
  const tabPrev = (): void => {
    const cols = table.colWidths.length
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
    const rows = table.rows.length
    let nr = binding.r + 1
    if (nr >= rows) {
      insertTableRow(mutationCtxRef.current, table.id, -1)
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
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          e.stopPropagation()
          enterRow()
          return
        }
        // Shift+Enter falls through to TextEditOverlay's contenteditable,
        // which inserts a soft line break inside the cell. Esc is
        // handled by TextEditOverlay itself (calls onEnd → endEdit).
      }}
    >
      <TextEditOverlay obj={synthetic} mutationCtx={mutationCtx} onEnd={endEdit} />
    </div>
  )
}
