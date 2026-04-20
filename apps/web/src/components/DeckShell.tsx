/**
 * components/DeckShell.tsx
 *
 * M5: Shared layout wrapper pro /deck/:id a /deck/:id/present routes.
 *
 * Účel: vyhoupnout SlideDocProvider nad obě routes tak, aby Y.Doc + WebSocket
 * connection přežily navigaci editor ↔ present mode bez reconnect.
 *
 * Pattern:
 *   <Route path="/deck/:id" element={<DeckShell />}>
 *     <Route index element={<DeckEditor />} />
 *     <Route path="present" element={<DeckPresent />} />
 *   </Route>
 *
 * DeckEditor a DeckPresent dědí Y.Doc přes SlideDocContext — žádný reconnect
 * při navigaci mezi těmito dvěma child routes.
 *
 * M6: Přidán CanvasInstanceContext.Provider (varianta B — state lifting).
 * Canvas.tsx volá onReady(instance) po Pixi init → DeckShell uloží do state →
 * context je dostupný pro PresentLayout + EditorLayout bez přímé závislosti na Canvas.
 *
 * M10: DeckRoleProvider added to expose per-deck role to all child components.
 *
 * M11: MediaUploadProvider added for tus resumable uploads.
 *      Scoped to editor routes only (DeckShell excludes PresentLayout from uploads
 *      via role gating + component-level guards, but the provider is present in both
 *      child routes for simplicity — upload state is simply unused in present mode).
 */

import { useState, useCallback } from 'react'
import { useParams, Navigate, Outlet } from 'react-router-dom'
import { SlideDocProvider } from '../state/SlideDocProvider.js'
import { ActiveSlideProvider } from '../state/ActiveSlideContext.js'
import { CanvasInstanceContext } from '../renderer/CanvasInstanceContext.js'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { DeckRoleProvider } from '../state/DeckRoleContext.js'
import { MediaUploadProvider } from '../state/useMediaUpload.js'

export interface DeckShellContextValue {
  /**
   * Callback pro Canvas.tsx — volá se po Pixi inicializaci.
   * DeckShell drží instanci ve state a pasuje ji do CanvasInstanceContext.
   */
  onCanvasReady: (instance: CanvasInstance) => void
}

export function DeckShell() {
  const { id } = useParams<{ id: string }>()
  const [canvasInstance, setCanvasInstance] = useState<CanvasInstance | null>(null)

  const handleCanvasReady = useCallback((instance: CanvasInstance) => {
    setCanvasInstance(instance)
  }, [])

  if (id === undefined || id === '') {
    return <Navigate to="/" replace />
  }

  return (
    <div className="h-screen w-screen overflow-hidden">
      <DeckRoleProvider deckId={id}>
        <SlideDocProvider deckId={id}>
          <ActiveSlideProvider>
            <MediaUploadProvider deckId={id}>
              <CanvasInstanceContext.Provider value={canvasInstance}>
                <Outlet
                  context={{ onCanvasReady: handleCanvasReady } satisfies DeckShellContextValue}
                />
              </CanvasInstanceContext.Provider>
            </MediaUploadProvider>
          </ActiveSlideProvider>
        </SlideDocProvider>
      </DeckRoleProvider>
    </div>
  )
}
