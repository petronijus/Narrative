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
 *     canvas then holds the final pixels; `failedLoads` counts this slide's
 *     loads that failed on the way (an asset that no longer exists paints its
 *     error mark, as in the editor), `failedFonts` the font families with a
 *     face that failed to load for the page (fonts load once, for every
 *     slide);
 *   - `error` with a reason, never a guess: the server refused the deck, the
 *     deck has no slides, the slide does not exist, a font list could not be
 *     read, the inputs never came within `PAGE_TIMEOUT_MS` (it lists which),
 *     or the slide did not settle within `SETTLE_TIMEOUT_MS`.
 *
 * `?paint=off` draws nothing on screen (renderer/Canvas.tsx `onScreen`):
 * the hooks' captures are rendered from the scene into a texture of their
 * own, and every on-screen frame — the settle loop draws several — would
 * be paid for again before each capture under software WebGL (on the render
 * worker ~0.7 s of CPU per frame on two cores; a photo-heavy slide spent
 * 9–12 s in its capture on production). The worker and the editor's hidden
 * export frame open it so; a person opening the page sees the slide.
 *
 * Hooks drive it from outside:
 *   - `__narrativeRenderShow` switches the slide in place;
 *   - `__narrativeRenderCapture` hands back the shown slide as a PNG — the
 *     editor's "Export as PNG" keeps this page in a hidden frame
 *     (state/browserSlideExport.ts) and asks it, instead of the server;
 *   - `__narrativeRenderSlidePng` and `__narrativeRenderLook` are the render
 *     worker's jobs (apps/render-worker/src/render.ts): a slide's PNG for the
 *     export, and a picture for an agent (`query.render`: a slide, a region
 *     or a numbered sheet, composed in pages/renderLook.ts). The worker keeps
 *     this page open between the jobs of a render session.
 * Each first waits until this page's copy of the deck holds the asking
 * side's state vector, so a picture shows edits made a moment before.
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
import { failedRenderFonts, failedRenderWork } from '../renderer/renderWork.js'
import { canvasToPng, captureSlideCanvas, watchContextLoss } from '../renderer/captureSlide.js'
import { getDefaultResourceManager } from '../renderer/ResourceManager.js'
import { setImageVariantCap } from '../renderer/imageUrl.js'
import type { RenderLookSpec } from '@narrative/shared'
import { blobToBase64, composeLook, shrinkForSheet, type LookFrame } from './renderLook.js'
import { startJobTimer, type JobTimer, type JobTimings } from './renderTimings.js'
import { decodeBase64, untilCoversStateVector } from '../lib/stateVector.js'
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
  | {
      status: 'ready'
      slideId: string
      slideIndex: number
      /** Loads (not fonts) that failed while this slide painted. */
      failedLoads: number
      /** Font families with a face that failed to load, for the whole page. */
      failedFonts: string[]
      settle: SettleResult
    }
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
    /**
     * Show another slide (id or 0-based index) without reloading the page:
     * the render worker renders a deck's slides one after another in one
     * page. The status goes back to `loading` until that slide settles.
     */
    __narrativeRenderShow?: (slide: string) => void
    /**
     * The shown slide as a PNG (1920×1080), once it is ready. With
     * `stateVector` (base64 of the asking editor's Y.encodeStateVector), it
     * first waits until this page's copy of the deck holds those edits, then
     * settles the slide again — the picture shows what the editor shows.
     */
    __narrativeRenderCapture?: (opts?: { stateVector?: string }) => Promise<Blob>
    /**
     * The render worker's export: once the page holds the edits
     * `stateVector` names, show `slideId`, settle it and return its PNG
     * (1920×1080, base64) — or the reason it cannot.
     */
    __narrativeRenderSlidePng?: (
      slideId: string,
      opts: { stateVector: string },
    ) => Promise<
      PageJobOutcome<{
        base64: string
        slideIndex: number
        failedLoads: number
        failedFonts: string[]
        timings: JobTimings
      }>
    >
    /**
     * The render worker's look for an agent (`query.render`): the slides
     * shown in turn, captured and composed into one PNG (pages/renderLook.ts).
     */
    __narrativeRenderLook?: (
      spec: RenderLookSpec,
      opts: { stateVector: string },
    ) => Promise<
      PageJobOutcome<{
        base64: string
        width: number
        height: number
        slides: Array<{ slideId: string; index: number; failedLoads: number }>
        failedFonts: string[]
        timings: JobTimings
      }>
    >
  }
}

/** A page job's outcome for the render worker (a reason it can map, never a thrown error). */
export type PageJobOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: RenderErrorReason; detail: string }

class PageJobError extends Error {
  constructor(
    readonly reason: RenderErrorReason,
    detail: string,
  ) {
    super(detail)
  }
}

/** How long a capture waits for the asking editor's latest edits to reach this page. */
const CAPTURE_SYNC_TIMEOUT_MS = 15_000

function publish(status: RenderStatus): void {
  window.__narrativeRender = status
  document.documentElement.dataset['renderStatus'] = status.status
}

