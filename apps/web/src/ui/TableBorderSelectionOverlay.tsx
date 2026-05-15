/**
 * ui/TableBorderSelectionOverlay.tsx
 *
 * M29 — selection-time grid guides + preset indicator drawn on top of
 * a selected table.
 *
 *   Always-on (whenever the table is in the canvas selection):
 *     thin faint-blue lines on every cell boundary (outer rectangle +
 *     interior horizontals + verticals) so the user can see the cell
 *     layout even when the actual borders are invisible — width 0,
 *     white-on-white, missing default, etc. Mirrors Keynote's "ghost
 *     grid" on a selected table.
 *
 *   When an inspector preset icon is active for this table:
 *     the edges that the preset targets are drawn BRIGHTER and a touch
 *     THICKER on top of the guides so the user can see exactly which
 *     edges the style controls are about to modify.
 *
 * Lives in slide-world coords so it tracks the table as it moves /
 * rotates, but every stroke is divided by `zoom` so it stays at a
 * constant screen-px width — same trick the range-highlight + chrome
 * use.
 */

import { useMemo } from 'react'
import type { TableBorderPreset } from '@narrative/slide-model'
import { useTableEdit } from '../state/TableEditContext.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import type { TableObject } from '@narrative/shared'

export interface TableBorderSelectionOverlayProps {
  table: TableObject
}

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
 * sync with `edgesForPreset` in `tableMutations.ts`.
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

export function TableBorderSelectionOverlay({ table }: TableBorderSelectionOverlayProps) {
  const { active, range, activeBorderPreset } = useTableEdit()
  const { zoom } = useZoomLevel()
  const inv = 1 / (zoom || 1)

  const colX = useMemo(() => cumulativeCols(table), [table])
  const rowY = useMemo(() => cumulativeRows(table), [table])

  // Always-on grid guides. The perimeter is drawn as full-length lines;
  // interior boundaries get split into per-column / per-row segments so
  // we can skip any segment that falls INSIDE a merged-cell area —
  // otherwise the guides would visually divide a merged cell, which is
  // exactly what merging is supposed to hide.
  const gridSegments = useMemo<Segment[]>(() => {
    const out: Segment[] = []
    const rowCount = table.rows.length
    const colCount = table.colWidths.length

    /**
     * True when the cell at (r, c) is a merge continuation whose origin
     * sits in an earlier row — i.e., the horizontal boundary at
     * `rowY[r]` cuts THROUGH a merged area for this column and we
     * should skip its segment there.
     */
    const horizontalBoundaryInsideMerge = (r: number, c: number): boolean => {
      const cell = table.rows[r]?.[c]
      if (cell === undefined) return false
      const origR = cell.mergeOriginR
      if (typeof origR !== 'number') return false
      return origR < r
    }

    /** Mirror of the above for vertical boundaries. */
    const verticalBoundaryInsideMerge = (r: number, c: number): boolean => {
      const cell = table.rows[r]?.[c]
      if (cell === undefined) return false
      const origC = cell.mergeOriginC
      if (typeof origC !== 'number') return false
      return origC < c
    }

    // Horizontal lines — one for every row boundary, including the
    // perimeter (r=0 and r=rowCount).
    for (let r = 0; r <= rowCount; r++) {
      const y = rowY[r] ?? 0
      const isInterior = r > 0 && r < rowCount
      if (!isInterior) {
        out.push({ x1: 0, y1: y, x2: table.width, y2: y })
        continue
      }
      // Walk columns and emit consecutive non-merged segments as a
      // single line each so the SVG node count stays modest.
      let segStartCol: number | null = null
      for (let c = 0; c <= colCount; c++) {
        const skip = c < colCount && horizontalBoundaryInsideMerge(r, c)
        if (skip) {
          if (segStartCol !== null) {
            out.push({
              x1: colX[segStartCol] ?? 0,
              y1: y,
              x2: colX[c] ?? table.width,
              y2: y,
            })
            segStartCol = null
          }
        } else if (segStartCol === null) {
          segStartCol = c
        }
      }
      if (segStartCol !== null) {
        out.push({
          x1: colX[segStartCol] ?? 0,
          y1: y,
          x2: colX[colCount] ?? table.width,
          y2: y,
        })
      }
    }

    // Vertical lines — mirror of the above.
    for (let c = 0; c <= colCount; c++) {
      const x = colX[c] ?? 0
      const isInterior = c > 0 && c < colCount
      if (!isInterior) {
        out.push({ x1: x, y1: 0, x2: x, y2: table.height })
        continue
      }
      let segStartRow: number | null = null
      for (let r = 0; r <= rowCount; r++) {
        const skip = r < rowCount && verticalBoundaryInsideMerge(r, c)
        if (skip) {
          if (segStartRow !== null) {
            out.push({
              x1: x,
              y1: rowY[segStartRow] ?? 0,
              x2: x,
              y2: rowY[r] ?? table.height,
            })
            segStartRow = null
          }
        } else if (segStartRow === null) {
          segStartRow = r
        }
      }
      if (segStartRow !== null) {
        out.push({
          x1: x,
          y1: rowY[segStartRow] ?? 0,
          x2: x,
          y2: rowY[rowCount] ?? table.height,
        })
      }
    }
    return out
  }, [colX, rowY, table.width, table.height, table.rows, table.colWidths])

  // Brighter overlay for the edges the active preset will stamp.
  const presetSegments = useMemo<Segment[]>(() => {
    if (activeBorderPreset === null || activeBorderPreset.tableId !== table.id) return []
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

    const out: Segment[] = []
    for (let r = r0; r <= r1; r++) {
      const rowCells = table.rows[r]
      if (rowCells === undefined) continue
      for (let c = c0; c <= c1 && c < rowCells.length; c++) {
        const cell = rowCells[c]
        if (cell === undefined) continue
        if (cell.mergeOriginR !== undefined || cell.mergeOriginC !== undefined) continue
        const edges = edgesForPreset(activeBorderPreset.preset, r, c, { r0, c0, r1, c1 })
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
  }, [activeBorderPreset, table, range, active, colX, rowY])

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
        {/* Pass 1 — faint cell-boundary guides, always visible. */}
        {gridSegments.map((s, i) => (
          <line
            key={`g-${i}`}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke="rgba(59, 130, 246, 0.4)"
            strokeWidth={1 * inv}
            shapeRendering="crispEdges"
          />
        ))}
        {/* Pass 2 — brighter overlay on the active preset's edges. */}
        {presetSegments.map((s, i) => (
          <line
            key={`p-${i}`}
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
