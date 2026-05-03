/**
 * state/SelectionContext.tsx
 *
 * Ephemeral React context pro multi-object selection.
 * NEUKLÁDÁ se do Y.Doc — awareness příde v M8.
 *
 * M2: single selection.
 * M7: multi-select — ReadonlySet<string>, shift-click, marquee.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react'

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
  /**
   * Currently selected animation step id (shared between AnimationTimeline
   * and the Inspector's Animations list). Setting it does NOT touch the
   * object selection — callers that want both should also call selectOne.
   */
  selectedAnimationId: string | null
  setSelectedAnimationId: React.Dispatch<React.SetStateAction<string | null>>

  // ---------------------------------------------------------------------------
  // M16 P8: instance edit mode
  // ---------------------------------------------------------------------------

  /**
   * When non-null, the user has double-clicked a ComponentInstance and is
   * editing one of its master leaves. The outer instance chrome switches to
   * a faded dashed border; clicks inside the instance pick leaves instead of
   * re-selecting the whole instance.
   */
  activeInstanceEditId: string | null
  /**
   * The master leaf id currently selected while in instance edit mode.
   * Null when no leaf is picked (user entered the instance but hasn't
   * clicked a child yet). This id is NOT present in the slide's objects
   * array — it's a phantom selection resolved from the master snapshot.
   */
  activeLeafId: string | null

  /**
   * Enter instance edit mode for the given ComponentInstance id.
   * Clears activeLeafId. Does NOT change the outer object selection
   * so the instance outer handles remain visible (faded) during editing.
   */
  enterInstanceEdit: (instanceId: string) => void
  /**
   * Exit instance edit mode. Clears both activeInstanceEditId and activeLeafId.
   */
  exitInstanceEdit: () => void
  /**
   * Select a leaf while in instance edit mode. Noop when
   * activeInstanceEditId is null.
   */
  selectLeaf: (leafId: string) => void
  /**
   * Clear the active leaf selection without exiting instance edit mode.
   * Use when the currently selected leaf disappears from the master
   * (e.g. a peer deleted it) but the instance itself is still alive.
   */
  clearLeaf: () => void

  // Backward-compat aliasy (M2 callsites)
  /** @deprecated Použij selectOne(). */
  setSelectedId: (id: string) => void
  /** @deprecated Použij clear(). */
  clearSelection: () => void
}

const SelectionContext = createContext<SelectionContextValue | null>(null)

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [selectedAnimationId, setSelectedAnimationId] = useState<string | null>(null)
  const [activeInstanceEditId, setActiveInstanceEditId] = useState<string | null>(null)
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null)

  // P6 E2E: write the current selection to a global snapshot so Playwright
  // specs can observe selection changes without walking React internals.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(
      window as unknown as {
        __narrative_selection_snapshot?: { selectedIds: string[] }
      }
    ).__narrative_selection_snapshot = { selectedIds: [...selectedIds] }
  }, [selectedIds])

  // P6 E2E: listen for a window event that lets specs programmatically
  // set the selection without having to hit-test via the canvas.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<{ ids: string[] }>).detail
      if (detail?.ids === undefined) return
      setSelectedIds(new Set(detail.ids))
    }
    window.addEventListener('narrative:test-set-selection', handler)
    return () => window.removeEventListener('narrative:test-set-selection', handler)
  }, [])

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
    // Exiting to empty selection also exits instance-edit mode.
    setActiveInstanceEditId(null)
    setActiveLeafId(null)
  }, [])

  const enterInstanceEdit = useCallback((instanceId: string) => {
    setActiveInstanceEditId(instanceId)
    setActiveLeafId(null)
  }, [])

  const exitInstanceEdit = useCallback(() => {
    setActiveInstanceEditId(null)
    setActiveLeafId(null)
  }, [])

  const selectLeaf = useCallback((leafId: string) => {
    setActiveLeafId(leafId)
  }, [])

  const clearLeaf = useCallback(() => {
    setActiveLeafId(null)
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
    selectedAnimationId,
    setSelectedAnimationId,
    activeInstanceEditId,
    activeLeafId,
    enterInstanceEdit,
    exitInstanceEdit,
    selectLeaf,
    clearLeaf,
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
