/**
 * components/PresentLayout.tsx
 *
 * M5: Present mode fullscreen shell.
 * M6: Animation runtime integration.
 * M9: Slide navigation.
 * M12: Media preloading pipeline + VideoOverlay for HLS playback.
 *
 * Preload flow (M12):
 *   1. On mount, start media preload for all slides.
 *   2. Full-screen "Preparing presentation…" overlay with progress bar while preloading.
 *   3. After preload completes (or 30 s timeout), dismiss overlay and show slide.
 *   4. User can press Esc at any time to abort preload and return to editor.
 *
 * VideoOverlay (M12):
 *   For each VideoObject on the active slide, a VideoOverlay component is rendered.
 *   VideoOverlay uses hls.js + OverlayCompositor to position a DOM <video> element
 *   over the Pixi canvas at the correct world coordinates.
 *
 * Architecture:
 * - Žádný toolbar, sidebar, inspector — čistý fullscreen render.
 * - Canvas komponenta (sdílený renderer pipeline) je umístěna v centered
 *   slide-sized kontejneru. CSS transform: scale() aplikuje scale-to-fit.
 * - Pixi canvas má fyzický CSS size SLIDE_WIDTH × SLIDE_HEIGHT (1920×1080)
 *   a ResizeObserver na viewport počítá scale = min(vw/sw, vh/sh).
 * - Žádné pointer listeners → canvas je read-only (pointer-events:none).
 * - Keyboard: Escape → editor, Arrow/Space/Page → slide navigation.
 * - Fullscreen API: klávesa F nebo F11.
 *
 * Accessibility:
 * - role="application" s aria-label pro screen reader context.
 * - Subtle escape hint v rohu (aria-hidden).
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Canvas } from '../renderer/Canvas.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from '../renderer/constants.js'
import { playTransition } from '../renderer/playTransition.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useAnimations } from '../state/useAnimations.js'
import { useSlides } from '../state/useSlides.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useMediaPreload } from '../state/useMediaPreload.js'
import { createAnimationRuntime } from '@narrative/animation'
import { createClickInputBridge } from '@narrative/animation'
import { createPixiTargetResolver } from '../animation/targetResolver.js'
import { VideoOverlay } from '../ui/VideoOverlay.js'
import { PresenterOverlay } from '../ui/PresenterOverlay.js'
import type { AnimationRuntime } from '@narrative/animation'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import type { VideoObject } from '@narrative/shared'

/** Vypočte scale-to-fit pro slide do daného viewportu při zachování aspect ratio. */
function computeScale(viewportW: number, viewportH: number): number {
  if (viewportW <= 0 || viewportH <= 0) return 1
  return Math.min(viewportW / SLIDE_WIDTH, viewportH / SLIDE_HEIGHT)
}

const PRELOAD_TIMEOUT_MS = 30_000

export interface PresentLayoutProps {
  /**
   * Callback předaný do Canvas.onReady — signalizuje že Pixi je ready.
   * DeckPresent získá z DeckShell přes useOutletContext a pasuje sem.
   */
  onCanvasReady?: ((instance: CanvasInstance) => void) | undefined
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
  const [scale, setScale] = useState<number>(() =>
    computeScale(window.innerWidth, window.innerHeight),
  )

  // Animation runtime ref — imperative, mimo React render cycle
  const runtimeRef = useRef<AnimationRuntime | null>(null)

  // Canvas instance z DeckShell context (null dokud Pixi neinicializuje)
  const canvasInstance = useCanvasInstance()

  // Animations snapshot z Y.Doc
  const { animations } = useAnimations()

  // M9: slide list + active slide for navigation
  const slides = useSlides()
  const { activeSlideId, setActiveSlideId } = useActiveSlide()

  // M12: active slide objects for VideoOverlay
  const { objects } = useSlideObjects()
  const videoObjects = objects.filter((o): o is VideoObject => o.type === 'video')

  // M12: Media preload
  const { start: startPreload, progress: preloadProgress, isPreloading } = useMediaPreload()
  const [preloadDismissed, setPreloadDismissed] = useState(false)
  const preloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showPreloadOverlay = isPreloading && !preloadDismissed

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

  // ---------------------------------------------------------------------------
  // M12: Start preload on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (slides.length === 0) return

