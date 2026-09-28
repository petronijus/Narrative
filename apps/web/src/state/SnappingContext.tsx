/**
 * state/SnappingContext.tsx
 *
 * Editor preference: do drags and resizes snap to other objects and to
 * the deck's alignment guides? Default on. The toolbar's toggle writes
 * it; the drag paths (EditorLayout, TransformHandles) read it and invert
 * it for as long as the platform modifier (⌘ / Ctrl) is held — see
 * `snapsThisFrame` in editor/snap.ts.
 *
 * Persisted to localStorage: switching snapping off is a deliberate,
 * lasting choice (unlike rulers, which are a per-session view toggle),
 * and the pressed toolbar button keeps the state visible.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

const STORAGE_KEY = 'narrative:snapping:enabled'

interface SnappingContextValue {
  enabled: boolean
  toggle: () => void
  setEnabled: (v: boolean) => void
}

const SnappingContext = createContext<SnappingContextValue | null>(null)

export function SnappingProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== '0'
    } catch {
      return true
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }, [enabled])

  return (
    <SnappingContext value={{ enabled, toggle: () => setEnabled((v) => !v), setEnabled }}>
      {children}
    </SnappingContext>
  )
}

export function useSnapping(): SnappingContextValue {
  const ctx = useContext(SnappingContext)
  if (ctx === null) {
    // Outside the editor shell (tests, isolated renders) snapping keeps
    // its default: on.
    return {
      enabled: true,
      toggle: () => {},
      setEnabled: () => {},
    }
  }
  return ctx
}
