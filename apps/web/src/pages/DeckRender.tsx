/**
 * pages/DeckRender.tsx — `/deck/:id/render?slide=<id | index>`
 *
 * The page the render worker screenshots (agentic A3,
 * docs/plans/a3-render-worker.md): one slide of the live deck on the real
 * renderer, 1920×1080 at the page's top-left, with no editor chrome. The
 * worker opens it with a render token as `share_token` (the deck's providers
 * and the media and font reads use it like a share-link visitor's); a
 * signed-in person can open it too.
 *
 * It reports on `window.__narrativeRender` and on `<html data-render-status>`:
 *   - `loading` until the deck document, the folder's tokens and font lists
 *     and the canvas are there and the slide is shown;
 *   - `ready` once the slide is settled (renderer/settleScene.ts: every object
 *     mounted, every load and font done, every text raster drawn) — the
 *     canvas then holds the final pixels; `settle.failedLoads` counts the
 *     loads that failed on the way (an asset that no longer exists paints its
 *     error mark, as in the editor);
 *   - `error` with a reason, never a guess: the server refused the deck, the
 *     deck has no slides, the slide does not exist, a font list could not be
 *     read, the inputs never came within `PAGE_TIMEOUT_MS` (it lists which),
 *     or the slide did not settle within `SETTLE_TIMEOUT_MS`.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext, useSearchParams } from 'react-router-dom'
import { listSlides } from '@narrative/slide-model'
import { Canvas } from '../renderer/Canvas.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from '../renderer/constants.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { getDefaultRenderScheduler } from '../renderer/RenderScheduler.js'
import { getRenderer } from '../renderer/objectRenderers/index.js'
import { settleScene, type SettleResult } from '../renderer/settleScene.js'
import { useSlides } from '../state/useSlides.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useSlideDoc } from '../state/useSlideDoc.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { useFolderFontsOptional } from '../state/useFolderFonts.js'
import { useDeckFonts } from '../state/useDeckFonts.js'
import { useFolderTokensSettled } from '../state/FolderDocProvider.js'
import type { DeckShellContextValue } from '../components/DeckShell.js'
import { resolveRenderSlide } from './renderSlide.js'

/** Everything the paint depends on must be there by then, counted from the page's mount. */
const PAGE_TIMEOUT_MS = 60_000
/** A slide that has not settled by then is reported as an error, with what was missing. */
const SETTLE_TIMEOUT_MS = 30_000

export type RenderErrorReason =
  | 'access-refused'
  | 'empty-deck'
  | 'slide-not-found'
  | 'fonts-unavailable'
  | 'not-ready'
  | 'not-settled'

export type RenderStatus =
  | { status: 'loading' }
  | { status: 'ready'; slideId: string; slideIndex: number; settle: SettleResult }
  | {
      status: 'error'
      reason: RenderErrorReason
      slideId?: string
      /** `not-ready`: the inputs that never came. */
      waitingFor?: string[]
      settle?: SettleResult
    }

declare global {
  interface Window {
    __narrativeRender?: RenderStatus
  }
}

function publish(status: RenderStatus): void {
  window.__narrativeRender = status
  document.documentElement.dataset['renderStatus'] = status.status
}

