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
 * Every gesture dispatches commands (ADR 0010), one per pointer move and
 * each absolute from the pointer-down snapshot, so a frame that arrives
 * twice changes nothing: the move handle `object.update`, a boundary
 * `table.resizeColumn` / `table.resizeRow` with `keepTableSize`, the add /
 * remove handles `table.setSize`. The undo manager's capture window still
 * merges a gesture into one step.
 *
 * Lives in slide-world coords so it tracks the table's position, but
 * every visual dimension (axis thickness, corner handle size, dividers,
 * fonts) is multiplied by `inv = 1 / zoom` so the chrome stays a constant
 * screen-px size at any zoom — mirrors how TransformHandles, Rulers, and
 * the other canvas gizmos behave. The chrome rotates with the table.
 */

import { useMemo, useRef, useState } from 'react'
import { MAX_TABLE_TRACKS, MIN_TRACK_PX } from '@narrative/commands'
import type { TableObject } from '@narrative/shared'
import { useTableEdit } from '../state/TableEditContext.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import { useCommand } from '../state/useCommand.js'

export interface TableChromeProps {
  table: TableObject
  /** The slide the table is on — every gesture is a command addressed to it. */
  slideId: string
  isViewer: boolean
}

/** SCREEN-px width of the row-number axis and height of the column-
 *  letter axis. Same constant on both so the corner squares stay square.
 *  Multiplied by `inv` at render time → world-px = `AXIS_THICKNESS * inv`. */
const AXIS_THICKNESS = 24
/** SCREEN-px size of the corner buttons (move / add-col / add-row). */
const CORNER_SIZE = 20
/** SCREEN-px width of the boundary-drag hit zones. */
const BOUNDARY_HIT = 8
/** SCREEN-px font size for the column letters / row numbers. */
const AXIS_FONT = 11
/** SCREEN-px width of the inner dividers between header cells. */
const DIVIDER_PX = 1

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

