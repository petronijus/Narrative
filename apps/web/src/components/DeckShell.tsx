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

import { useState, useCallback, useLayoutEffect } from 'react'
import { markDeckLoadStart } from '../state/loadTimings.js'
import { useParams, Navigate, Outlet } from 'react-router-dom'
import { SlideDocProvider } from '../state/SlideDocProvider.js'
import { ActiveSlideProvider } from '../state/ActiveSlideContext.js'
import { CanvasInstanceContext } from '../renderer/CanvasInstanceContext.js'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { DeckRoleProvider } from '../state/DeckRoleContext.js'
import { MediaUploadProvider } from '../state/useMediaUpload.js'
import { RulersProvider } from '../state/RulersContext.js'
import { FontLoader } from '../state/FontLoader.js'

export interface DeckShellContextValue {
  /**
   * Callback pro Canvas.tsx — volá se po Pixi inicializaci a při unmount (null).
   * Null cleanup signal je důležitý pro edit ↔ present navigaci: bez něj by
   * canvasInstance state držel referenci na zničený SceneGraph během remount okna.
   */
  onCanvasReady: (instance: CanvasInstance | null) => void
}

export function DeckShell() {
  const { id } = useParams<{ id: string }>()
  const [canvasInstance, setCanvasInstance] = useState<CanvasInstance | null>(null)

  // P12d: stamp t0 for the perf HUD's load-time breakdown. Re-stamps
  // whenever the deckId changes so each navigation gets a fresh
  // ws → sync → pixi → paint timeline. Layout effect so we beat the
  // SlideDocProvider's own effect that creates the WS.
  useLayoutEffect(() => {
    if (id !== undefined && id !== '') {
      markDeckLoadStart()
    }
  }, [id])

  const handleCanvasReady = useCallback((instance: CanvasInstance | null) => {
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
              <RulersProvider>
                <CanvasInstanceContext.Provider value={canvasInstance}>
                  {/* P15: FontLoader needs BOTH the Y.Doc (deck fonts
                      array) and the live Pixi canvas instance, so it
                      mounts here — inside both providers — to bridge
                      deck-level FontFace install + Pixi text refresh
                      on first paint. */}
                  <FontLoader />
                  <Outlet
                    context={{ onCanvasReady: handleCanvasReady } satisfies DeckShellContextValue}
                  />
                </CanvasInstanceContext.Provider>
              </RulersProvider>
            </MediaUploadProvider>
          </ActiveSlideProvider>
        </SlideDocProvider>
      </DeckRoleProvider>
    </div>
  )
}
