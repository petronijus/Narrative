/**
 * state/SelectionContext.tsx
 *
 * Ephemeral React context pro multi-object selection.
 * NEUKLÁDÁ se do Y.Doc — awareness příde v M8.
 *
 * M2: single selection.
 * M7: multi-select — ReadonlySet<string>, shift-click, marquee.
 */

import { createContext, useCallback, useContext, useState } from 'react'

export interface SelectionContextValue {
  selectedIds: ReadonlySet<string>
  /** Backward-compat: vrátí null pokud 0 nebo >1 selected, jinak jediné ID. */
  selectedId: string | null
  isSelected: (id: string) => boolean
  /** Nahradí selection jedním objektem. */
  selectOne: (id: string) => void
  /** Nahradí selection danou sadou. */
  selectMany: (ids: string[]) => void
  /** Přidá/odebere objekt ze selection (shift-click). */
  toggle: (id: string) => void
  /** Vyprázdní selection. */
  clear: () => void
  // Backward-compat aliasy (M2 callsites)
  /** @deprecated Použij selectOne(). */
  setSelectedId: (id: string) => void
  /** @deprecated Použij clear(). */
  clearSelection: () => void
}

const SelectionContext = createContext<SelectionContextValue | null>(null)

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())

  const selectOne = useCallback((id: string) => {
    setSelectedIds(new Set([id]))
  }, [])

  const selectMany = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids))
  }, [])

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const clear = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds])

  // Backward-compat helper
  const selectedId: string | null =
    selectedIds.size === 1 ? (selectedIds.values().next().value ?? null) : null

  const value: SelectionContextValue = {
    selectedIds,
    selectedId,
    isSelected,
    selectOne,
    selectMany,
    toggle,
    clear,
    // Backward-compat aliasy
    setSelectedId: selectOne,
    clearSelection: clear,
  }

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext)
  if (ctx === null) {
    throw new Error('useSelection must be used within SelectionProvider')
  }
  return ctx
}
