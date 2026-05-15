/**
 * ui/TableChrome.tsx
 *
 * M29 Phase 5 — Keynote-style chrome around a selected TableObject:
 *
 *   ┌─◯─────────────────────────────────┬─⫼─┐
 *   │       A       B       C       D       │
 *   ├───┬───────────────────────────────────┤
 *   │ 1 │                                   │
 *   │ 2 │                                   │
 *   │ 3 │           table content           │
 *   │ 4 │                                   │
 *   │ 5 │                                   │
 *   ├─☰─┴───────────────────────────────────┤
 *
 *   - Top-left ◯ : drag the whole table.
 *   - Top axis (letters)   : click a letter → select whole column;
 *                            drag a boundary → resize adjacent columns.
 *   - Left axis (numbers)  : same idea for rows.
 *   - Top-right ⫼          : drag right → append a column; drag left
 *                            (past one col width) → delete the last.
 *   - Bottom-left ☰        : same idea for rows.
 *
 * Mounts only when:
 *   - exactly ONE table is in the slide selection,
 *   - no cell is in edit mode (chrome would conflict with the
 *     contenteditable overlay's focus model),
 *   - role isn't viewer.
 *
 * Lives in slide-world coords so it scales with zoom alongside the
 * rest of the canvas overlays. The chrome rotates with the table.
 */

import { useMemo, useRef, useState } from 'react'
import {
  type ObjectsMutationContext,
  deleteTableCol,
  deleteTableRow,
  insertTableCol,
  insertTableRow,
  setTableColWidth,
  setTableRowHeight,
  updateObject,
} from '@narrative/slide-model'
import type { TableObject } from '@narrative/shared'
import { useTableEdit } from '../state/TableEditContext.js'
import { useZoomLevel } from '../state/useZoomLevel.js'

export interface TableChromeProps {
  table: TableObject
  mutationCtx: ObjectsMutationContext
  isViewer: boolean
}

/** Slide-px width of the row-number axis and height of the column-
 *  letter axis. Same constant on both so the corner squares stay square. */
const AXIS_THICKNESS = 24
/** Slide-px size of the corner buttons (move / add-col / add-row). */
const CORNER_SIZE = 20

const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const colLabel = (c: number): string => {
  // Excel-style: A..Z, AA..AZ, BA.., ... — handles tables wider than 26.
  let s = ''
  let n = c
  while (true) {
    s = `${COL_LETTERS[n % 26]}${s}`
    if (n < 26) break
    n = Math.floor(n / 26) - 1
  }
  return s
}

