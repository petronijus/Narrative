/**
 * state/ToolContext.tsx
 *
 * Ephemeral React context pro aktivní tool v toolbaru.
 * Neperzistuje — state žije jen v paměti.
 */

import { createContext, useCallback, useContext, useState } from 'react'
import type { SlideObjectType } from '@narrative/shared'

export type ActiveTool = 'select' | 'hand' | 'pen' | SlideObjectType

interface ToolContextValue {
  activeTool: ActiveTool
  setActiveTool: (tool: ActiveTool) => void
}

const ToolContext = createContext<ToolContextValue | null>(null)

export function ToolProvider({ children }: { children: React.ReactNode }) {
  const [activeTool, setActiveToolState] = useState<ActiveTool>('select')

  const setActiveTool = useCallback((tool: ActiveTool) => {
    setActiveToolState(tool)
  }, [])

  return <ToolContext value={{ activeTool, setActiveTool }}>{children}</ToolContext>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTool(): ToolContextValue {
  const ctx = useContext(ToolContext)
  if (ctx === null) {
    throw new Error('useTool must be used within ToolProvider')
  }
  return ctx
}
