/**
 * state/useStageBgColor.ts
 *
 * P2: local editor preference for the stage backdrop colour (the area
 * around the artboard). Persisted to localStorage — NOT synced via Y.Doc,
 * because it's a per-viewer display choice, not deck content.
 *
 * State is shared across all consumers via a tiny pub-sub so that e.g.
 * the picker and the EditorLayout backdrop both react to the same
 * current value without a React Context wrapper. `null` means "use the
 * themed default" (`.canvas-backdrop` CSS rule).
 */

import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'narrative:stage-bg-color'

type Listener = (next: string | null) => void
const listeners = new Set<Listener>()

function readStored(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    return v === null || v === '' ? null : v
  } catch {
    return null
  }
}

function writeStored(next: string | null): void {
  try {
    if (next === null) {
      window.localStorage.removeItem(STORAGE_KEY)
    } else {
      window.localStorage.setItem(STORAGE_KEY, next)
    }
  } catch {
    // Storage disabled — in-memory state still holds.
  }
}

export function useStageBgColor(): {
  color: string | null
  setColor: (next: string | null) => void
} {
  const [color, setColorState] = useState<string | null>(() => readStored())

  useEffect(() => {
    const listener: Listener = (next) => setColorState(next)
    listeners.add(listener)

    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return
      const next = e.newValue === null || e.newValue === '' ? null : e.newValue
      setColorState(next)
    }
    window.addEventListener('storage', onStorage)

    return () => {
      listeners.delete(listener)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setColor = useCallback((next: string | null) => {
    writeStored(next)
    for (const listener of listeners) listener(next)
  }, [])

  return { color, setColor }
}
