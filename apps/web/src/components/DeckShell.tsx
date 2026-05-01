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
 *
 * M16 P2: FolderDocProvider wraps children inside DeckRoleProvider so the
 *   design-token Y.Doc for the deck's folder is available to all editor children.
 *   FolderDocGate reads folderId from DeckRoleContext (set after the deck list fetch)
 *   and opens the folder Hocuspocus doc once folderId is known.
 *   TokensProvider is mounted inside FolderDocGate to expose a synchronous
 *   colour resolver to the renderer tree.
 */

import { useState, useCallback, useLayoutEffect, useEffect } from 'react'
import { markDeckLoadStart } from '../state/loadTimings.js'
import { useParams, Navigate, Outlet } from 'react-router-dom'
import { SlideDocProvider } from '../state/SlideDocProvider.js'
import { ActiveSlideProvider } from '../state/ActiveSlideContext.js'
import { CanvasInstanceContext } from '../renderer/CanvasInstanceContext.js'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { DeckRoleProvider, useDeckRole } from '../state/DeckRoleContext.js'
import { MediaUploadProvider } from '../state/useMediaUpload.js'
import { RulersProvider } from '../state/RulersContext.js'
import { FolderDocProvider, useFolderTokens } from '../state/FolderDocProvider.js'
import { FolderFontsProvider } from '../state/useFolderFonts.js'
import { FolderFontLoader } from '../state/FolderFontLoader.js'
import { TokensProvider, useTokensResolve } from '../state/TokensContext.js'
import { setColourResolver } from '../renderer/colourResolver.js'

export interface DeckShellContextValue {
  /**
   * Callback pro Canvas.tsx — volá se po Pixi inicializaci a při unmount (null).
   * Null cleanup signal je důležitý pro edit ↔ present navigaci: bez něj by
   * canvasInstance state držel referenci na zničený SceneGraph během remount okna.
   */
  onCanvasReady: (instance: CanvasInstance | null) => void
}

// ---------------------------------------------------------------------------
// Inner gate — reads folderId from DeckRoleContext (already inside DeckRoleProvider)
// ---------------------------------------------------------------------------

interface FolderDocGateProps {
  children: React.ReactNode
}

/**
 * Renders children inside FolderDocProvider once folderId is known.
 * While folderId is null (loading), renders children without a folder doc.
 * This avoids a visual loading gate — the editor mounts immediately and
 * gains token resolution once the folder doc syncs.
 */
function FolderDocGate({ children }: FolderDocGateProps) {
  const { folderId } = useDeckRole()

  if (!folderId) {
    // No folderId yet — render with a null tokens snapshot (TokensProvider
    // falls back to literal hex conversion).
    return (
      <TokensProvider tokens={null}>
        <ColourResolverInstaller />
        {children}
      </TokensProvider>
    )
  }

  return (
    <FolderFontsProvider folderId={folderId}>
      <FolderFontLoader />
      <FolderDocProvider folderId={folderId}>
        <FolderTokensBridge>{children}</FolderTokensBridge>
      </FolderDocProvider>
    </FolderFontsProvider>
  )
}

/**
 * Reads the live token snapshot from FolderDocProvider and passes it to
 * TokensProvider.  Separate component so it sits inside FolderDocProvider.
 */
function FolderTokensBridge({ children }: { children: React.ReactNode }) {
  const tokens = useFolderTokens()
  return (
    <TokensProvider tokens={tokens}>
      <ColourResolverInstaller />
      {children}
    </TokensProvider>
  )
}

/**
 * Installs the React-side token colour resolver into the module-level
 * singleton in colourResolver.ts so the Pixi object renderers can call
 * resolveColour() synchronously without going through React hooks.
 *
 * Must sit inside <TokensProvider> so useTokensResolve() is available.
 * Uninstalls on unmount (setColourResolver(null)).
 */
function ColourResolverInstaller() {
  const resolve = useTokensResolve()
  useEffect(() => {
    setColourResolver(resolve)
    return () => {
      setColourResolver(null)
    }
  }, [resolve])
  return null
}

// ---------------------------------------------------------------------------
// DeckShell
// ---------------------------------------------------------------------------

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
        <FolderDocGate>
          <SlideDocProvider deckId={id}>
            <ActiveSlideProvider>
              <MediaUploadProvider deckId={id}>
                <RulersProvider>
                  <CanvasInstanceContext.Provider value={canvasInstance}>
                    <Outlet
                      context={{ onCanvasReady: handleCanvasReady } satisfies DeckShellContextValue}
                    />
                  </CanvasInstanceContext.Provider>
                </RulersProvider>
              </MediaUploadProvider>
            </ActiveSlideProvider>
          </SlideDocProvider>
        </FolderDocGate>
      </DeckRoleProvider>
    </div>
  )
}