    void startPreload(slides)

    // Fail-safe: dismiss overlay after 30 s regardless of preload state
    preloadTimeoutRef.current = setTimeout(() => {
      setPreloadDismissed(true)
    }, PRELOAD_TIMEOUT_MS)

    return () => {
      if (preloadTimeoutRef.current !== null) {
        clearTimeout(preloadTimeoutRef.current)
        preloadTimeoutRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, [])

  // Auto-dismiss when preload finishes
  useEffect(() => {
    if (preloadProgress.isDone && !preloadDismissed) {
      setPreloadDismissed(true)
    }
  }, [preloadProgress.isDone, preloadDismissed])

  // ---------------------------------------------------------------------------
  // Fullscreen API toggle
  // ---------------------------------------------------------------------------

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement === null) {
      try {
        await document.documentElement.requestFullscreen()
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
  // Animation runtime lifecycle
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Počkáme dokud Pixi není ready
    if (canvasInstance === null) return
    // Pokud nejsou žádné animace, runtime nevytvářej
    if (animations.length === 0) return

    const resolver = createPixiTargetResolver(canvasInstance.sceneGraph)
    const inputBridge = createClickInputBridge(document.body)

    const runtime = createAnimationRuntime(animations, {
      targetResolver: resolver,
      inputBridge,
    })
    runtimeRef.current = runtime
    runtime.play()

    return () => {
      runtime.destroy()
      runtimeRef.current = null
    }
  }, [canvasInstance, animations])

  // ---------------------------------------------------------------------------
  // M9: Slide navigation helpers
  // ---------------------------------------------------------------------------

  // M13: Transition-aware navigation. If the target slide defines a
  // non-trivial transition, mount it via playTransition() before swapping
  // activeSlideId so React state matches the already-painted new scene.
  //
  // Spam-press semantics: if the user hits ArrowRight again while a
  // transition is mid-flight we abort it and snap instantly to the slide
  // one past the aborted transition's target. That turns "five fast
  // ArrowRight presses while animating" into "skip all animations and
  // land five slides ahead" — matches Keynote-style presenter behaviour.
  const transitionInFlightRef = useRef<{ abort(): void; targetId: string } | null>(null)

  const navigateToSlide = useCallback(
    (direction: 'next' | 'prev') => {
      if (slides.length === 0) return

      // If a transition is already running, abort it and jump straight to
      // the slide one step beyond its target — no animation.
      if (transitionInFlightRef.current !== null) {
        const runningTargetId = transitionInFlightRef.current.targetId
        transitionInFlightRef.current.abort()
        transitionInFlightRef.current = null

        const runningIdx = slides.findIndex((s) => s.id === runningTargetId)
        if (runningIdx === -1) return
        const jumpIdx = direction === 'next' ? runningIdx + 1 : runningIdx - 1
        const clampedIdx = Math.max(0, Math.min(jumpIdx, slides.length - 1))
        const landing = slides[clampedIdx]
        if (landing !== undefined) setActiveSlideId(landing.id)
        return
      }

      const currentIdx = slides.findIndex((s) => s.id === activeSlideId)
      if (currentIdx === -1) return

      let targetIdx: number
      if (direction === 'next') {
        if (currentIdx >= slides.length - 1) return // boundary — no wrap
        targetIdx = currentIdx + 1
      } else {
        if (currentIdx <= 0) return // boundary — no wrap
        targetIdx = currentIdx - 1
      }

      const targetSlide = slides[targetIdx]
      if (targetSlide === undefined) return

      const incomingTransition = targetSlide.transition
      const useTransition =
        canvasInstance !== null &&
        incomingTransition.kind !== 'none' &&
        incomingTransition.durationMs > 0

      if (!useTransition) {
        setActiveSlideId(targetSlide.id)
        return
      }

      const handle = playTransition({
        sceneGraph: canvasInstance!.sceneGraph,
        incomingObjects: targetSlide.objects,
        transition: incomingTransition,
      })
      transitionInFlightRef.current = {
        abort: handle.abort,
        targetId: targetSlide.id,
      }

      handle.done.finally(() => {
        // If a spam-press already aborted and nulled the ref (swapping us
        // past this target), leave React state alone — that branch already
        // called setActiveSlideId to the further landing slide.
        if (transitionInFlightRef.current?.targetId === targetSlide.id) {
          transitionInFlightRef.current = null
          setActiveSlideId(targetSlide.id)
        }
      })
    },
    [slides, activeSlideId, setActiveSlideId, canvasInstance],
  )

