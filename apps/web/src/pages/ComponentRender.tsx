/**
 * pages/ComponentRender.tsx — `/folder/:folderId/component/:componentId/render`
 *
 * The render page of a component master (agentic A3.5): the render worker
 * draws the master's card here, as it draws a deck's on `/deck/:id/render`.
 * The page itself is DeckRender (same readiness signal, same hooks); this
 * shell gives it the master's providers instead of a deck's:
 *
 *   - the master's document from the component doc cache, connected with
 *     the page's `share_token` (a render token minted for this master, which
 *     the server admits read-only for it and its folder only) and with no
 *     awareness, so the worker's browser never shows up in the master
 *     editor as a peer;
 *   - its folder's role, fonts and tokens (FolderDocGate) — the folder in
 *     the URL only picks which ones to load; the server checks the token
 *     against the master's own folder;
 *   - no deck fonts: a master's faces are its folder's.
 *
 * A refused connection (an ended token) is reported as DeckRender reports a
 * refused deck: `access-refused`.
 */

import { useCallback, useEffect, useState } from 'react'
import { Outlet, useLocation, useParams } from 'react-router-dom'
import type * as Y from 'yjs'
import { FolderDocGate } from '../components/DeckShell.js'
import type { DeckShellContextValue } from '../components/DeckShell.js'
import { CanvasInstanceContext } from '../renderer/CanvasInstanceContext.js'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { ActiveSlideProvider } from '../state/ActiveSlideContext.js'
import {
  acquireComponentDoc,
  getComponentDoc,
  getComponentDocSyncStatus,
  releaseComponentDoc,
  subscribeToComponentDocStatus,
} from '../state/componentDocCache.js'
import { DeckRoleStaticProvider } from '../state/DeckRoleContext.js'
import { SlideDocProvider } from '../state/SlideDocProvider.js'

export function ComponentRenderShell() {
  const { folderId, componentId } = useParams<{ folderId: string; componentId: string }>()
  const { search } = useLocation()
  const [canvasInstance, setCanvasInstance] = useState<CanvasInstance | null>(null)
  const [master, setMaster] = useState<{ doc: Y.Doc; refused: boolean } | null>(null)

  const handleCanvasReady = useCallback((instance: CanvasInstance | null) => {
    setCanvasInstance(instance)
  }, [])

  useEffect(() => {
    if (componentId === undefined || componentId === '') return
    // The query string is read once: the token is the page's for its life.
    acquireComponentDoc(componentId, { search, presence: false })
    // Watched for the page's whole life (a page kept between jobs is refused
    // when its token ends, after it synced) — told by the cache, not polled.
    const check = (): void => {
      const status = getComponentDocSyncStatus(componentId)
      const doc = getComponentDoc(componentId)
      if (doc === null || status === 'pending') return
      const refused = status === 'refused'
      setMaster((current) =>
        current !== null && current.doc === doc && current.refused === refused
          ? current
          : { doc, refused },
      )
    }
    const unsubscribe = subscribeToComponentDocStatus(componentId, check)
    check()
    return () => {
      unsubscribe()
      releaseComponentDoc(componentId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the note on `search`
  }, [componentId])

  if (folderId === undefined || componentId === undefined || master === null) return null

  return (
    <div className="h-screen w-screen overflow-hidden">
      <DeckRoleStaticProvider role="viewer" folderId={folderId}>
        <FolderDocGate>
          <SlideDocProvider
            deckId={`component:${componentId}`}
            doc={master.doc}
            refused={master.refused}
            presence={false}
            hydrate={false}
          >
            <ActiveSlideProvider>
              <CanvasInstanceContext value={canvasInstance}>
                <Outlet
                  context={{ onCanvasReady: handleCanvasReady } satisfies DeckShellContextValue}
                />
              </CanvasInstanceContext>
            </ActiveSlideProvider>
          </SlideDocProvider>
        </FolderDocGate>
      </DeckRoleStaticProvider>
    </div>
  )
}
