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
 * M6: Přidán CanvasInstanceContext  (varianta B — state lifting).
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
 *   and passes it down; the providers stay mounted from the first render and
 *   open the folder Hocuspocus doc once folderId turns non-null.
 *   FolderTokensBridge (TokensProvider + the renderer's colour resolver) is
 *   mounted inside FolderDocGate so the canvas resolves token colours.
 *
 * A2.12: a folder text-style change reaches the linked text of every deck
 *   on the server (apps/server services/tokens.ts); the open deck receives
 *   it as a remote update. The TextStylePropagator that did it here — only
 *   in decks someone had open — is gone.
 */

import { useState, useCallback, useLayoutEffect } from 'react'
import { markDeckLoadStart } from '../state/loadTimings.js'
import { useParams, useMatch, useLocation, Navigate, Outlet } from 'react-router-dom'
import { shareTokenFrom } from '../state/hocuspocusAuth.js'
import { SlideDocProvider } from '../state/SlideDocProvider.js'
import { useFrozenRenderDoc } from '../state/frozenRenderDoc.js'
import { ActiveSlideProvider } from '../state/ActiveSlideContext.js'
import { CanvasInstanceContext } from '../renderer/CanvasInstanceContext.js'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { DeckRoleProvider, useDeckRole } from '../state/DeckRoleContext.js'
import { MediaUploadProvider } from '../state/useMediaUpload.js'
import { RulersProvider } from '../state/RulersContext.js'
import { SnappingProvider } from '../state/SnappingContext.js'
import { FolderDocProvider } from '../state/FolderDocProvider.js'
import { FolderFontsProvider } from '../state/useFolderFonts.js'
import { FolderFontLoader } from '../state/FolderFontLoader.js'
import { DeckFontsProvider } from '../state/useDeckFonts.js'
import { DeckTokensBridge, FolderTokensBridge } from './FolderTokensBridge.js'

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
 * Renders children inside the folder-scoped providers.
 *
 * `folderId` is null for the first few hundred milliseconds of a deck
 * open — it arrives with the deck-role fetch. The element tree here must
 * NOT change shape when it flips: this gate sits directly above
 * SlideDocProvider, the Pixi canvas and the slides panel, so swapping the
 * wrapper components out makes React unmount and rebuild the whole
 * editor. That was visible as the slide sidebar populating, blanking and
 * re-populating mid-load (plus a second deck Y.Doc WebSocket and a
 * duplicate deck fetch).
 *
 * So the providers are always mounted and take `folderId: string | null`
 * themselves: with a null id they hold an empty font list and the
 * empty-token placeholder snapshot, which resolves colours exactly like
 * the old `tokens={null}` branch did.
 */
export function FolderDocGate({ children }: FolderDocGateProps) {
  const { folderId } = useDeckRole()

  return (
    <FolderFontsProvider folderId={folderId}>
      <FolderFontLoader />
      <FolderDocProvider folderId={folderId}>
        {/* The deck's own bridge installs the renderer's resolver, with its variant. */}
        <FolderTokensBridge installResolver={false}>{children}</FolderTokensBridge>
      </FolderDocProvider>
    </FolderFontsProvider>
  )
}

// ---------------------------------------------------------------------------
// DeckShell
// ---------------------------------------------------------------------------

// (removed) ComponentDeleteCascadeEffect — components are now stamps,
// so deleting a master never needs to remove "instances" from decks
// (there are no instances). Stamped primitives stay on the slide.

export function DeckShell() {
  const { id } = useParams<{ id: string }>()
  const [canvasInstance, setCanvasInstance] = useState<CanvasInstance | null>(null)
  // The render page (/deck/:id/render) shows the deck as the server holds
  // it: no seeded first slide. The render worker's browser, which opens it
  // with a render token, must not appear as a peer; a person opening the page
  // does, as in present mode.
  const isRender = useMatch('/deck/:id/render') !== null
  const { search } = useLocation()
  const shareToken = shareTokenFrom(search)
  const isRenderWorker = isRender && shareToken !== null && shareToken.startsWith('nrr_')
  // A frozen render page (a compare's "before"): the state the worker hands
  // it, no live document (state/frozenRenderDoc.ts).
  const frozen = isRender && new URLSearchParams(search).get('frozen') === '1'
  const frozenDoc = useFrozenRenderDoc(frozen)

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
        <DeckFontsProvider deckId={id}>
          <FolderDocGate>
            {frozen && frozenDoc === null ? null : (
              <SlideDocProvider
                deckId={id}
                presence={!isRenderWorker}
                hydrate={!isRender}
                {...(frozenDoc !== null ? { doc: frozenDoc } : {})}
              >
                <DeckTokensBridge>
                  <ActiveSlideProvider>
                    <MediaUploadProvider deckId={id}>
                      <RulersProvider>
                        <SnappingProvider>
                          <CanvasInstanceContext value={canvasInstance}>
                            <Outlet
                              context={
                                { onCanvasReady: handleCanvasReady } satisfies DeckShellContextValue
                              }
                            />
                          </CanvasInstanceContext>
                        </SnappingProvider>
                      </RulersProvider>
                    </MediaUploadProvider>
                  </ActiveSlideProvider>
                </DeckTokensBridge>
              </SlideDocProvider>
            )}
          </FolderDocGate>
        </DeckFontsProvider>
      </DeckRoleProvider>
    </div>
  )
}
