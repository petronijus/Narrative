/**
 * ui/TableBorderSelectionOverlay.tsx
 *
 * M29 — thin blue indicator drawn on top of the table whenever the
 * inspector's border-preset grid has an icon active. Shows the user
 * exactly which edges the style controls are about to modify, even
 * when those edges are currently invisible (width 0, white-on-white,
 * etc.). Mirrors Keynote's blue selection markers in the border
 * inspector.
 *
 * Lives in slide-world coords so it tracks the table as it moves /
 * rotates, but line stroke is divided by `zoom` so it stays at a
 * constant ~2 screen-px regardless of artboard scale — same trick the
 * range-highlight + TableChrome use.
 */

import { useMemo } from 'react'
import type { TableBorderPreset } from '@narrative/slide-model'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useTableEdit } from '../state/TableEditContext.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import type { TableObject } from '@narrative/shared'

/** Cumulative column edges in TABLE-LOCAL world-px, rescaled so the
 *  edges sit on the same pixels the Pixi renderer drew the cells on. */
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

type CellEdge = 'top' | 'right' | 'bottom' | 'left'

/**
 * For a given preset + cell position inside the target range, return
 * the set of edges that the preset will stamp on that cell. Kept in
 * sync with `edgesForPreset` in `tableMutations.ts` — both files are
 * pure and tiny so duplicating the table is fine. Centralising would
 * require pulling slide-model types into a shared location.
 */
function edgesForPreset(
  preset: TableBorderPreset,
  r: number,
  c: number,
  range: { r0: number; c0: number; r1: number; c1: number },
): CellEdge[] {
  const isTopRow = r === range.r0
  const isBottomRow = r === range.r1
  const isLeftCol = c === range.c0
  const isRightCol = c === range.c1
  switch (preset) {
    case 'none':
      return ['top', 'right', 'bottom', 'left']
    case 'all':
      return ['top', 'right', 'bottom', 'left']
    case 'outer': {
      const out: CellEdge[] = []
      if (isTopRow) out.push('top')
      if (isBottomRow) out.push('bottom')
      if (isLeftCol) out.push('left')
      if (isRightCol) out.push('right')
      return out
    }
    case 'inside': {
      const out: CellEdge[] = []
      if (!isTopRow) out.push('top')
      if (!isLeftCol) out.push('left')
      return out
    }
    case 'top':
      return isTopRow ? ['top'] : []
    case 'bottom':
      return isBottomRow ? ['bottom'] : []
    case 'left':
      return isLeftCol ? ['left'] : []
    case 'right':
      return isRightCol ? ['right'] : []
    case 'insideH':
      return isTopRow ? [] : ['top']
    case 'insideV':
      return isLeftCol ? [] : ['left']
  }
}

interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
}

export function TableBorderSelectionOverlay() {
  const { active, range, activeBorderPreset } = useTableEdit()
  const { objects } = useSlideObjects()
  const { zoom } = useZoomLevel()
  const inv = 1 / (zoom || 1)

  const table = useMemo<TableObject | null>(() => {
    if (activeBorderPreset === null) return null
    // Prefer the explicit table referenced by the range or active cell;
    // otherwise the preset target is "unknown" (the user hasn't focused
    // a specific table yet) → don't draw.
    const tableId = range !== null ? range.tableId : active !== null ? active.tableId : null
    if (tableId === null) return null
    const obj = objects.find((o) => o.id === tableId)
    return obj !== undefined && obj.type === 'table' ? obj : null
  }, [objects, activeBorderPreset, range, active])

  const segments = useMemo<Segment[]>(() => {
    if (table === null || activeBorderPreset === null) return []
    // Resolve the target range — same precedence as TableInspector:
    // explicit drag-selection → active cell (1×1) → whole table.
    const targetRange =
      range !== null && range.tableId === table.id
        ? { r0: range.r0, c0: range.c0, r1: range.r1, c1: range.c1 }
        : active !== null && active.tableId === table.id
          ? { r0: active.r, c0: active.c, r1: active.r, c1: active.c }
          : {
              r0: 0,
              c0: 0,
              r1: Math.max(0, table.rows.length - 1),
              c1: Math.max(0, table.colWidths.length - 1),
            }
    const r0 = Math.min(targetRange.r0, targetRange.r1)
    const r1 = Math.max(targetRange.r0, targetRange.r1)
    const c0 = Math.min(targetRange.c0, targetRange.c1)
    const c1 = Math.max(targetRange.c0, targetRange.c1)

    const colX = cumulativeCols(table)
    const rowY = cumulativeRows(table)
    const out: Segment[] = []
    for (let r = r0; r <= r1; r++) {
      const rowCells = table.rows[r]
      if (rowCells === undefined) continue
      for (let c = c0; c <= c1 && c < rowCells.length; c++) {
        const cell = rowCells[c]
        if (cell === undefined) continue
        // Skip merge-continuation cells — the origin draws the merged
        // area, so the indicator on a pointer would be wrong.
        if (cell.mergeOriginR !== undefined || cell.mergeOriginC !== undefined) continue
        const edges = edgesForPreset(activeBorderPreset, r, c, { r0, c0, r1, c1 })
        const x = colX[c] ?? 0
        const y = rowY[r] ?? 0
        const w = (colX[c + 1] ?? x) - x
        const h = (rowY[r + 1] ?? y) - y
        for (const edge of edges) {
          switch (edge) {
            case 'top':
              out.push({ x1: x, y1: y, x2: x + w, y2: y })
              break
            case 'right':
              out.push({ x1: x + w, y1: y, x2: x + w, y2: y + h })
              break
            case 'bottom':
              out.push({ x1: x, y1: y + h, x2: x + w, y2: y + h })
              break
            case 'left':
              out.push({ x1: x, y1: y, x2: x, y2: y + h })
              break
          }
        }
      }
    }
    return out
  }, [table, activeBorderPreset, range, active])

  if (table === null || segments.length === 0) return null

  return (
    <div
      aria-hidden="true"
      data-testid="table-border-selection-overlay"
      style={{
        position: 'absolute',
        left: table.x,
        top: table.y,
        width: table.width,
        height: table.height,
        // Rotate around the table centre so the overlay tracks rotation
        // alongside the Pixi-rendered cells.
        transform: `rotate(${table.rotation}rad)`,
        transformOrigin: `${table.width / 2}px ${table.height / 2}px`,
        pointerEvents: 'none',
        zIndex: 26,
        overflow: 'visible',
      }}
    >
      <svg
        width={table.width}
        height={table.height}
        viewBox={`0 0 ${table.width} ${table.height}`}
        style={{ position: 'absolute', inset: 0, overflow: 'visible' }}
      >
        {segments.map((s, i) => (
          <line
            key={i}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke="rgba(59, 130, 246, 0.95)"
            strokeWidth={2 * inv}
            strokeLinecap="round"
          />
        ))}
      </svg>
    </div>
  )
}