export function TableChrome({ table, slideId, isViewer }: TableChromeProps) {
  const { active, setRange } = useTableEdit()
  const { zoom } = useZoomLevel()
  const command = useCommand()

  // Suppress chrome while a cell is being edited — the contenteditable
  // overlay owns focus and the chrome's hover affordances would just
  // get in the way.
  const editing = active !== null && active.tableId === table.id && active.editing
  const visible = !isViewer && !editing

  const colX = useMemo(() => cumulativeCols(table), [table])
  const rowY = useMemo(() => cumulativeRows(table), [table])

  // Inverse zoom — every visual dimension below is `<screen-px> * inv` so
  // it lands at the intended size on screen after the artboard's
  // scale(zoom) transform.
  const inv = 1 / (zoom || 1)
  const axis = AXIS_THICKNESS * inv
  // CORNER_SIZE intentionally NOT pre-multiplied: each corner handle
  // applies `transform: scale(inv)` itself so it can keep crisp lines
  // at any zoom (see CornerHandle for the rationale).
  const boundaryHit = BOUNDARY_HIT * inv
  const axisFont = AXIS_FONT * inv
  const divider = DIVIDER_PX * inv

  // Pointer scale: world coords → slide-screen px require dividing by
  // zoom for screen-pixel deltas. We grab live zoom for pointer math.
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  // Refs that stay stable across renders for the drag handlers.
  const tableRef = useRef(table)
  tableRef.current = table

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
      command.tryRun('object.update', {
        slide: slideId,
        object: tableRef.current.id,
        patch: { x: startX + dx, y: startY + dy },
      })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /**
   * Boundary drag between track `i` and `i + 1`: the two share their
   * combined size and the table keeps its own (Office semantics). Each move
   * sends track `i`'s new size in drawn px, clamped so neither track drops
   * under MIN_TRACK_PX; `keepTableSize` takes the difference from track
   * `i + 1`, so the frame is absolute however many arrive.
   */
  const startBoundaryDrag = (axis: 'col' | 'row', i: number, e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const isCol = axis === 'col'
    const start = isCol ? e.clientX : e.clientY
    const edges = isCol ? cumulativeCols(tableRef.current) : cumulativeRows(tableRef.current)
    const sizeA = (edges[i + 1] ?? 0) - (edges[i] ?? 0)
    const pair = (edges[i + 2] ?? 0) - (edges[i] ?? 0)
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent): void => {
      const screen = (isCol ? ev.clientX : ev.clientY) - start
      const { dx, dy } = toWorldDelta(isCol ? screen : 0, isCol ? 0 : screen)
      const size = Math.min(pair - MIN_TRACK_PX, Math.max(MIN_TRACK_PX, sizeA + (isCol ? dx : dy)))
      if (!(size >= MIN_TRACK_PX)) return // a pair too small to share
      command.tryRun(isCol ? 'table.resizeColumn' : 'table.resizeRow', {
        slide: slideId,
        table: tableRef.current.id,
        index: i,
        size,
        keepTableSize: true,
      })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /**
   * Top-right ⫼ / bottom-left ☰ — drag to add or remove columns / rows at
   * the end, one per average track size travelled (half a track rounds).
   * Each move asks `table.setSize` for the count the pointer is at, so it
   * is absolute; it is only sent when that count changes.
   */
  const startAddTrackDrag = (axis: 'col' | 'row', e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const isCol = axis === 'col'
    const start = isCol ? e.clientX : e.clientY
    const t = tableRef.current
    const startCount = isCol ? t.colWidths.length : t.rowHeights.length
    const avg = (isCol ? t.width : t.height) / Math.max(1, startCount)
    let lastApplied = startCount
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent): void => {
      const screen = (isCol ? ev.clientX : ev.clientY) - start
      const { dx, dy } = toWorldDelta(isCol ? screen : 0, isCol ? 0 : screen)
      const delta = Math.round((isCol ? dx : dy) / Math.max(1, avg))
      const target = Math.min(MAX_TABLE_TRACKS, Math.max(1, startCount + delta))
      if (target === lastApplied) return
      const out = command.tryRun('table.setSize', {
        slide: slideId,
        table: tableRef.current.id,
        [isCol ? 'cols' : 'rows']: target,
      })
      if (out !== null) lastApplied = target
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

  // The chrome's outer rect sits at the table's origin minus the (zoom-
  // independent) axis thickness on the left/top — wraps the table edges
  // so the row/column axes hug the cells.
  const outerStyle: React.CSSProperties = {
    position: 'absolute',
    left: table.x - axis,
    top: table.y - axis,
    width: table.width + axis * 2,
    height: table.height + axis * 2,
    transform: `rotate(${table.rotation}rad)`,
    transformOrigin: `${table.width / 2 + axis}px ${table.height / 2 + axis}px`,
    pointerEvents: 'none',
    zIndex: 28,
  }

  return (
    <div style={outerStyle} data-testid="table-chrome">
      {/* ── Top column-letter axis ───────────────────────────────────── */}
      <div
        style={{
          position: 'absolute',
          left: axis,
          top: 0,
          width: table.width,
          height: axis,
          pointerEvents: 'auto',
          // Subtle baseline separating the axis bar from the table cells
          // below — same colour as the inner dividers so the whole bar
          // reads as one strip of header chrome.
          borderBottom: `${divider}px solid rgba(0,0,0,0.12)`,
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
                height: axis,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                // Inner dividers between adjacent header cells — give a
                // visual cue that the columns are separately resizable.
                // Skip on the last cell so the right edge stays clean.
                borderRight: isLast ? 'none' : `${divider}px solid rgba(0,0,0,0.12)`,
                background: 'transparent',
                cursor: 'pointer',
                color: 'rgba(0,0,0,0.55)',
                fontSize: axisFont,
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
            onPointerDown={(e) => startBoundaryDrag('col', i, e)}
            style={{
              position: 'absolute',
              left: (colX[i + 1] ?? 0) - boundaryHit / 2,
              top: 0,
              width: boundaryHit,
              height: axis,
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
          top: axis,
          width: axis,
          height: table.height,
          pointerEvents: 'auto',
          // Subtle separator between row-number bar and table cells.
          borderRight: `${divider}px solid rgba(0,0,0,0.12)`,
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
                width: axis,
                height: (rowY[r + 1] ?? rowY[r] ?? 0) - (rowY[r] ?? 0),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                // Inner divider between row headers — same rationale as
                // the column letters.
                borderBottom: isLast ? 'none' : `${divider}px solid rgba(0,0,0,0.12)`,
                background: 'transparent',
                cursor: 'pointer',
                color: 'rgba(0,0,0,0.55)',
                fontSize: axisFont,
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
            onPointerDown={(e) => startBoundaryDrag('row', i, e)}
            style={{
              position: 'absolute',
              left: 0,
              top: (rowY[i + 1] ?? 0) - boundaryHit / 2,
              width: axis,
              height: boundaryHit,
              cursor: 'row-resize',
              background: 'transparent',
            }}
          />
        ))}
      </div>

      {/* ── Top-left ◯ : move-table handle ───────────────────────────── */}
      <CornerHandle
        cx={axis / 2}
        cy={axis / 2}
        inv={inv}
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
        cx={axis + table.width + axis / 2}
        cy={axis / 2}
        inv={inv}
        cursor="ew-resize"
        ariaLabel="Add or remove columns"
        onPointerDown={(e) => startAddTrackDrag('col', e)}
      >
        <span style={{ display: 'flex', gap: 2 }}>
          <span style={{ width: 2, height: 11, background: 'currentColor' }} />
          <span style={{ width: 2, height: 11, background: 'currentColor' }} />
        </span>
      </CornerHandle>

      {/* ── Bottom-left ☰ : add/remove rows ──────────────────────────── */}
      <CornerHandle
        cx={axis / 2}
        cy={axis + table.height + axis / 2}
        inv={inv}
        cursor="ns-resize"
        ariaLabel="Add or remove rows"
        onPointerDown={(e) => startAddTrackDrag('row', e)}
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
  cx,
  cy,
  inv,
  cursor,
  ariaLabel,
  onPointerDown,
  children,
}: {
  /** World-px center of the handle (X). */
  cx: number
  /** World-px center of the handle (Y). */
  cy: number
  /** 1 / zoom — applied via `scale(inv)` so the handle stays at constant
   *  screen-px regardless of artboard zoom. */
  inv: number
  cursor: string
  ariaLabel: string
  onPointerDown: (e: React.PointerEvent) => void
  children: React.ReactNode
}) {
  const [hover, setHover] = useState(false)
  // Same trick as `handleVisuals.tsx`: the element + its children use raw
  // CSS px (CORNER_SIZE = 20, border 1.5px, etc), and the wrapper applies
  // `transform: translate(-50%, -50%) scale(inv)` so the browser
  // composites the whole layer at native resolution. Result: sharp lines
  // at any zoom — multiplying border/box-shadow widths by `inv` would
  // produce sub-pixel CSS values that don't rasterize cleanly.
  return (
    <div
      role="button"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        position: 'absolute',
        left: cx,
        top: cy,
        width: CORNER_SIZE,
        height: CORNER_SIZE,
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
        transform: `translate(-50%, -50%) scale(${inv})`,
        transformOrigin: 'center',
      }}
    >
      {children}
    </div>
  )
}
