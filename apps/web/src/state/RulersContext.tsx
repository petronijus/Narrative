/**
 * state/RulersContext.tsx
 *
 * P11: shared visibility flag for the editor's ruler strips. Lives in
 * a context so the toolbar's toggle button + the EditorLayout's render
 * agree without prop drilling. Persisted to sessionStorage so the
 * preference survives a deck switch within the same browser session.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

const STORAGE_KEY = 'narrative:rulers:visible'

interface RulersContextValue {
  visible: boolean
  toggle: () => void
  setVisible: (v: boolean) => void
}

const RulersContext = createContext<RulersContextValue | null>(null)

export function RulersProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, visible ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }, [visible])

  return (
    <RulersContext.Provider value={{ visible, toggle: () => setVisible((v) => !v), setVisible }}>
      {children}
    </RulersContext.Provider>
  )
}

export function useRulers(): RulersContextValue {
  const ctx = useContext(RulersContext)
  if (ctx === null) {
    // Graceful default — if a consumer renders outside the provider
    // (e.g. tests without the editor shell), pretend rulers are off.
    return {
      visible: false,
      toggle: () => {},
      setVisible: () => {},
    }
  }
  return ctx
}
