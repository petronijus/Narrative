/**
 * pages/ComponentMasterEditor.tsx
 *
 * M16 P-flatten — full-editor master view.
 *
 * The master Y.Doc is slide-shaped (one synthetic slide id='master'
 * seeded by writeComponentMasterTree), so we mount the same
 * `<EditorLayout masterMode>` the deck path uses. Slides panel is
 * hidden, slide creation is impossible (the only entry point lives
 * inside SlidesPanel). Toolbar, inspector, transforms, animations,
 * undo, peer cursors etc. are shared with the deck path 1:1.
 *
 * Lifecycle is unchanged from the previous shell-based version: the
 * route acquires one ref into componentDocCache on mount, polls for
 * sync, and releases on unmount. No second Y.Doc is ever created
 * here — the renderer's componentInstance nodes share the same
 * cache so single-source-of-truth holds.
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import type * as Y from 'yjs'
import { useApi } from '../api/client.js'
import { useSlideThumbnails } from '../state/useSlideThumbnails.js'
import {
  acquireComponentDoc,
  releaseComponentDoc,
  getComponentDoc,
  getComponentDocSyncStatus,
} from '../state/componentDocCache.js'
import { SlideDocProvider } from '../state/SlideDocProvider.js'
import { ActiveSlideProvider } from '../state/ActiveSlideContext.js'
import { SelectionProvider } from '../state/SelectionContext.js'
import { ToolProvider } from '../state/ToolContext.js'
import { TextEditProvider } from '../state/TextEditContext.js'
import { TableEditProvider } from '../state/TableEditContext.js'
import { CropModeProvider } from '../state/CropModeContext.js'
import { PathPointsModeProvider } from '../state/PathPointsModeContext.js'
import { RulersProvider } from '../state/RulersContext.js'
import { CanvasInstanceContext } from '../renderer/CanvasInstanceContext.js'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { EditorLayout } from '../components/EditorLayout.js'
import { DeckRoleStaticProvider } from '../state/DeckRoleContext.js'
import { MediaUploadProvider } from '../state/useMediaUpload.js'
import { FolderDocProvider } from '../state/FolderDocProvider.js'

export function ComponentMasterEditor() {
  const { folderId, componentId } = useParams<{ folderId: string; componentId: string }>()
  const [synced, setSynced] = useState(false)
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [canvasInstance, setCanvasInstance] = useState<CanvasInstance | null>(null)

  const handleCanvasReady = useCallback((instance: CanvasInstance | null) => {
    setCanvasInstance(instance)
  }, [])

  useEffect(() => {
    if (componentId === undefined || componentId === '') return
    acquireComponentDoc(componentId)

    const checkSynced = (): boolean => {
      const d = getComponentDoc(componentId)
      const status = getComponentDocSyncStatus(componentId)
      if (d !== null && status === 'synced') {
        setDoc(d)
        setSynced(true)
        return true
      }
      return false
    }

    if (checkSynced()) {
      return () => {
        releaseComponentDoc(componentId)
      }
    }

    const interval = window.setInterval(() => {
      if (checkSynced()) window.clearInterval(interval)
    }, 50)

    return () => {
      window.clearInterval(interval)
      releaseComponentDoc(componentId)
    }
  }, [componentId])

  if (folderId === undefined || componentId === undefined) {
    return <div className="p-8 text-sm text-destructive">Invalid route.</div>
  }

  if (!synced || doc === null) {
    return <LoadingState />
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      <DeckRoleStaticProvider role="owner" folderId={folderId}>
        <FolderDocProvider folderId={folderId}>
          <MediaUploadProvider deckId={`component:${componentId}`}>
            <SlideDocProvider deckId={`component:${componentId}`} doc={doc}>
              <ActiveSlideProvider>
                <SelectionProvider>
                  <ToolProvider>
                    <TextEditProvider>
                      <TableEditProvider>
                        <CropModeProvider>
                          <PathPointsModeProvider>
                            <RulersProvider>
                              <CanvasInstanceContext value={canvasInstance}>
                                <EditorLayout masterMode onCanvasReady={handleCanvasReady} />
                                <ComponentThumbnailUploader componentId={componentId} />
                              </CanvasInstanceContext>
                            </RulersProvider>
                          </PathPointsModeProvider>
                        </CropModeProvider>
                      </TableEditProvider>
                    </TextEditProvider>
                  </ToolProvider>
                </SelectionProvider>
              </ActiveSlideProvider>
            </SlideDocProvider>
          </MediaUploadProvider>
        </FolderDocProvider>
      </DeckRoleStaticProvider>
    </div>
  )
}

/**
 * Renders the synthetic 'master' slide of the component doc into a thumbnail
 * via the same Pixi pipeline used by the deck SlidesPanel, then PUTs it to
 * `/components/:id/thumbnail` on a trailing-edge debounce. Mirrors the
 * SlidesPanel deck-thumbnail flow 1:1 (debounce ref survives effect cleanup,
 * dedupe by exact dataUrl).
 *
 * Mounted INSIDE SlideDocProvider — useSlideThumbnails reads the deck ctx.
 */
function ComponentThumbnailUploader({ componentId }: { componentId: string }) {
  const thumbnailMap = useSlideThumbnails(['master'])
  const masterThumb = thumbnailMap.get('master')
  const api = useApi()

  const lastUploadedRef = useRef<string | null>(null)
  const pendingRef = useRef<string | null>(null)
  const flushTimerRef = useRef<number | null>(null)
  const apiRef = useRef(api)
  apiRef.current = api

  useEffect(() => {
    if (masterThumb === undefined) return
    if (lastUploadedRef.current === masterThumb) return
    pendingRef.current = masterThumb
    if (flushTimerRef.current !== null) return
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null
      const thumb = pendingRef.current
      if (thumb === null) return
      if (lastUploadedRef.current === thumb) return
      lastUploadedRef.current = thumb
      pendingRef.current = null
      apiRef.current.uploadComponentThumbnail(componentId, thumb).catch((err: unknown) => {
        // Non-fatal — drop the marker so a future render can retry.
        lastUploadedRef.current = null
        console.warn('[component-thumb] PUT failed', err)
      })
    }, 1500)
  }, [componentId, masterThumb])

  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
    }
  }, [])

  return null
}

function LoadingState() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span>Loading component…</span>
      </div>
    </div>
  )
}
