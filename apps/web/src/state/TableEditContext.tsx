/**
 * state/TableEditContext.tsx
 *
 * M29 Phase 2 — active-cell + range state for the first-class TableObject.
 *
 * Three logical states:
 *   - `active = null`                        : nothing selected inside any table.
 *   - `active = { r, c, editing: false }`    : single cell highlighted; inspector
 *                                              targets it, no overlay mounted.
 *   - `active = { r, c, editing: true }`     : contenteditable overlay open on the cell.
 *   - `range = { r0, c0, r1, c1 }`           : Phase 3 — drag-selected rectangle.
 *                                              Coexists with `active`: `active`
 *                                              is the anchor cell of the drag; the
 *                                              range covers `[r0..r1]` × `[c0..c1]`.
 *                                              When `range` is a single cell it is
 *                                              kept null (single-cell selection is
 *                                              encoded purely by `active`).
 *
 * Separate from TextEditContext because they coexist; not persisted to
 * Y.Doc — purely ephemeral editor chrome state.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { TableBorderPreset } from '@narrative/slide-model'

export interface ActiveCell {
  tableId: string
  r: number
  c: number
  /** True when the contenteditable overlay should mount over this cell. */
  editing: boolean
}

export interface CellRange {
  tableId: string
  r0: number
  c0: number
  r1: number
  c1: number
}

/** Which border-preset icon (if any) is currently selected in the
 *  inspector, paired with the table it targets. Hoisted into the
 *  context so the canvas overlay can draw the blue selection lines on
 *  the same edges the inspector is going to stamp — wires the
 *  inspector's "which edges am I editing?" affordance through to the
 *  table on the artboard.
 *
 *  The `tableId` is required even when there's no active cell/range:
 *  the inspector knows the target table (it's the selected object) and
 *  the overlay needs that to find the geometry to paint over. */
export interface ActiveBorderPresetState {
  preset: TableBorderPreset
  tableId: string
}

export interface TableEditContextValue {
  active: ActiveCell | null
  range: CellRange | null
  activeBorderPreset: ActiveBorderPresetState | null
  setActive: (cell: { tableId: string; r: number; c: number }) => void
  beginEdit: (cell?: { tableId: string; r: number; c: number }) => void
  endEdit: () => void
  setRange: (range: CellRange) => void
  clearRange: () => void
  clear: () => void
  setActiveBorderPreset: (value: ActiveBorderPresetState | null) => void
}

const TableEditContext = createContext<TableEditContextValue | null>(null)

export function TableEditProvider({ children }: { children: React.ReactNode }) {
  const [active, setActiveState] = useState<ActiveCell | null>(null)
  const [range, setRangeState] = useState<CellRange | null>(null)
  const [activeBorderPreset, setActiveBorderPresetState] = useState<ActiveBorderPresetState | null>(
    null,
  )

  const setActive = useCallback((cell: { tableId: string; r: number; c: number }) => {
    setActiveState({ tableId: cell.tableId, r: cell.r, c: cell.c, editing: false })
    setRangeState(null)
  }, [])

  const beginEdit = useCallback((cell?: { tableId: string; r: number; c: number }) => {
    setRangeState(null)
    setActiveState((prev) => {
      if (cell !== undefined) {
        return { tableId: cell.tableId, r: cell.r, c: cell.c, editing: true }
      }
      if (prev === null) return null
      return { ...prev, editing: true }
    })
  }, [])

  const endEdit = useCallback(() => {
    setActiveState((prev) => (prev === null ? null : { ...prev, editing: false }))
  }, [])

  const setRange = useCallback((next: CellRange) => {
    // Single-cell "range" collapses to active-only state — simplifies
    // every UI check (range !== null === "multi-cell selection").
    if (next.r0 === next.r1 && next.c0 === next.c1) {
      setRangeState(null)
      setActiveState({ tableId: next.tableId, r: next.r0, c: next.c0, editing: false })
      return
    }
    setRangeState(next)
    setActiveState({ tableId: next.tableId, r: next.r0, c: next.c0, editing: false })
  }, [])

  const clearRange = useCallback(() => setRangeState(null), [])

  const clear = useCallback(() => {
    setActiveState(null)
    setRangeState(null)
    setActiveBorderPresetState(null)
  }, [])

  const setActiveBorderPreset = useCallback(
    (value: ActiveBorderPresetState | null) => setActiveBorderPresetState(value),
    [],
  )

  const value = useMemo(
    () => ({
      active,
      range,
      activeBorderPreset,
      setActive,
      beginEdit,
      endEdit,
      setRange,
      clearRange,
      clear,
      setActiveBorderPreset,
    }),
    [
      active,
      range,
      activeBorderPreset,
      setActive,
      beginEdit,
      endEdit,
      setRange,
      clearRange,
      clear,
      setActiveBorderPreset,
    ],
  )

  return <TableEditContext value={value}>{children}</TableEditContext>
}

export function useTableEdit(): TableEditContextValue {
  const ctx = useContext(TableEditContext)
  if (ctx === null) throw new Error('useTableEdit: missing TableEditProvider')
  return ctx
}

export function useTableEditOptional(): TableEditContextValue | null {
  return useContext(TableEditContext)
}