  // Mirror navigateToSlide into a ref so the one-time BroadcastChannel
  // listener below can call the latest closure without re-installing.
  const navigateToSlideRef = useRef(navigateToSlide)
  useEffect(() => {
    navigateToSlideRef.current = navigateToSlide
  }, [navigateToSlide])

  // BroadcastChannel setup — installed once per deck id. Receiver computes
  // direction by comparing the current activeSlideId to the incoming id:
  // an adjacent jump runs through navigateToSlide (plays transitions, plays
  // in-slide animations on arrival); non-adjacent multi-step jumps fall
  // back to a direct setActiveSlideId because there's no good transition to
  // play through multiple slides.
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
      if (currentIdx !== -1 && targetIdx === currentIdx + 1) {
        navigateToSlideRef.current('next')
      } else if (currentIdx !== -1 && targetIdx === currentIdx - 1) {
        navigateToSlideRef.current('prev')
      } else {
        // Non-adjacent jump — direct set, no transition.
        setActiveSlideId(slideId)
      }
    }
    return () => {
      channel.close()
      bcRef.current = null
    }
  }, [id, setActiveSlideId])

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
  // Keyboard handling
  // ---------------------------------------------------------------------------

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      switch (e.key) {
        case 'Escape':
          e.preventDefault()
          // Abort preload overlay and navigate back to editor
          setPreloadDismissed(true)
          navigate(`/deck/${id ?? ''}`)
          break

        case 'ArrowRight':
        case ' ':
        case 'PageDown':
          e.preventDefault()
          navigateToSlide('next')
          break

        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault()
          navigateToSlide('prev')
          break

        case 'f':
        case 'F11':
          e.preventDefault()
          void toggleFullscreen()
          break

        case 'n':
        case 'N':
          e.preventDefault()
          setPresenterVisible((v) => !v)
          break

        default:
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [id, navigate, toggleFullscreen, navigateToSlide])

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
          className={[
            'relative',
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
        >
          {/* Canvas itself is pointer-events:none */}
          <div className="pointer-events-none absolute inset-0">
            <Canvas onReady={onCanvasReady} />
          </div>

          {/* Video DOM overlays — one per VideoObject on active slide */}
          {canvasInstance !== null &&
            videoObjects.map((vidObj) => (
              <VideoOverlay
                key={vidObj.id}
                videoObject={vidObj}
                sceneGraph={canvasInstance.sceneGraph}
                compositor={canvasInstance.compositor}
              />
            ))}
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
                  aria-valuenow={preloadProgress.total > 0 ? preloadProgress.completed : 0}
                  aria-valuemin={0}
                  aria-valuemax={preloadProgress.total}
                >
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all duration-300"
                    style={{
                      width:
                        preloadProgress.total > 0
                          ? `${Math.round((preloadProgress.completed / preloadProgress.total) * 100)}%`
                          : '0%',
                    }}
                  />
                </div>
                <p className="text-xs text-gray-400 text-center tabular-nums">
                  {preloadProgress.total > 0
                    ? `${preloadProgress.completed} / ${preloadProgress.total} media items`
                    : 'Scanning media…'}
                  {preloadProgress.errored > 0 && (
                    <span className="text-yellow-500 ml-1">({preloadProgress.errored} failed)</span>
                  )}
                </p>
              </div>

              <button
                type="button"
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                onClick={() => setPreloadDismissed(true)}
              >
                Skip and present now
              </button>
            </div>
          </div>
        )}

        {/* Slide counter — real index/count (M9) */}
        <div
          className="absolute bottom-4 right-4 select-none text-xs text-white/40"
          aria-hidden="true"
        >
          {slides.length > 0
            ? `${Math.max(1, slides.findIndex((s) => s.id === activeSlideId) + 1)} / ${slides.length}`
            : '1 / 1'}
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
        </div>
      </div>

      {/* M19 phase 3: presenter overlay — toggled by 'N' */}
      <PresenterOverlay activeSlideId={activeSlideId} visible={presenterVisible} />
    </div>
  )
}