export function DeckRender() {
  const { onCanvasReady } = useOutletContext<DeckShellContextValue>()
  const [params] = useSearchParams()
  const slideParam = params.get('slide')

  const { deckCtx, synced, refused } = useSlideDoc()
  // Re-renders when the slide list changes; the target is read from the doc
  // itself (below), which holds the server's slides the moment `synced` is
  // true — the hook's copy lags it by a frame.
  const slideList = useSlides()
  const { activeSlideId, setActiveSlideId } = useActiveSlide()
  const { objects } = useSlideObjects()
  const canvas = useCanvasInstance()
  const { folderId, isLoading: roleLoading } = useDeckRole()
  const folderFonts = useFolderFontsOptional()
  const deckFonts = useDeckFonts()
  const tokensSettled = useFolderTokensSettled()

  const target = useMemo(
    () => (synced ? resolveRenderSlide(listSlides(deckCtx), slideParam) : null),
    // slideList: the doc changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [synced, deckCtx, slideParam, slideList],
  )
  const [outcome, setOutcome] = useState<RenderStatus | null>(null)

  // What the paint still waits for, by name (reported if it never comes).
  const waitingFor = useMemo(() => {
    const out: string[] = []
    if (!synced) out.push('deck document')
    if (canvas === null) out.push('canvas')
    if (roleLoading || folderId === null) out.push('deck folder')
    else if (folderFonts === null || folderFonts.folderId !== folderId || folderFonts.loading)
      out.push('folder fonts')
    if (deckFonts.loading) out.push('deck fonts')
    if (!tokensSettled) out.push('folder tokens')
    if (target !== null && activeSlideId !== target.slide.id) out.push('slide shown')
    return out
  }, [
    synced,
    canvas,
    roleLoading,
    folderId,
    folderFonts,
    deckFonts.loading,
    tokensSettled,
    target,
    activeSlideId,
  ])

  // Failures known before any settling: they end the page at once.
  const failure = useMemo<RenderStatus | null>(() => {
    if (refused) return { status: 'error', reason: 'access-refused' }
    if (!synced) return null
    if (listSlides(deckCtx).length === 0) return { status: 'error', reason: 'empty-deck' }
    if (target === null) {
      return {
        status: 'error',
        reason: 'slide-not-found',
        ...(slideParam !== null ? { slideId: slideParam } : {}),
      }
    }
    if (folderFonts?.error != null || deckFonts.error != null) {
      return { status: 'error', reason: 'fonts-unavailable', slideId: target.slide.id }
    }
    return null
    // slideList: the doc changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refused, synced, deckCtx, slideList, target, slideParam, folderFonts, deckFonts.error])

  const reported = outcome ?? failure
  useEffect(() => {
    publish(reported ?? { status: 'loading' })
  }, [reported])

  // Show the requested slide.
  useEffect(() => {
    if (target !== null && activeSlideId !== target.slide.id) setActiveSlideId(target.slide.id)
  }, [target, activeSlideId, setActiveSlideId])

  // The inputs must come within PAGE_TIMEOUT_MS of the mount.
  const waitingRef = useRef(waitingFor)
  useEffect(() => {
    waitingRef.current = waitingFor
  }, [waitingFor])
  useEffect(() => {
    const timer = setTimeout(() => {
      setOutcome(
        (current) =>
          current ?? { status: 'error', reason: 'not-ready', waitingFor: waitingRef.current },
      )
    }, PAGE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [])

  // The ids the scene graph should mount (it skips unknown types), read live
  // by the settle loop: an edit during settling changes what it waits for
  // instead of starting it over.
  const objectsRef = useRef(objects)
  useEffect(() => {
    objectsRef.current = objects
  }, [objects])

  const inputsReady = waitingFor.length === 0 && failure === null && target !== null
  const targetSlideId = target?.slide.id ?? null
  const targetIndex = target?.index ?? -1

  useEffect(() => {
    if (!inputsReady || canvas === null || targetSlideId === null) return
    // Canvas installs the scheduler before it reports ready.
    const scheduler = getDefaultRenderScheduler()
    if (scheduler === null) return
    const stop = new AbortController()
    void settleScene(canvas.sceneGraph, {
      expectedIds: () =>
        objectsRef.current.filter((o) => getRenderer(o.type) !== undefined).map((o) => o.id),
      renderNow: () => scheduler.renderNow(),
      timeoutMs: SETTLE_TIMEOUT_MS,
      signal: stop.signal,
    }).then((settle) => {
      if (stop.signal.aborted) return
      setOutcome(
        settle.settled
          ? { status: 'ready', slideId: targetSlideId, slideIndex: targetIndex, settle }
          : { status: 'error', reason: 'not-settled', slideId: targetSlideId, settle },
      )
    })
    return () => stop.abort()
  }, [inputsReady, canvas, targetSlideId, targetIndex])

  return (
    <div
      data-testid="render-slide"
      className="pointer-events-none fixed left-0 top-0 overflow-hidden"
      style={{ width: SLIDE_WIDTH, height: SLIDE_HEIGHT }}
    >
      <Canvas onReady={onCanvasReady} artboardSize={{ width: SLIDE_WIDTH, height: SLIDE_HEIGHT }} />
    </div>
  )
}
