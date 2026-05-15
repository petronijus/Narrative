/**
 * state/TableEditContext.tsx
 *
 * M29 Phase 2 — active-cell state for the first-class TableObject.
 *
 * Tracks which cell of which table the user is currently working on:
 *   - `{ tableId, r, c, editing: false }` — cell is the *active* cell
 *     (single click after table selection): inspector targets it, but
 *     no contenteditable overlay is mounted.
 *   - `{ tableId, r, c, editing: true }` — cell is being edited (double
 *     click): TableCellEditor overlay mounts and binds to Y.Text.
 *
 * Separate from `TextEditContext` because they coexist (you can have a
 * text object's text overlay open while a *different* table cell is
 * marked active, though only one can be in edit mode at a time and the
 * overlay components mutually-exclude via their mount conditions).
 *
 * Not persisted to Y.Doc — purely ephemeral editor chrome state.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react'

export interface ActiveCell {
  tableId: string
  r: number
  c: number
  /** True when the contenteditable overlay should mount over this cell. */
  editing: boolean
}

export interface TableEditContextValue {
  /** The cell that the inspector + keyboard nav act on, or null. */
  active: ActiveCell | null
  /** Select a cell without opening the editor (single click). */
  setActive: (cell: { tableId: string; r: number; c: number }) => void
  /** Enter edit mode on the currently-active cell, or specify a new target. */
  beginEdit: (cell?: { tableId: string; r: number; c: number }) => void
  /** Exit edit mode but keep the cell active (Escape, blur). */
  endEdit: () => void
  /** Forget the cell entirely (selection moved off the table). */
  clear: () => void
}

const TableEditContext = createContext<TableEditContextValue | null>(null)

export function TableEditProvider({ children }: { children: React.ReactNode }) {
  const [active, setActiveState] = useState<ActiveCell | null>(null)

  const setActive = useCallback((cell: { tableId: string; r: number; c: number }) => {
    setActiveState({ tableId: cell.tableId, r: cell.r, c: cell.c, editing: false })
  }, [])

  const beginEdit = useCallback((cell?: { tableId: string; r: number; c: number }) => {
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

  const clear = useCallback(() => setActiveState(null), [])

  const value = useMemo(
    () => ({ active, setActive, beginEdit, endEdit, clear }),
    [active, setActive, beginEdit, endEdit, clear],
  )

  return <TableEditContext.Provider value={value}>{children}</TableEditContext.Provider>
}

export function useTableEdit(): TableEditContextValue {
  const ctx = useContext(TableEditContext)
  if (ctx === null) throw new Error('useTableEdit: missing TableEditProvider')
  return ctx
}

/**
 * Read-only variant that returns `null` outside a provider — used by
 * inspector widgets that may render outside the editor tree (thumbnail
 * preview, present mode) where the provider doesn't exist.
 */
export function useTableEditOptional(): TableEditContextValue | null {
  return useContext(TableEditContext)
}
