/**
 * state/SelectionContext.tsx
 *
 * Ephemeral React context pro multi-object selection.
 * NEUKLÁDÁ se do Y.Doc — awareness příde v M8.
 *
 * M2: single selection.
 * M7: multi-select — ReadonlySet<string>, shift-click, marquee.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

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
  }, [])

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds])

  // Backward-compat helper
  const selectedId: string | null =
    selectedIds.size === 1 ? (selectedIds.values().next().value ?? null) : null

  // Memoize the context value so consumers don't re-render when SelectionProvider's
  // parent re-renders for unrelated reasons. All callbacks are stable refs already
  // (useCallback with [] deps); the value reference flips only when one of the
  // tracked pieces of state actually changes.
  const value = useMemo<SelectionContextValue>(
    () => ({
      selectedIds,
      selectedId,
      isSelected,
      selectOne,
      selectMany,
      toggle,
      clear,
      selectedAnimationId,
      setSelectedAnimationId,
      // Backward-compat aliasy
      setSelectedId: selectOne,
      clearSelection: clear,
    }),
    [
      selectedIds,
      selectedId,
      isSelected,
      selectOne,
      selectMany,
      toggle,
      clear,
      selectedAnimationId,
    ],
  )

  return <SelectionContext value={value}>{children}</SelectionContext>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext)
  if (ctx === null) {
    throw new Error('useSelection must be used within SelectionProvider')
  }
  return ctx
}
