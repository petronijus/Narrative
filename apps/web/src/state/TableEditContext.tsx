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

export interface TableEditContextValue {
  active: ActiveCell | null
  range: CellRange | null
  setActive: (cell: { tableId: string; r: number; c: number }) => void
  beginEdit: (cell?: { tableId: string; r: number; c: number }) => void
  endEdit: () => void
  setRange: (range: CellRange) => void
  clearRange: () => void
  clear: () => void
}

const TableEditContext = createContext<TableEditContextValue | null>(null)

export function TableEditProvider({ children }: { children: React.ReactNode }) {
  const [active, setActiveState] = useState<ActiveCell | null>(null)
  const [range, setRangeState] = useState<CellRange | null>(null)

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
  }, [])

  const value = useMemo(
    () => ({ active, range, setActive, beginEdit, endEdit, setRange, clearRange, clear }),
    [active, range, setActive, beginEdit, endEdit, setRange, clearRange, clear],
  )

  return <TableEditContext.Provider value={value}>{children}</TableEditContext.Provider>
}

export function useTableEdit(): TableEditContextValue {
  const ctx = useContext(TableEditContext)
  if (ctx === null) throw new Error('useTableEdit: missing TableEditProvider')
  return ctx
}

export function useTableEditOptional(): TableEditContextValue | null {
  return useContext(TableEditContext)
}
