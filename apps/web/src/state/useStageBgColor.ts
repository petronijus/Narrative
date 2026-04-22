/**
 * state/useStageBgColor.ts
 *
 * P2: local editor preference for the stage backdrop colour (the area
 * around the artboard). This is a per-viewer display choice — NOT
 * synced via Y.Doc AND NOT shared across browser tabs either, because
 * two tabs often represent two independent "users" when we're testing
 * multiplayer. We therefore use `sessionStorage` (per-tab), so the
 * value persists across reloads of the same tab but never leaks to
 * other tabs or other users.
 *
 * State is shared across all consumers within a single tab via a tiny
 * pub-sub so that e.g. the picker and the EditorLayout backdrop both
 * react to the same current value. `null` means "use the themed
 * default" (`.canvas-backdrop` CSS rule).
 */

import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'narrative:stage-bg-color'

type Listener = (next: string | null) => void
const listeners = new Set<Listener>()

function readStored(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const v = window.sessionStorage.getItem(STORAGE_KEY)
    return v === null || v === '' ? null : v
  } catch {
    return null
  }
}

function writeStored(next: string | null): void {
  try {
    if (next === null) {
      window.sessionStorage.removeItem(STORAGE_KEY)
    } else {
      window.sessionStorage.setItem(STORAGE_KEY, next)
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
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const setColor = useCallback((next: string | null) => {
    writeStored(next)
    for (const listener of listeners) listener(next)
  }, [])

  return { color, setColor }
}