/**
 * Cumulative column edges in TABLE-LOCAL px, scaled to fit `table.width`
 * — mirrors the renderer's math so the chrome boundaries land on the
 * exact same pixels as the cell separators.
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

export function TableChrome({ table, mutationCtx, isViewer }: TableChromeProps) {
  const { active, setRange } = useTableEdit()
  const { zoom } = useZoomLevel()

  // Suppress chrome while a cell is being edited — the contenteditable
  // overlay owns focus and the chrome's hover affordances would just
  // get in the way.
  const editing = active !== null && active.tableId === table.id && active.editing
  const visible = !isViewer && !editing

  const colX = useMemo(() => cumulativeCols(table), [table])
  const rowY = useMemo(() => cumulativeRows(table), [table])

  // Pointer scale: world coords → slide-screen px require dividing by
  // zoom for screen-pixel deltas. We grab live zoom for pointer math.
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  // Refs that stay stable across renders for the drag handlers.
  const tableRef = useRef(table)
  tableRef.current = table
  const ctxRef = useRef(mutationCtx)
  ctxRef.current = mutationCtx

  if (!visible) return null

  // -------------------------------------------------------------------
  // Drag handlers
  // -------------------------------------------------------------------

  /** Convert a screen-px delta into world-px (slide-space) using the
   *  live zoom — the chrome itself is in world coords. */
  const toWorldDelta = (dx: number, dy: number): { dx: number; dy: number } => {
    const z = zoomRef.current === 0 ? 1 : zoomRef.current
    return { dx: dx / z, dy: dy / z }
  }

  /** Top-left circle — drag to move the whole table. */
  const onMoveHandlePointerDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const startScreenX = e.clientX
    const startScreenY = e.clientY
    const startX = tableRef.current.x
    const startY = tableRef.current.y
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent): void => {
      const { dx, dy } = toWorldDelta(ev.clientX - startScreenX, ev.clientY - startScreenY)
      updateObject(ctxRef.current, tableRef.current.id, {
        x: startX + dx,
        y: startY + dy,
      } as never)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** Column boundary drag — redistributes width between col `i` and
   *  col `i+1` so the total stays constant (Office semantics). */
  const onColBoundaryPointerDown =
    (i: number) =>
    (e: React.PointerEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const startScreenX = e.clientX
      const startW = [...tableRef.current.colWidths]
      const wA = startW[i] ?? 0
      const wB = startW[i + 1] ?? 0
      // The proportions vector → world-px ratio: a 1-world-px delta on
      // the boundary equals `colSum / table.width` of "proportion units".
      const colSum = startW.reduce((a, b) => a + b, 0) || 1
      const ratio = colSum / (tableRef.current.width || 1)
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      const onMove = (ev: PointerEvent): void => {
        const { dx } = toWorldDelta(ev.clientX - startScreenX, 0)
        const propDelta = dx * ratio
        const min = 4 // proportion-unit minimum so a column can't collapse to zero
        const newA = Math.max(min, wA + propDelta)
        const newB = Math.max(min, wB - propDelta)
        // Mutate both ends in a single transact (two ops; the CRDT batch
        // is the user-visible undo step).
        setTableColWidth(ctxRef.current, tableRef.current.id, i, newA)
        setTableColWidth(ctxRef.current, tableRef.current.id, i + 1, newB)
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }

  /** Row boundary drag — mirror of column boundary. */
  const onRowBoundaryPointerDown =
    (i: number) =>
    (e: React.PointerEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const startScreenY = e.clientY
      const startH = [...tableRef.current.rowHeights]
      const hA = startH[i] ?? 0
      const hB = startH[i + 1] ?? 0
      const rowSum = startH.reduce((a, b) => a + b, 0) || 1
      const ratio = rowSum / (tableRef.current.height || 1)
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      const onMove = (ev: PointerEvent): void => {
        const { dy } = toWorldDelta(0, ev.clientY - startScreenY)
        const propDelta = dy * ratio
        const min = 4
        const newA = Math.max(min, hA + propDelta)
        const newB = Math.max(min, hB - propDelta)
        setTableRowHeight(ctxRef.current, tableRef.current.id, i, newA)
        setTableRowHeight(ctxRef.current, tableRef.current.id, i + 1, newB)
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }

  /** Top-right ⫼ — drag horizontally to append / remove columns. */
  const onAddColHandlePointerDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const startScreenX = e.clientX
    const startCols = tableRef.current.colWidths.length
    const avgColW = tableRef.current.width / Math.max(1, tableRef.current.colWidths.length)
    let lastApplied = startCols
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent): void => {
      const { dx } = toWorldDelta(ev.clientX - startScreenX, 0)
      // Cross half-a-column threshold to add/remove one.
      const delta = Math.round(dx / Math.max(1, avgColW))
      const targetCols = Math.max(1, startCols + delta)
      while (lastApplied < targetCols) {
        insertTableCol(ctxRef.current, tableRef.current.id, -1)
        lastApplied += 1
      }
      while (lastApplied > targetCols) {
        deleteTableCol(ctxRef.current, tableRef.current.id, lastApplied - 1)
        lastApplied -= 1
      }
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** Bottom-left ☰ — drag vertically to append / remove rows. */
  const onAddRowHandlePointerDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const startScreenY = e.clientY
    const startRows = tableRef.current.rowHeights.length
    const avgRowH = tableRef.current.height / Math.max(1, tableRef.current.rowHeights.length)
    let lastApplied = startRows
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent): void => {
      const { dy } = toWorldDelta(0, ev.clientY - startScreenY)
      const delta = Math.round(dy / Math.max(1, avgRowH))
      const targetRows = Math.max(1, startRows + delta)
      while (lastApplied < targetRows) {
        insertTableRow(ctxRef.current, tableRef.current.id, -1)
        lastApplied += 1
      }
      while (lastApplied > targetRows) {
        deleteTableRow(ctxRef.current, tableRef.current.id, lastApplied - 1)
        lastApplied -= 1
      }
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /**
   * Pointer-down on a column letter → select that column; dragging
   * across other letters extends the range to cover every column from
   * the anchor to the cursor. Mirrors Keynote / Excel's "click + drag
   * across the column headers" pattern.
   *
   * We resolve the drag target via `document.elementFromPoint` on each
   * pointermove — that lets us walk to whichever letter the cursor is
   * currently over, even when pointer events have been captured
   * elsewhere.
   */
  const onColLetterPointerDown =
    (startCol: number) =>
    (e: React.PointerEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      setRange({
        tableId: tableRef.current.id,
        r0: 0,
        c0: startCol,
        r1: tableRef.current.rows.length - 1,
        c1: startCol,
      })
      const onMove = (ev: PointerEvent): void => {
        const target = document.elementFromPoint(ev.clientX, ev.clientY)
        if (target === null) return
        const letter = (target as Element).closest('[data-col-letter]') as HTMLElement | null
        if (letter === null) return
        const c = Number(letter.dataset['colLetter'])
        if (!Number.isInteger(c)) return
        setRange({
          tableId: tableRef.current.id,
          r0: 0,
          c0: startCol,
          r1: tableRef.current.rows.length - 1,
          c1: c,
        })
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }

  /** Same pattern for row numbers — drag down across numbers to
   *  extend the row range. */
  const onRowNumberPointerDown =
    (startRow: number) =>
    (e: React.PointerEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      setRange({
        tableId: tableRef.current.id,
        r0: startRow,
        c0: 0,
        r1: startRow,
        c1: tableRef.current.colWidths.length - 1,
      })
      const onMove = (ev: PointerEvent): void => {
        const target = document.elementFromPoint(ev.clientX, ev.clientY)
        if (target === null) return
        const num = (target as Element).closest('[data-row-number]') as HTMLElement | null
        if (num === null) return
        const r = Number(num.dataset['rowNumber'])
        if (!Number.isInteger(r)) return
        setRange({
          tableId: tableRef.current.id,
          r0: startRow,
          c0: 0,
          r1: r,
          c1: tableRef.current.colWidths.length - 1,
        })
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }

  // -------------------------------------------------------------------
  // Layout in world coords
  // -------------------------------------------------------------------

  // The chrome's outer rect sits at the table's origin minus the axis
  // thickness on the left/top — wraps the table edges so the row /
  // column axes hug the cells.
  const outerStyle: React.CSSProperties = {
    position: 'absolute',
    left: table.x - AXIS_THICKNESS,
    top: table.y - AXIS_THICKNESS,
    width: table.width + AXIS_THICKNESS * 2,
    height: table.height + AXIS_THICKNESS * 2,
    transform: `rotate(${table.rotation}rad)`,
    transformOrigin: `${table.width / 2 + AXIS_THICKNESS}px ${table.height / 2 + AXIS_THICKNESS}px`,
    pointerEvents: 'none',
    zIndex: 28,
  }

  return (
    <div style={outerStyle} data-testid="table-chrome">
      {/* ── Top column-letter axis ───────────────────────────────────── */}
      <div
        style={{
          position: 'absolute',
          left: AXIS_THICKNESS,
          top: 0,
          width: table.width,
          height: AXIS_THICKNESS,
          pointerEvents: 'auto',
          // Subtle baseline separating the axis bar from the table cells
          // below — same colour as the inner dividers so the whole bar
          // reads as one strip of header chrome.
          borderBottom: '1px solid rgba(0,0,0,0.12)',
        }}
      >
        {table.colWidths.map((_, c) => {
          const isLast = c === table.colWidths.length - 1
          return (
            <button
              key={c}
              type="button"
              data-col-letter={c}
              onPointerDown={onColLetterPointerDown(c)}
              style={{
                position: 'absolute',
                left: colX[c],
                top: 0,
                width: (colX[c + 1] ?? colX[c] ?? 0) - (colX[c] ?? 0),
                height: AXIS_THICKNESS,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                // Inner dividers between adjacent header cells — give a
                // visual cue that the columns are separately resizable.
                // Skip on the last cell so the right edge stays clean.
                borderRight: isLast ? 'none' : '1px solid rgba(0,0,0,0.12)',
                background: 'transparent',
                cursor: 'pointer',
                color: 'rgba(0,0,0,0.55)',
                fontSize: 11,
                fontWeight: 500,
                userSelect: 'none',
              }}
            >
              {colLabel(c)}
            </button>
          )
        })}
        {/* Column boundary drag handles — one per internal divider. */}
        {table.colWidths.slice(0, -1).map((_, i) => (
          <div
            key={`bnd-${i}`}
            onPointerDown={onColBoundaryPointerDown(i)}
            style={{
              position: 'absolute',
              left: (colX[i + 1] ?? 0) - 4,
              top: 0,
              width: 8,
              height: AXIS_THICKNESS,
              cursor: 'col-resize',
              background: 'transparent',
            }}
          />
        ))}
      </div>

      {/* ── Left row-number axis ─────────────────────────────────────── */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: AXIS_THICKNESS,
          width: AXIS_THICKNESS,
          height: table.height,
          pointerEvents: 'auto',
          // Subtle separator between row-number bar and table cells.
          borderRight: '1px solid rgba(0,0,0,0.12)',
        }}
      >
        {table.rowHeights.map((_, r) => {
          const isLast = r === table.rowHeights.length - 1
          return (
            <button
              key={r}
              type="button"
              data-row-number={r}
              onPointerDown={onRowNumberPointerDown(r)}
              style={{
                position: 'absolute',
                left: 0,
                top: rowY[r],
                width: AXIS_THICKNESS,
                height: (rowY[r + 1] ?? rowY[r] ?? 0) - (rowY[r] ?? 0),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                // Inner divider between row headers — same rationale as
                // the column letters.
                borderBottom: isLast ? 'none' : '1px solid rgba(0,0,0,0.12)',
                background: 'transparent',
                cursor: 'pointer',
                color: 'rgba(0,0,0,0.55)',
                fontSize: 11,
                fontWeight: 500,
                userSelect: 'none',
              }}
            >
              {r + 1}
            </button>
          )
        })}
        {table.rowHeights.slice(0, -1).map((_, i) => (
          <div
            key={`rbnd-${i}`}
            onPointerDown={onRowBoundaryPointerDown(i)}
            style={{
              position: 'absolute',
              left: 0,
              top: (rowY[i + 1] ?? 0) - 4,
              width: AXIS_THICKNESS,
              height: 8,
              cursor: 'row-resize',
              background: 'transparent',
            }}
          />
        ))}
      </div>

      {/* ── Top-left ◯ : move-table handle ───────────────────────────── */}
      <CornerHandle
        x={(AXIS_THICKNESS - CORNER_SIZE) / 2}
        y={(AXIS_THICKNESS - CORNER_SIZE) / 2}
        size={CORNER_SIZE}
        cursor="move"
        ariaLabel="Move table"
        onPointerDown={onMoveHandlePointerDown}
      >
        <span
          style={{
            display: 'block',
            width: 10,
            height: 10,
            borderRadius: '50%',
            border: '1.5px solid currentColor',
          }}
        />
      </CornerHandle>

      {/* ── Top-right ⫼ : add/remove columns ─────────────────────────── */}
      <CornerHandle
        x={AXIS_THICKNESS + table.width + (AXIS_THICKNESS - CORNER_SIZE) / 2}
        y={(AXIS_THICKNESS - CORNER_SIZE) / 2}
        size={CORNER_SIZE}
        cursor="ew-resize"
        ariaLabel="Add or remove columns"
        onPointerDown={onAddColHandlePointerDown}
      >
        <span style={{ display: 'flex', gap: 2 }}>
          <span style={{ width: 2, height: 11, background: 'currentColor' }} />
          <span style={{ width: 2, height: 11, background: 'currentColor' }} />
        </span>
      </CornerHandle>

      {/* ── Bottom-left ☰ : add/remove rows ──────────────────────────── */}
      <CornerHandle
        x={(AXIS_THICKNESS - CORNER_SIZE) / 2}
        y={AXIS_THICKNESS + table.height + (AXIS_THICKNESS - CORNER_SIZE) / 2}
        size={CORNER_SIZE}
        cursor="ns-resize"
        ariaLabel="Add or remove rows"
        onPointerDown={onAddRowHandlePointerDown}
      >
        <span
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            alignItems: 'center',
          }}
        >
          <span style={{ width: 11, height: 2, background: 'currentColor' }} />
          <span style={{ width: 11, height: 2, background: 'currentColor' }} />
        </span>
      </CornerHandle>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tiny presentational helper
// ---------------------------------------------------------------------------

function CornerHandle({
  x,
  y,
  size,
  cursor,
  ariaLabel,
  onPointerDown,
  children,
}: {
  x: number
  y: number
  size: number
  cursor: string
  ariaLabel: string
  onPointerDown: (e: React.PointerEvent) => void
  children: React.ReactNode
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      role="button"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'white',
        border: '1.5px solid rgba(59, 130, 246, 0.9)',
        color: hover ? 'rgba(59, 130, 246, 1)' : 'rgba(59, 130, 246, 0.85)',
        cursor,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
        userSelect: 'none',
      }}
    >
      {children}
    </div>
  )
}
