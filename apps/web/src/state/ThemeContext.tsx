/**
 * state/ThemeContext.tsx
 *
 * Tri-state theme toggle: system | light | dark.
 *
 * - `system` (default): no override — CSS `prefers-color-scheme` drives
 *   the tokens. Updates automatically when the OS setting changes.
 * - `light` / `dark`: explicit override written to `<html data-theme>`.
 *
 * Persisted in `localStorage` under `narrative:theme` so the choice
 * survives reloads. Applied at module load time (inline `<script>` in
 * `index.html` would avoid the FOUC, but the difference is one frame
 * and users rarely notice; can harden later).
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

interface ThemeContextValue {
  mode: ThemeMode
  /** Resolved `light` or `dark` — `system` resolves via the OS. */
  resolved: 'light' | 'dark'
  setMode(mode: ThemeMode): void
  /** Cycle system → light → dark → system. */
  cycle(): void
}

const STORAGE_KEY = 'narrative:theme'

const ThemeContext = createContext<ThemeContextValue | null>(null)

function readStored(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* storage unavailable */
  }
  return 'system'
}

function mqlDark(): boolean {
  if (typeof window === 'undefined') return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function applyDomAttribute(mode: ThemeMode): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (mode === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', mode)
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStored())

  // Apply current mode to the DOM whenever it changes (and once at mount).
  useEffect(() => {
    applyDomAttribute(mode)
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      /* storage unavailable */
    }
  }, [mode])

  // Track OS preference so we can surface the "resolved" value when in
  // `system` mode. Other state doesn't depend on this, but the chip UI
  // wants to show whether the system is currently dark or light.
  const [osDark, setOsDark] = useState<boolean>(() => mqlDark())
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setOsDark(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  const value = useMemo<ThemeContextValue>(() => {
    const resolved: 'light' | 'dark' = mode === 'system' ? (osDark ? 'dark' : 'light') : mode
    return {
      mode,
      resolved,
      setMode: setModeState,
      cycle() {
        setModeState((prev) => (prev === 'system' ? 'light' : prev === 'light' ? 'dark' : 'system'))
      },
    }
  }, [mode, osDark])

  return <ThemeContext value={value}>{children}</ThemeContext>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (ctx === null) {
    throw new Error('useTheme must be used within <ThemeProvider>')
  }
  return ctx
}
