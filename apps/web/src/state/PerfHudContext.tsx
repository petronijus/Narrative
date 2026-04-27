/**
 * state/PerfHudContext.tsx
 *
 * P12: tiny context that drives the in-editor performance HUD.
 *
 * The HUD itself is intentionally cheap (one rAF sampler, one tiny
 * absolutely-positioned <div>) so leaving it on during a slow scrub
 * doesn't itself become the perf problem we're trying to measure.
 * Off by default; toggle persists in localStorage so a recurring
 * "is this scrub still 60fps?" check survives reloads.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

const STORAGE_KEY = 'narrative:perf-hud'

interface PerfHudContextValue {
  enabled: boolean
  toggle(): void
  setEnabled(next: boolean): void
}

const PerfHudContext = createContext<PerfHudContextValue | null>(null)

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function PerfHudProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState<boolean>(() => readStored())

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }, [enabled])

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next)
  }, [])

  const toggle = useCallback(() => {
    setEnabledState((prev) => !prev)
  }, [])

  const value = useMemo<PerfHudContextValue>(
    () => ({ enabled, toggle, setEnabled }),
    [enabled, toggle, setEnabled],
  )

  return <PerfHudContext.Provider value={value}>{children}</PerfHudContext.Provider>
}

export function usePerfHud(): PerfHudContextValue {
  const ctx = useContext(PerfHudContext)
  if (ctx === null) {
    throw new Error('usePerfHud must be used within <PerfHudProvider>')
  }
  return ctx
}
