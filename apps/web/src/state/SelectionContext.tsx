/**
 * state/SelectionContext.tsx
 *
 * Ephemeral React context pro single-object selection.
 * NEUKLÁDÁ se do Y.Doc — awareness příde v M8.
 *
 * M2: single selection.
 * M7: multi-select.
 */

import { createContext, useCallback, useContext, useState } from 'react'

interface SelectionContextValue {
  selectedId: string | null
  setSelectedId: (id: string) => void
  clearSelection: () => void
}

const SelectionContext = createContext<SelectionContextValue | null>(null)

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [selectedId, setSelectedIdState] = useState<string | null>(null)

  const setSelectedId = useCallback((id: string) => {
    setSelectedIdState(id)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIdState(null)
  }, [])

  return (
    <SelectionContext.Provider value={{ selectedId, setSelectedId, clearSelection }}>
      {children}
    </SelectionContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext)
  if (ctx === null) {
    throw new Error('useSelection must be used within SelectionProvider')
  }
  return ctx
}
