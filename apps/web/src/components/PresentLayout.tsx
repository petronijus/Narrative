/**
 * components/PresentLayout.tsx
 *
 * M5: Present mode fullscreen shell.
 * M6: Animation runtime integration.
 * M9: Slide navigation.
 * M12: Media preloading pipeline + video playback.
 *
 * Ready means ready (docs/plans/performance.md → D; ADR 0016). Before the
 * first slide shows, behind a "Preparing presentation…" overlay:
 *   1. the deck's inputs are loaded (document, folder, font lists, tokens:
 *      state/useDeckInputs.ts);
 *   2. every picture is fetched and every video buffered on its first frame
 *      (present/preloadMedia.ts, renderer/presentVideos.ts);
 *   3. the slides are prepared off stage — mounted, pictures decoded and
 *      uploaded, texts rasterised (renderer/presentSlides.ts) — all of them,
 *      or as many as the GPU budget holds, the start slide and its
 *      neighbours always;
 *   4. the presenter view's slide pictures are rendered.
 * Then every advance only swaps a prepared scene in (present/presentation.ts):
 * no mount, raster, upload, decode or request on the way. However long the
 * preparation takes, it is not cut short on a timer — the presenter may skip
 * it ("Skip and present now"); Esc returns to the editor.
 *
 * Architecture:
 * - No toolbar, sidebar or inspector — a pure fullscreen render.
 * - The Canvas (the shared renderer pipeline) sits in a centred slide-sized
 *   container, scaled to fit with a CSS transform.
 * - The Pixi canvas has the CSS size SLIDE_WIDTH × SLIDE_HEIGHT (1920×1080)
 *   and a ResizeObserver on the viewport computes scale = min(vw/sw, vh/sh).
 * - No pointer listeners → the canvas is read-only (pointer-events:none).
 * - Keyboard: Escape → editor, Arrow/Space/Page → slide navigation.
 * - Fullscreen API: F or F11.
 * - `?slide=N` (1-based, every slide counted): start at slide N instead of
 *   the active slide — see presentStartSlide.ts (agentic A1,
 *   `editor.present.link`).
 *
 * Accessibility:
 * - role="application" with an aria-label for screen-reader context.
 * - Subtle escape hint in the corner (aria-hidden).
 */

import { useRef, useState, useCallback, useEffect } from 'react'
import { useShortcuts } from '../state/useShortcuts.js'
import { ShortcutsCheatsheet } from '../ui/lazyEditorParts.js'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Canvas } from '../renderer/Canvas.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from '../renderer/constants.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useSlides } from '../state/useSlides.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useDeckStore } from '../state/useDeckStore.js'
import { useDeckInputsWaitingFor } from '../state/useDeckInputs.js'
import { EditorVideoPreview } from '../ui/EditorVideoPreview.js'
import { PresenterOverlay } from '../ui/PresenterOverlay.js'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import type { VideoObject } from '@narrative/shared'
import { sanitizeHref } from '@narrative/shared'
import { presentStartSlideId } from './presentStartSlide.js'
import { PresentDisplayPicker } from '../present/PresentDisplayPicker.js'
import { requestPresentationFullscreen } from '../present/presentScreen.js'
import { Presentation } from '../present/presentation.js'
import { preloadDeckMedia, type MediaPreloadProgress } from '../present/preloadMedia.js'
import { PresentSlideCache } from '../renderer/presentSlides.js'
import { PresentVideoPool } from '../renderer/presentVideos.js'
import { presentDeviceScale } from '../renderer/videoRendition.js'
import { getDefaultResourceManager } from '../renderer/ResourceManager.js'
import { whenRenderWorkIdle } from '../renderer/renderWork.js'
import { PresentVideosContext, type PresentVideosValue } from '../present/presentVideosContext.js'

/** Vypočte scale-to-fit pro slide do daného viewportu při zachování aspect ratio. */
function computeScale(viewportW: number, viewportH: number): number {
  if (viewportW <= 0 || viewportH <= 0) return 1
  return Math.min(viewportW / SLIDE_WIDTH, viewportH / SLIDE_HEIGHT)
}

/** Where the preparation is, for the overlay. */
interface Preparation {
  phase: 'loading' | 'media' | 'slides' | 'ready'
  media: MediaPreloadProgress
  slides: { prepared: number; planned: number }
  thumbnails: { ready: number; total: number }
}

