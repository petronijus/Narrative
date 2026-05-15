/**
 * ui/TableRangeHighlight.tsx
 *
 * M29 Phase 3 — translucent overlay covering the drag-selected range
 * of cells inside a TableObject. Positioned in slide-world coords so
 * the canvas transform applied by its parent puts the highlight where
 * the user's pointer is, on top of the Pixi-drawn cell fills/borders.
 *
 * Pure presentational — reads `range` from TableEditContext and the
 * table object from `useSlideObjects`. No pointer handlers; the canvas's
 * pointer flow (in EditorLayout) drives the range state.
 */

import { useMemo } from 'react'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useTableEdit } from '../state/TableEditContext.js'
import type { TableObject } from '@narrative/shared'

/**
 * World-coords bbox covering the rectangle (r0..r1) × (c0..c1).
 * Mirrors the renderer's rescale-to-fit-width rule for col/row sizes.
 */
function rangeBbox(
  t: TableObject,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
): { x: number; y: number; w: number; h: number } | null {
  const rows = t.rowHeights.length
  const cols = t.colWidths.length
  if (rows === 0 || cols === 0) return null
  const colSum = t.colWidths.reduce((a, b) => a + b, 0) || 1
  const rowSum = t.rowHeights.reduce((a, b) => a + b, 0) || 1
  const sx = t.width / colSum
  const sy = t.height / rowSum
  const lo = (start: number, n: number, sizes: number[], scale: number): number => {
    let acc = 0
    for (let i = 0; i < Math.max(0, Math.min(start, n)); i++) acc += (sizes[i] ?? 0) * scale
    return acc
  }
  const hi = (end: number, n: number, sizes: number[], scale: number): number => {
    let acc = 0
    for (let i = 0; i <= Math.max(-1, Math.min(end, n - 1)); i++) acc += (sizes[i] ?? 0) * scale
    return acc
  }
  const left = lo(c0, cols, t.colWidths, sx)
  const right = hi(c1, cols, t.colWidths, sx)
  const top = lo(r0, rows, t.rowHeights, sy)
  const bottom = hi(r1, rows, t.rowHeights, sy)
  return { x: t.x + left, y: t.y + top, w: right - left, h: bottom - top }
}

export function TableRangeHighlight() {
  const { range } = useTableEdit()
  const { objects } = useSlideObjects()
  const table = useMemo(() => {
    if (range === null) return null
    const obj = objects.find((o) => o.id === range.tableId)
    return obj !== undefined && obj.type === 'table' ? obj : null
  }, [objects, range])
  const bbox = useMemo(() => {
    if (range === null || table === null) return null
    return rangeBbox(
      table,
      Math.min(range.r0, range.r1),
      Math.min(range.c0, range.c1),
      Math.max(range.r0, range.r1),
      Math.max(range.c0, range.c1),
    )
  }, [range, table])
  if (range === null || table === null || bbox === null) return null
  // Rotate around the table's centre so the highlight tracks rotation
  // alongside the Pixi-rendered cells.
  const cxLocal = table.width / 2 - (bbox.x - table.x)
  const cyLocal = table.height / 2 - (bbox.y - table.y)
  return (
    <div
      aria-hidden="true"
      data-testid="table-range-highlight"
      style={{
        position: 'absolute',
        left: bbox.x,
        top: bbox.y,
        width: bbox.w,
        height: bbox.h,
        transform: `rotate(${table.rotation}rad)`,
        transformOrigin: `${cxLocal}px ${cyLocal}px`,
        background: 'rgba(59, 130, 246, 0.18)',
        outline: '2px solid rgba(59, 130, 246, 0.75)',
        outlineOffset: '-1px',
        pointerEvents: 'none',
        zIndex: 25,
      }}
    />
  )
}
