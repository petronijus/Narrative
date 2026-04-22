/**
 * state/useStageBgColor.ts
 *
 * P2: local editor preference for the stage backdrop colour (the area
 * around the artboard). Persisted to localStorage — NOT synced via Y.Doc,
 * because it's a per-viewer display choice, not deck content.
 *
 * The default value `null` means "use the themed default" (`.canvas-backdrop`
 * CSS rule). Any string is treated as a CSS colour and applied inline.
 */

import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'narrative:stage-bg-color'

function readStored(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    return v === null || v === '' ? null : v
  } catch {
    return null
  }
}

export function useStageBgColor(): {
  color: string | null
  setColor: (next: string | null) => void
} {
  const [color, setColorState] = useState<string | null>(() => readStored())

  useEffect(() => {
    // Cross-tab sync — refresh if user changes on another tab
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return
      setColorState(e.newValue === null || e.newValue === '' ? null : e.newValue)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setColor = useCallback((next: string | null) => {
    setColorState(next)
    try {
      if (next === null) {
        window.localStorage.removeItem(STORAGE_KEY)
      } else {
        window.localStorage.setItem(STORAGE_KEY, next)
      }
    } catch {
      // Storage disabled — in-memory state still holds.
    }
  }, [])

  return { color, setColor }
}