export function DeckRender() {
  const { onCanvasReady } = useOutletContext<DeckShellContextValue>()
  const [params, setParams] = useSearchParams()
  const slideParam = params.get('slide')
  const onScreen = params.get('paint') !== 'off'

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
  // The outcome of one `?slide=`: a switch to another slide starts over.
  const [outcome, setOutcome] = useState<{ for: string | null; status: RenderStatus } | null>(null)

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

  // A refusal ends whatever the page showed before (its token ended while it
  // was kept open between jobs).
  const reported =
    refused || outcome === null || outcome.for !== slideParam ? failure : outcome.status
  const refusedRef = useRef(refused)
  useEffect(() => {
    refusedRef.current = refused
  }, [refused])
  useEffect(() => {
    publish(reported ?? { status: 'loading' })
  }, [reported])

  // Show the requested slide.
  useEffect(() => {
    if (target !== null && activeSlideId !== target.slide.id) setActiveSlideId(target.slide.id)
  }, [target, activeSlideId, setActiveSlideId])

  // The inputs must come within PAGE_TIMEOUT_MS — of the mount, and again of
  // each switch to another slide.
  const waitingRef = useRef(waitingFor)
  useEffect(() => {
    waitingRef.current = waitingFor
  }, [waitingFor])
  useEffect(() => {
    const timer = setTimeout(() => {
      setOutcome((current) =>
        current !== null && current.for === slideParam
          ? current
          : {
              for: slideParam,
              status: { status: 'error', reason: 'not-ready', waitingFor: waitingRef.current },
            },
      )
    }, PAGE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [slideParam])

  // Loads that fail count against the slide being shown: from the page's
  // load for the first, from its switch for each later one (renderWork's
  // count runs for the page's whole life). Fonts are not loads here: they
  // load once for the page, and are reported by family instead.
  const failureBaseline = useRef<number | null>(null)
  useEffect(() => {
    failureBaseline.current = failureBaseline.current === null ? 0 : failedRenderWork()
  }, [slideParam])

  // Switching slides in place (the render worker's way through a deck).
  useEffect(() => {
    window.__narrativeRenderShow = (slide: string) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          next.set('slide', slide)
          return next
        },
        { replace: true },
      )
    }
    return () => {
      delete window.__narrativeRenderShow
    }
  }, [setParams])

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
    const settledFor = slideParam
    void settleScene(canvas.sceneGraph, {
      expectedIds: () =>
        objectsRef.current.filter((o) => getRenderer(o.type) !== undefined).map((o) => o.id),
      renderNow: () => scheduler.renderNow(),
      timeoutMs: SETTLE_TIMEOUT_MS,
      signal: stop.signal,
    }).then((settle) => {
      if (stop.signal.aborted) return
      setOutcome({
        for: settledFor,
        status: settle.settled
          ? {
              status: 'ready',
              slideId: targetSlideId,
              slideIndex: targetIndex,
              failedLoads: settle.failedLoads - (failureBaseline.current ?? 0),
              failedFonts: failedRenderFonts(),
              settle,
            }
          : { status: 'error', reason: 'not-settled', slideId: targetSlideId, settle },
      })
    })
    return () => stop.abort()
  }, [inputsReady, canvas, targetSlideId, targetIndex, slideParam])

  // Pictures of slides for the editor and the render worker (see the header).
  useEffect(() => {
    if (canvas === null) return
    const sceneGraph = canvas.sceneGraph
    const stopWatching = watchContextLoss(sceneGraph)

    /**
     * Until this page's copy of the deck holds the edits `stateVector` names
     * — or the deck is refused, which no wait would end (an empty, refused
     * document never covers anything).
     */
    const syncTo = async (stateVector: string | undefined): Promise<void> => {
      if (stateVector === undefined) return
      let waiting = true
      const refusal = (async () => {
        while (waiting) {
          if (refusedRef.current) {
            throw new PageJobError('access-refused', 'the server refused the deck')
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      })()
      try {
        await Promise.race([
          untilCoversStateVector(
            deckCtx.doc,
            decodeBase64(stateVector),
            CAPTURE_SYNC_TIMEOUT_MS,
          ).catch((err: unknown) => {
            throw new PageJobError(
              'not-ready',
              err instanceof Error ? err.message : 'the latest edits did not arrive',
            )
          }),
          refusal,
        ])
      } finally {
        waiting = false
        void refusal.catch(() => undefined)
      }
    }
    /**
     * Settle the shown slide again — edits since `ready` (the ones just
     * waited for among them) may have started loads and rasters — and
     * capture it, with the loads that failed for it since it was shown.
     */
    const settleAndCapture = async (
      timer?: JobTimer,
    ): Promise<{
      canvas: HTMLCanvasElement | OffscreenCanvas
      failedLoads: number
    }> => {
      const scheduler = getDefaultRenderScheduler()
      if (scheduler === null) throw new Error('the canvas is not ready')
      const settle = await settleScene(sceneGraph, {
        expectedIds: () =>
          objectsRef.current.filter((o) => getRenderer(o.type) !== undefined).map((o) => o.id),
        renderNow: () => scheduler.renderNow(),
        timeoutMs: SETTLE_TIMEOUT_MS,
      })
      timer?.mark('settle')
      timer?.settled(settle.phases)
      if (!settle.settled) throw new PageJobError('not-settled', 'the slide did not finish drawing')
      const canvas = captureSlideCanvas(sceneGraph)
      timer?.mark('extract')
      return { canvas, failedLoads: settle.failedLoads - (failureBaseline.current ?? 0) }
    }
    /**
     * Show `slideId` and wait until the page calls it ready; a refusal throws
     * its reason. Its position comes from the document now (a slide inserted
     * before it since the page last showed it moved it).
     */
    const showAndWait = async (slideId: string): Promise<{ index: number }> => {
      window.__narrativeRenderShow?.(slideId)
      for (;;) {
        const status = window.__narrativeRender
        if (status?.status === 'ready' && status.slideId === slideId) break
        if (status?.status === 'error') {
          const waiting =
            status.waitingFor !== undefined ? ` (waiting for ${status.waitingFor.join(', ')})` : ''
          throw new PageJobError(status.reason, `slide ${slideId}${waiting}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const index = listSlides(deckCtx).findIndex((s) => s.id === slideId)
      if (index < 0) throw new PageJobError('slide-not-found', `slide ${slideId}`)
      // The slides shown before let go of their pictures: free them now, not
      // after the editor's grace — this page goes through a deck in turn.
      getDefaultResourceManager().flushReleased()
      return { index }
    }
    /**
     * A page job's outcome: its value, or the reason the page could not do it
     * (gone, refused, never ready). Anything else — the canvas, an encoder —
     * is the renderer's fault and rejects, so the worker treats it as one.
     */
    const outcome = async <T,>(job: () => Promise<T>): Promise<PageJobOutcome<T>> => {
      try {
        return { ok: true, value: await job() }
      } catch (err) {
        if (err instanceof PageJobError)
          return { ok: false, reason: err.reason, detail: err.message }
        throw err
      }
    }

    window.__narrativeRenderCapture = async (opts) => {
      await syncTo(opts?.stateVector)
      const status = window.__narrativeRender
      if (status?.status !== 'ready') {
        throw new Error(
          status?.status === 'error'
            ? `the slide cannot be rendered (${status.reason})`
            : 'the slide is not ready yet',
        )
      }
      return canvasToPng((await settleAndCapture()).canvas)
    }
    window.__narrativeRenderSlidePng = (slideId, opts) =>
      outcome(async () => {
        const timer = startJobTimer()
        await syncTo(opts.stateVector)
        timer.mark('sync')
        const { index } = await showAndWait(slideId)
        timer.mark('ready')
        const shot = await settleAndCapture(timer)
        const base64 = await blobToBase64(await canvasToPng(shot.canvas))
        timer.mark('encode')
        return {
          base64,
          slideIndex: index,
          failedLoads: shot.failedLoads,
          failedFonts: failedRenderFonts(),
          timings: timer.done(),
        }
      })
    window.__narrativeRenderLook = (spec, opts) =>
      outcome(async () => {
        const timer = startJobTimer()
        await syncTo(opts.stateVector)
        timer.mark('sync')
        const slideIds = spec.mode === 'sheet' ? spec.slideIds : [spec.slideId]
        const frames: LookFrame[] = []
        const slides: Array<{ slideId: string; index: number; failedLoads: number }> = []
        // A sheet's tiles are small: its slides draw with preview-size pictures.
        if (spec.mode === 'sheet') setImageVariantCap('preview')
        try {
          for (const slideId of slideIds) {
            const { index } = await showAndWait(slideId)
            timer.mark('ready')
            const shot = await settleAndCapture(timer)
            // A sheet keeps only its tile of each slide, not 20 full captures.
            const canvas =
              spec.mode === 'sheet' ? shrinkForSheet(shot.canvas, slideIds.length) : shot.canvas
            frames.push({ canvas, index })
            slides.push({ slideId, index, failedLoads: shot.failedLoads })
          }
        } finally {
          setImageVariantCap(null)
        }
        const look = await composeLook(
          spec.mode === 'region' ? { mode: 'region', region: spec.region } : { mode: spec.mode },
          frames,
        )
        const base64 = await blobToBase64(look.png)
        timer.mark('compose')
        return {
          base64,
          width: look.width,
          height: look.height,
          slides,
          failedFonts: failedRenderFonts(),
          timings: timer.done(),
        }
      })
    return () => {
      stopWatching()
      delete window.__narrativeRenderCapture
      delete window.__narrativeRenderSlidePng
      delete window.__narrativeRenderLook
    }
  }, [canvas, deckCtx])

  return (
    <div
      data-testid="render-slide"
      className="pointer-events-none fixed left-0 top-0 overflow-hidden"
      style={{ width: SLIDE_WIDTH, height: SLIDE_HEIGHT }}
    >
      <Canvas
        onReady={onCanvasReady}
        artboardSize={{ width: SLIDE_WIDTH, height: SLIDE_HEIGHT }}
        onScreen={onScreen}
      />
    </div>
  )
}
