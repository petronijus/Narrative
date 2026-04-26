/**
 * state/CropModeContext.tsx
 *
 * P11 (Keynote-style image crop): tracks which image object is in
 * crop-edit mode, if any. One at a time — entering crop on a second
 * image exits the first. Not persisted to Y.Doc; purely ephemeral
 * editor chrome.
 */

import { createContext, useCallback, useContext, useState } from 'react'

export interface CropModeApi {
  cropImageId: string | null
  enterCrop: (id: string) => void
  exitCrop: () => void
}

const CropModeContext = createContext<CropModeApi | null>(null)

export function CropModeProvider({ children }: { children: React.ReactNode }) {
  const [cropImageId, setCropImageId] = useState<string | null>(null)
  const enterCrop = useCallback((id: string) => setCropImageId(id), [])
  const exitCrop = useCallback(() => setCropImageId(null), [])
  return (
    <CropModeContext.Provider value={{ cropImageId, enterCrop, exitCrop }}>
      {children}
    </CropModeContext.Provider>
  )
}

export function useCropMode(): CropModeApi {
  const ctx = useContext(CropModeContext)
  if (ctx === null) throw new Error('useCropMode: missing CropModeProvider')
  return ctx
}
