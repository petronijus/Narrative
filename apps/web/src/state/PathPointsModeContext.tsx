/**
 * state/PathPointsModeContext.tsx
 *
 * Tracks which PathObject is currently in point-edit mode, if any. One at
 * a time — entering on a second path exits the first. Mirrors CropMode's
 * shape (ephemeral, not persisted to Y.Doc).
 */

import { createContext, useCallback, useContext, useState } from 'react'

export interface PathPointsModeApi {
  pathPointsId: string | null
  enterPathPoints: (id: string) => void
  exitPathPoints: () => void
}

const PathPointsModeContext = createContext<PathPointsModeApi | null>(null)

export function PathPointsModeProvider({ children }: { children: React.ReactNode }) {
  const [pathPointsId, setPathPointsId] = useState<string | null>(null)
  const enterPathPoints = useCallback((id: string) => setPathPointsId(id), [])
  const exitPathPoints = useCallback(() => setPathPointsId(null), [])
  return (
    <PathPointsModeContext value={{ pathPointsId, enterPathPoints, exitPathPoints }}>
      {children}
    </PathPointsModeContext>
  )
}

export function usePathPointsMode(): PathPointsModeApi {
  const ctx = useContext(PathPointsModeContext)
  if (ctx === null) throw new Error('usePathPointsMode: missing PathPointsModeProvider')
  return ctx
}