const NO_PREPARATION: Preparation = {
  phase: 'loading',
  media: { total: 0, completed: 0, errored: 0 },
  slides: { prepared: 0, planned: 0 },
  thumbnails: { ready: 0, total: 0 },
}

export interface PresentLayoutProps {
  /**
   * Callback předaný do Canvas.onReady — signalizuje že Pixi je ready.
   * DeckPresent získá z DeckShell přes useOutletContext a pasuje sem.
   */
  onCanvasReady?: ((instance: CanvasInstance | null) => void) | undefined
}

export function PresentLayout({ onCanvasReady }: PresentLayoutProps = {}) {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  // ?presenter=1 → render only the presenter overlay, no canvas. Used by
  // the pop-out window so the user can put the projector in the main tab
  // and the presenter notes on their laptop.
  const isPresenterWindow = searchParams.get('presenter') === '1'

  const containerRef = useRef<HTMLDivElement>(null)
  // P11: ref on the 1920×1080 slide container — the bounding box drives
  // viewport→slide-space coordinate conversion for the hyperlink click
  // interceptor. The container is CSS-transform: scale(...)-ed, so its
  // getBoundingClientRect already reflects the current scale.
  const slideContainerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState<number>(() =>
    computeScale(window.innerWidth, window.innerHeight),
  )

  // Canvas instance z DeckShell context (null dokud Pixi neinicializuje)
  const canvasInstance = useCanvasInstance()

  // M9: slide list + active slide for navigation
  const slides = useSlides()
  const store = useDeckStore()
  const { activeSlideId, setActiveSlideId } = useActiveSlide()
  const inputsWaitingFor = useDeckInputsWaitingFor({ folderOptional: true })

  // M12: active slide objects for the video previews
  const { objects } = useSlideObjects()
  const videoObjects = objects.filter((o): o is VideoObject => o.type === 'video')

  // P11: keep the latest objects snapshot in a ref so the click-capture
  // hyperlink interceptor (installed once) reads the up-to-date list
  // without re-binding the listener each render.
  const objectsRef = useRef(objects)
  useEffect(() => {
    objectsRef.current = objects
  }, [objects])

  // ---------------------------------------------------------------------------
  // Preparation: ready means ready (see the file comment)
  // ---------------------------------------------------------------------------

  const presentationRef = useRef<Presentation | null>(null)
  const [preparation, setPreparation] = useState<Preparation>(NO_PREPARATION)
  const [preloadDismissed, setPreloadDismissed] = useState(false)
  const ready = preparation.phase === 'ready'
  const showPreloadOverlay = !isPresenterWindow && !ready && !preloadDismissed
  const [videos, setVideos] = useState<PresentVideosValue | null>(null)

  // The presenter view's slide pictures (main window): the overlay reports
  // how many of the slides it shows have theirs.
  const thumbsRef = useRef({ ready: 0, total: 0, settled: false })
  const thumbWaitersRef = useRef<Array<() => void>>([])
  const onThumbnails = useCallback((ready: number, total: number) => {
    thumbsRef.current = { ready, total, settled: ready >= total }
    setPreparation((p) => (p.phase === 'ready' ? p : { ...p, thumbnails: { ready, total } }))
    if (ready >= total) {
      const waiters = thumbWaitersRef.current
      thumbWaitersRef.current = []
      for (const w of waiters) w()
    }
  }, [])

  // The slide to start at: `?slide=N`, else the active slide (kept per deck), else the first.
  const startSlideParam = searchParams.get('slide')
  /** The `?slide=` value already acted on (see the jump effect below). */
  const appliedStartParamRef = useRef<string | null>(null)
  /** The first slide was shown (prepared, or the preparation skipped). */
  const startedRef = useRef(false)
  const inputsReady = inputsWaitingFor.length === 0 && slides.length > 0
  const startRef = useRef<{ canvas: CanvasInstance; cancel: () => void } | null>(null)

  useEffect(() => {
    if (isPresenterWindow || canvasInstance === null || !inputsReady) return
    if (startRef.current?.canvas === canvasInstance) return
    const deck = store.getSlides()
    const fromParam = startSlideParam !== null ? presentStartSlideId(startSlideParam, deck) : null
    const startId =
      fromParam ??
      (activeSlideId !== null && deck.some((s) => s.id === activeSlideId)
        ? activeSlideId
        : (deck.find((s) => s.skipped !== true) ?? deck[0])!.id)
    if (fromParam !== null) appliedStartParamRef.current = startSlideParam

    // The canvas installs its ResourceManager before it reports ready.
    let resourceManager: ReturnType<typeof getDefaultResourceManager>
    try {
      resourceManager = getDefaultResourceManager()
    } catch {
      return
    }
    // A 4K video plays its 1080p rendition where the presentation shows no
    // more pixels (renderer/videoRendition.ts): chosen by the slide's size on
    // screen and the canvas's density, again when they change (the effect on
    // `scale` below, and the pool's own density watch), switched off stage.
    const pool: PresentVideoPool = new PresentVideoPool({
      deviceScale: () =>
        presentDeviceScale(
          canvasInstance.sceneGraph.getPixelDensity(),
          slideContainerRef.current?.getBoundingClientRect().width ?? null,
        ),
      canSwitch: (objectId): boolean => {
        if (presentation.isMoving()) return false
        const shown = presentation.shown
        if (shown === null) return true
        const slide = store.getSlides().find((s) => s.id === shown)
        return slide === undefined || !slide.objects.some((o) => o.id === objectId)
      },
      onSwitched: (objectId) => cache.rewarmContaining(objectId),
    })
    const cache = new PresentSlideCache({
      sceneGraph: canvasInstance.sceneGraph,
      resourceManager,
      liveVideo: (objectId) => pool.get(objectId)?.element ?? null,
    })
    const presentation = new Presentation({
      sceneGraph: canvasInstance.sceneGraph,
      cache,
      store,
      setActiveSlideId,
    })
    presentationRef.current = presentation
    setVideos({
      pool,
      released: (objectId) => {
        void pool.rewind(objectId).then(() => cache.rewarmContaining(objectId))
      },
    })
    const abort = new AbortController()
    let cancelled = false
    const unsubscribeCache = cache.subscribe(() => {
      const p = cache.progress()
      setPreparation((prev) =>
        prev.phase === 'ready'
          ? prev
          : { ...prev, slides: { prepared: p.prepared, planned: p.planned } },
      )
    })
    startRef.current = {
      canvas: canvasInstance,
      cancel: () => {
        cancelled = true
        abort.abort()
        unsubscribeCache()
        presentation.destroy()
        cache.destroy()
        pool.destroy()
        if (presentationRef.current === presentation) presentationRef.current = null
      },
    }

    void (async () => {
      // 1. Media: every picture fetched, every video buffered on its first frame.
      setPreparation((p) => ({ ...p, phase: 'media' }))
      const media = await preloadDeckMedia(deck, {
        videos: pool,
        density: canvasInstance.sceneGraph.getPixelDensity(),
        signal: abort.signal,
        onProgress: (media) => setPreparation((p) => ({ ...p, media })),
      })
      if (cancelled) return
      // Each picture drawn from the variant fetched for it, on every slide.
      cache.setVariantFloor(media.variants)
      // Skipped during the media: the presentation runs, planned around the slide shown.
      if (startedRef.current) return
      // 2. The slides, prepared off stage.
      setPreparation((p) => ({ ...p, phase: 'slides' }))
      presentation.prepare(startId)
      // The slide it starts on: `startId`, unless an edit during the load deleted it.
      const startAt = (): string => presentation.startSlide ?? startId
      // Ready means ready (ADR 0016): an edit during any of the waits below
      // replans (the plan follows the deck from `prepare` on), so the slides
      // are checked once more after the last wait, right before the start,
      // and waited for again while an edit left them to rebuild.
      for (;;) {
        await new Promise<void>((resolve) => {
          const check = (): void => {
            if (cancelled || presentation.isPrepared(startAt())) {
              stop()
              resolve()
            }
          }
          const stop = cache.subscribe(check)
          check()
        })
        // 3. The presenter view's pictures, and anything still loading for the canvas.
        await new Promise<void>((resolve) => {
          if (thumbsRef.current.settled) resolve()
          else thumbWaitersRef.current.push(resolve)
        })
        await whenRenderWorkIdle(abort.signal)
        // A video switching files after a display change during the load.
        await pool.whenSwitched()
        await document.fonts.ready
        if (cancelled || presentationRef.current !== presentation || startedRef.current) return
        if (presentation.isPrepared(startAt())) break
      }
      if (presentation.start(startAt())) {
        startedRef.current = true
        setPreparation((p) => ({ ...p, phase: 'ready' }))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- started once per canvas, from the state at that moment
  }, [canvasInstance, inputsReady, isPresenterWindow])

  // Torn down with the canvas (and on unmount).
  useEffect(() => {
    return () => {
      startRef.current?.cancel()
      startRef.current = null
    }
  }, [canvasInstance])

  /** Skip the rest of the preparation: present what is there; slides not prepared yet are waited for when navigated to. */
  const skipPreparation = useCallback(() => {
    setPreloadDismissed(true)
    const presentation = presentationRef.current
    if (presentation === null || activeSlideId === null || startedRef.current) return
    startedRef.current = true
    // The slide prepared: swapped in; otherwise the canvas shows it as it
    // mounted it, and the presentation goes on from there.
    presentation.startNow(activeSlideId)
    setPreparation((p) => ({ ...p, phase: 'ready' }))
  }, [activeSlideId])

  // `?slide=N`: jump there once the slide list is known. Remembered per
  // parameter value, so the jump happens once per link — the presenter then
  // navigates freely — and a same-tab navigation to another link (only the
  // query changes, the layout stays mounted) jumps again.
  useEffect(() => {
    if (startSlideParam === null || appliedStartParamRef.current === startSlideParam) return
    if (slides.length === 0) return
    const target = presentStartSlideId(startSlideParam, slides)
    // With a canvas the start slide is chosen when the preparation starts.
    if (canvasInstance !== null && !ready) return
    appliedStartParamRef.current = startSlideParam
    if (target === null) return
    const presentation = presentationRef.current
    if (presentation !== null && ready) presentation.jump(target)
    else setActiveSlideId(target)
  }, [startSlideParam, slides, setActiveSlideId, canvasInstance, ready])

  // The active slide moved without the presentation (the slide shown was
  // deleted under the presenter): it follows.
  useEffect(() => {
    const presentation = presentationRef.current
    if (!ready || presentation === null || activeSlideId === null) return
    if (presentation.shown !== activeSlideId) presentation.follow(activeSlideId)
  }, [activeSlideId, ready])

  // M19 phase 3: presenter overlay — toggled by 'N' key. When visible, the
  // canvas shrinks (via flex-1 min-h-0 on the wrapper) and the overlay takes
  // the bottom strip with notes / next-slide thumbnail / elapsed timer.
  const [presenterVisible, setPresenterVisible] = useState(isPresenterWindow)

  // M19 phase 3: BroadcastChannel keeps the pop-out presenter window and the
  // main present window in sync. Both windows are on the same origin, so the
  // channel is cheap and needs no server roundtrip. Payload: the active
  // slide id; the receiver runs the same transition-aware navigation the
  // main window's keyboard handler would, so a popup-driven "next" plays
  // the transition on the main canvas rather than snapping the slide.
  const bcRef = useRef<BroadcastChannel | null>(null)
  const suppressBroadcastRef = useRef(false)

  // Refs so the BroadcastChannel onmessage handler (installed once) can
  // read the latest slide list, active id, and navigateToSlide closure
  // without reinstalling the listener on every render.
  const slidesRef = useRef(slides)
  const activeSlideIdRef = useRef(activeSlideId)
  useEffect(() => {
    slidesRef.current = slides
  }, [slides])
  useEffect(() => {
    activeSlideIdRef.current = activeSlideId
  }, [activeSlideId])

  const openPresenterWindow = useCallback(() => {
    if (id === undefined) return
    const url = `/deck/${id}/present?presenter=1`
    // noopener keeps the popup's window.opener = null for security; the
    // BroadcastChannel handles sync without needing a direct reference.
    window.open(url, `narrative-presenter-${id}`, 'noopener,width=960,height=720')
  }, [id])

  // ---------------------------------------------------------------------------
  // Scale-to-fit: ResizeObserver na fullscreen container
  // ---------------------------------------------------------------------------

  // Slide area element — observed for scale. Different from containerRef
  // once the presenter overlay is shown (slide area shrinks to leave room).
  const slideAreaRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = slideAreaRef.current
    if (el === null) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      const { width, height } = entry.contentRect
      setScale(computeScale(width, height))
    })

    observer.observe(el)

    // Počáteční výpočet (pro případ, že ResizeObserver nepošle entry synchronně)
    const { width, height } = el.getBoundingClientRect()
    setScale(computeScale(width, height))

    return () => observer.disconnect()
  }, [])

  // The slide's size on screen changed (fullscreen, another display, the
  // presenter view): the videos choose their file again (renderer/presentVideos.ts).
  useEffect(() => {
    videos?.pool.displayChanged()
  }, [scale, videos])

  // ---------------------------------------------------------------------------
  // Fullscreen API toggle
  // ---------------------------------------------------------------------------

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement === null) {
      try {
        // On the display chosen under "Display", when there is one.
        await requestPresentationFullscreen(document.documentElement)
      } catch {
        // Fullscreen odmítnut (embedded context apod.) — ignoruj
      }
    } else {
      try {
        await document.exitFullscreen()
      } catch {
        // Nelze exit — ignoruj
      }
    }
  }, [])

  // ---------------------------------------------------------------------------
  // M9: Slide navigation
  // ---------------------------------------------------------------------------

  // With a canvas, every move goes through the presentation (prepared
  // scenes, transitions, builds: present/presentation.ts) once it is ready;
  // before that the overlay is up and the keys wait. Without a presentation
  // — the pop-out presenter window (no canvas: the main window plays the
  // transition), or a canvas whose preparation never started — the active
  // slide moves directly (skipped slides passed over) and the canvas mounts
  // it the editor's way.
  const navigateToSlide = useCallback(
    (direction: 'next' | 'prev') => {
      const presentation = presentationRef.current
      if (presentation !== null) {
        if (!ready) return
        if (direction === 'next') presentation.next()
        else presentation.previous()
        return
      }
      if (slides.length === 0) return
      const currentIdx = slides.findIndex((s) => s.id === activeSlideId)
      if (currentIdx === -1) return
      const step = direction === 'next' ? 1 : -1
      let targetIdx = currentIdx + step
      while (targetIdx >= 0 && targetIdx < slides.length) {
        const candidate = slides[targetIdx]
        if (candidate !== undefined && candidate.skipped !== true) break
        targetIdx += step
      }
      const target = slides[targetIdx]
      if (target !== undefined) setActiveSlideId(target.id)
    },
    [slides, activeSlideId, setActiveSlideId, ready],
  )

  /** Cut to a slide (a link, a jump from the presenter window). */
  const jumpToSlide = useCallback(
    (slideId: string) => {
      const presentation = presentationRef.current
      if (presentation !== null) {
        if (ready) presentation.jump(slideId)
        return
      }
      setActiveSlideId(slideId)
    },
    [setActiveSlideId, ready],
  )

  // Mirror navigateToSlide into a ref so the one-time BroadcastChannel
  // listener below can call the latest closure without re-installing.
  const navigateToSlideRef = useRef(navigateToSlide)
  const jumpToSlideRef = useRef(jumpToSlide)
  useEffect(() => {
    navigateToSlideRef.current = navigateToSlide
    jumpToSlideRef.current = jumpToSlide
  }, [navigateToSlide, jumpToSlide])

  // P11: hyperlink interceptor. Installed once on the slide container
  // in capture phase so it fires BEFORE the document-level click bridge
  // that advances onClick animation triggers. When the click hits an
  // object that carries a `hyperlink` field, we navigate / open the URL
  // and stop propagation so the timeline doesn't advance underneath.
  //
  // Hit-testing uses AABB on the object's slide-space rect. That ignores
  // rotation, but it's good enough for hyperlinks (the user clicks what
  // they see; a small dead-zone past a rotated edge is acceptable).
  useEffect(() => {
    const el = slideContainerRef.current
    if (el === null) return

    function handleClick(e: MouseEvent) {
      const rect = el!.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      // CSS-scaled container → recover slide coords (1920×1080).
      const sx = ((e.clientX - rect.left) / rect.width) * SLIDE_WIDTH
      const sy = ((e.clientY - rect.top) / rect.height) * SLIDE_HEIGHT

      const list = objectsRef.current
      // Walk top-to-bottom (last in array = top of z-order).
      for (let i = list.length - 1; i >= 0; i--) {
        const o = list[i]
        if (o === undefined) continue
        if (o.hyperlink === undefined) continue
        if (sx < o.x || sx > o.x + o.width) continue
        if (sy < o.y || sy > o.y + o.height) continue

        // Match — handle the hyperlink and stop propagation so the
        // animation bridge doesn't also advance the timeline.
        e.stopPropagation()
        e.preventDefault()
        const link = o.hyperlink
        if (link.kind === 'slide') {
          if (link.slideId !== '') jumpToSlideRef.current(link.slideId)
        } else {
          // Sanitise before navigating: sanitizeHref allows only
          // http/https/mailto (bare hosts get https:// prepended) and
          // returns null for javascript:/data:/vbscript:/protocol-relative
          // targets, which would otherwise execute on the app origin via
          // window.open. null → do not navigate.
          const href = sanitizeHref(link.href)
          if (href !== null) {
            window.open(href, link.target ?? '_blank', 'noopener,noreferrer')
          }
        }
        return
      }
    }

    function handleMove(e: MouseEvent) {
      const rect = el!.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const sx = ((e.clientX - rect.left) / rect.width) * SLIDE_WIDTH
      const sy = ((e.clientY - rect.top) / rect.height) * SLIDE_HEIGHT
      const list = objectsRef.current
      let hit = false
      for (let i = list.length - 1; i >= 0; i--) {
        const o = list[i]
        if (o === undefined || o.hyperlink === undefined) continue
        if (sx < o.x || sx > o.x + o.width) continue
        if (sy < o.y || sy > o.y + o.height) continue
        hit = true
        break
      }
      el!.style.cursor = hit ? 'pointer' : ''
    }

    el.addEventListener('click', handleClick, true)
    el.addEventListener('mousemove', handleMove)
    return () => {
      el.removeEventListener('click', handleClick, true)
      el.removeEventListener('mousemove', handleMove)
    }
  }, [])

  // BroadcastChannel setup — installed once per deck id. Receiver computes
  // direction by comparing the current activeSlideId to the incoming id:
  // an adjacent jump runs through navigateToSlide (plays transitions, plays
  // in-slide animations on arrival); non-adjacent multi-step jumps cut,
  // because there's no good transition to play through multiple slides.
  useEffect(() => {
    if (id === undefined || typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(`narrative:deck:${id}:activeSlide`)
    bcRef.current = channel
    channel.onmessage = (e: MessageEvent<{ slideId: string }>) => {
      const slideId = e.data?.slideId
      if (typeof slideId !== 'string') return
      const current = activeSlideIdRef.current
      const localSlides = slidesRef.current
      if (current === slideId) return

      const currentIdx = localSlides.findIndex((s) => s.id === current)
      const targetIdx = localSlides.findIndex((s) => s.id === slideId)

      suppressBroadcastRef.current = true
      // The slides between two neighbours may be skipped ones.
      const between = (a: number, b: number): boolean =>
        localSlides.slice(Math.min(a, b) + 1, Math.max(a, b)).every((s) => s.skipped === true)
      if (currentIdx !== -1 && targetIdx > currentIdx && between(currentIdx, targetIdx)) {
        navigateToSlideRef.current('next')
      } else if (
        currentIdx !== -1 &&
        targetIdx !== -1 &&
        targetIdx < currentIdx &&
        between(currentIdx, targetIdx)
      ) {
        navigateToSlideRef.current('prev')
      } else {
        // Non-adjacent jump — a cut.
        jumpToSlideRef.current(slideId)
      }
    }
    return () => {
      channel.close()
      bcRef.current = null
    }
  }, [id])

  // Broadcast every local activeSlideId change — except when the change was
  // itself caused by a remote broadcast (flag flip around setState).
  useEffect(() => {
    if (suppressBroadcastRef.current) {
      suppressBroadcastRef.current = false
      return
    }
    if (activeSlideId === null) return
    bcRef.current?.postMessage({ slideId: activeSlideId })
  }, [activeSlideId])

  // ---------------------------------------------------------------------------
  // Cheatsheet modal state
  // ---------------------------------------------------------------------------

  const [cheatsheetOpen, setCheatsheetOpen] = useState(false)

  // ---------------------------------------------------------------------------
  // Keyboard handling — P9 centralised registry
  // ---------------------------------------------------------------------------

  useShortcuts([
    {
      keys: 'Escape',
      scope: 'global',
      preventDefault: true,
      action: 'present.exit',
      description: 'Exit presentation',
      handler: () => {
        setPreloadDismissed(true)
        navigate(`/deck/${id ?? ''}`)
      },
    },
    {
      keys: ['ArrowRight', ' ', 'PageDown'],
      scope: 'global',
      preventDefault: true,
      action: 'present.next',
      description: 'Next slide',
      handler: () => {
        navigateToSlide('next')
      },
    },
    {
      keys: ['ArrowLeft', 'PageUp'],
      scope: 'global',
      preventDefault: true,
      action: 'present.previous',
      description: 'Previous slide',
      handler: () => {
        navigateToSlide('prev')
      },
    },
    {
      keys: ['f', 'F11'],
      scope: 'global',
      preventDefault: true,
      action: 'present.fullscreen',
      description: 'Toggle fullscreen',
      handler: () => {
        void toggleFullscreen()
      },
    },
    {
      keys: ['n', 'N'],
      scope: 'global',
      preventDefault: true,
      action: 'present.presenterView',
      description: 'Toggle presenter view',
      handler: () => {
        setPresenterVisible((v) => !v)
      },
    },
    {
      keys: 'Mod+/',
      scope: 'global',
      preventDefault: true,
      action: 'view.shortcuts',
      description: 'Keyboard shortcuts cheatsheet',
      handler: () => {
        setCheatsheetOpen((prev) => !prev)
      },
    },
  ])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Dedicated presenter window — skip all canvas / video chrome, render
  // only the overlay full-screen. Navigation still works (keyboard) and
  // broadcasts back to the main window.
  if (isPresenterWindow) {
    return (
      <div
        className="fixed inset-0 bg-black"
        role="application"
        aria-label="Presenter view — synced with the main present window"
      >
        <PresenterOverlay activeSlideId={activeSlideId} visible={true} fullscreen />
      </div>
    )
  }

  const { media } = preparation
  const mediaShare = media.total > 0 ? (media.completed + media.errored) / media.total : 1
  const slideShare =
    preparation.slides.planned > 0 ? preparation.slides.prepared / preparation.slides.planned : 0
  const progressShare =
    preparation.phase === 'loading'
      ? 0
      : preparation.phase === 'media'
        ? mediaShare / 2
        : 0.5 + slideShare / 2

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 flex flex-col bg-black"
      role="application"
      aria-label="Presentation — press Escape to return to editor, N to toggle presenter view"
    >
      {/*
        Slide area: flex-1 so it yields space to the presenter overlay below.
        Slide wrapper: pevný CSS size 1920×1080, škálován CSS transformací.
        transform-origin: center center (default) → správné centrování.
        pointer-events: none → žádná interakce na canvas.
        Video overlays have pointer-events: auto (set by OverlayCompositor per element).
      */}
      <div ref={slideAreaRef} className="relative flex min-h-0 flex-1 items-center justify-center">
        <div
          ref={slideContainerRef}
          // flex-shrink-0 is critical: the parent slideArea is flex-row
          // by default, and a flex item with explicit width:1920 still
          // shrinks to fit the parent on viewports narrower than 1920.
          // The shrink kicks in BEFORE the CSS scale transform runs, so
          // the slide ended up 1280×1080 (viewport-clamped) layout size,
          // breaking aspect ratio + the scale-to-fit math + hyperlink
          // hit-test (which divides clientX by rect.width).
          className={[
            'relative flex-shrink-0',
            showPreloadOverlay ? 'opacity-40' : '',
            'transition-opacity duration-300',
          ].join(' ')}
          style={{
            width: SLIDE_WIDTH,
            height: SLIDE_HEIGHT,
            transform: `scale(${scale})`,
            transformOrigin: 'center center',
          }}
          data-testid="slide-container"
          /* Which slide is on screen. Present mode renders no slides panel, so
             this is the only place the current slide is legible from the DOM. */
          data-active-slide-id={activeSlideId ?? undefined}
          /* Whether the presentation is prepared (renderer/presentSlides.ts). */
          data-present-ready={ready ? 'true' : 'false'}
        >
          {/* Canvas itself is pointer-events:none. Pixi's garbage collector
              is off: what is prepared stays until the ResourceManager says. */}
          <div className="pointer-events-none absolute inset-0">
            <Canvas
              onReady={onCanvasReady}
              artboardSize={{ width: SLIDE_WIDTH, height: SLIDE_HEIGHT }}
              gc={false}
            />
          </div>

          {/* Video DOM overlays — slide-space positioned, no compositor.
              Same component as editor; mode='present' plays the video the
              preparation buffered (renderer/presentVideos.ts). */}
          <PresentVideosContext value={videos}>
            {videoObjects.map((vidObj) => (
              <EditorVideoPreview
                key={`present-video-${vidObj.id}`}
                videoObject={vidObj}
                mode="present"
              />
            ))}
          </PresentVideosContext>
        </div>

        {/* M12: Preload overlay */}
        {showPreloadOverlay && (
          <div
            role="status"
            aria-label="Preparing presentation"
            className="absolute inset-0 flex flex-col items-center justify-center z-50 pointer-events-none"
          >
            <div className="rounded-2xl bg-gray-900/95 shadow-2xl px-8 py-6 flex flex-col gap-4 w-80 pointer-events-auto">
              <p className="text-sm font-semibold text-gray-100 text-center">
                Preparing presentation…
              </p>

              {/* Progress bar */}
              <div className="flex flex-col gap-1.5">
                <div
                  className="h-2 w-full rounded-full bg-gray-700 overflow-hidden"
                  role="progressbar"
                  aria-valuenow={Math.round(progressShare * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${Math.round(progressShare * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-gray-400 text-center tabular-nums">
                  {preparation.phase === 'loading'
                    ? 'Loading the deck…'
                    : preparation.phase === 'media'
                      ? `${media.completed + media.errored} / ${media.total} media items`
                      : `${preparation.slides.prepared} / ${preparation.slides.planned} slides ready`}
                  {media.errored > 0 && (
                    <span className="text-yellow-500 ml-1">({media.errored} failed)</span>
                  )}
                </p>
              </div>

              <button
                type="button"
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                onClick={skipPreparation}
              >
                Skip and present now
              </button>
            </div>
          </div>
        )}

        {/* Slide counter — skipped slides are excluded from both the
            running index and the total (P3). */}
        <div
          className="absolute bottom-4 right-4 select-none text-xs text-white/40"
          aria-hidden="true"
        >
          {(() => {
            const presentable = slides.filter((s) => s.skipped !== true)
            if (presentable.length === 0) return '1 / 1'
            const activeIdx = presentable.findIndex((s) => s.id === activeSlideId)
            return `${Math.max(1, activeIdx + 1)} / ${presentable.length}`
          })()}
        </div>

        {/* Escape / presenter hint + pop-out */}
        <div className="absolute bottom-4 left-4 flex items-center gap-3">
          <span className="select-none text-xs text-white/30" aria-hidden="true">
            Esc — back to editor · N — presenter view
          </span>
          <button
            type="button"
            onClick={openPresenterWindow}
            className="rounded border border-white/20 px-2 py-0.5 text-xs text-white/60 hover:border-white/40 hover:text-white"
            title="Open presenter view in a separate window"
            aria-label="Open presenter view in a separate window"
          >
            Pop out
          </button>
          <PresentDisplayPicker />
        </div>
      </div>

      {/* M19 phase 3: presenter overlay — toggled by 'N'. Its slide pictures
          are rendered during the preparation, shown or not. */}
      <PresenterOverlay
        activeSlideId={activeSlideId}
        visible={presenterVisible}
        onThumbnails={onThumbnails}
      />

      {/* P9: Keyboard shortcuts cheatsheet — triggered by Mod+/ */}
      <ShortcutsCheatsheet open={cheatsheetOpen} onClose={() => setCheatsheetOpen(false)} />
    </div>
  )
}
