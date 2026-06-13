/**
 * components/PresentLayout.tsx
 *
 * M5: Present mode fullscreen shell.
 * M6: Animation runtime integration.
 * M9: Slide navigation.
 * M12: Media preloading pipeline + VideoOverlay for progressive MP4 playback.
 *
 * Preload flow (M12):
 *   1. On mount, start media preload for all slides.
 *   2. Full-screen "Preparing presentation…" overlay with progress bar while preloading.
 *   3. After preload completes (or 30 s timeout), dismiss overlay and show slide.
 *   4. User can press Esc at any time to abort preload and return to editor.
 *
 * VideoOverlay (M12):
 *   For each VideoObject on the active slide, a VideoOverlay component is rendered.
 *   VideoOverlay uses OverlayCompositor to position a DOM <video> element (sourced
 *   from the progressive MP4) over the Pixi canvas at the correct world coordinates.
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

import { useRef, useState, useCallback, useEffect } from 'react'
import { useShortcuts } from '../state/useShortcuts.js'
import { ShortcutsCheatsheet } from '../ui/ShortcutsCheatsheet.js'
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
import { getDefaultRenderScheduler } from '../renderer/RenderScheduler'
import { createClickInputBridge } from '@narrative/animation'
import { createPixiTargetResolver } from '../animation/targetResolver.js'
import { EditorVideoPreview } from '../ui/EditorVideoPreview.js'
import { PresenterOverlay } from '../ui/PresenterOverlay.js'
import type { AnimationRuntime } from '@narrative/animation'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'
import type { VideoObject } from '@narrative/shared'
import { sanitizeHref } from '@narrative/shared'

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

  // Animation runtime ref — imperative, mimo React render cycle
  const runtimeRef = useRef<AnimationRuntime | null>(null)

  // Canvas instance z DeckShell context (null dokud Pixi neinicializuje)
  const canvasInstance = useCanvasInstance()

  // Animations snapshot z Y.Doc.
  // M16 P8 — present mode runs the SAME merged step list as the editor
  // timeline. Slide-native steps + per-instance master steps with target
  // ids re-mapped to the per-instance Pixi child container. Single
  // source of truth → no parity drift between edit and play.
  const { animations } = useAnimations()

  // M9: slide list + active slide for navigation
  const slides = useSlides()
  const { activeSlideId, setActiveSlideId } = useActiveSlide()

  // M12: active slide objects for VideoOverlay
  const { objects } = useSlideObjects()
  const videoObjects = objects.filter((o): o is VideoObject => o.type === 'video')

  // P11: keep the latest objects snapshot in a ref so the click-capture
  // hyperlink interceptor (installed once) reads the up-to-date list
  // without re-binding the listener each render.
  const objectsRef = useRef(objects)
  useEffect(() => {
    objectsRef.current = objects
  }, [objects])

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

    // P12b: onTick wakes the render scheduler so GSAP-driven Pixi state
    // actually paints under autoStart:false.
    const scheduler = getDefaultRenderScheduler()
    const runtime = createAnimationRuntime(animations, {
      targetResolver: resolver,
      inputBridge,
      ...(scheduler !== null ? { onTick: () => scheduler.markDirty() } : {}),
    })
    runtimeRef.current = runtime
    runtime.play()

    return () => {
      runtime.destroy()
      runtimeRef.current = null
      // Release the document.body click listener installed by
      // createClickInputBridge. Without this, every entry into present mode
      // leaks a click handler that lives until the page reloads.
      inputBridge.dispose?.()
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

      // P3: skip slides flagged with `skipped` — advance past them in the
      // requested direction until we find a presentable slide or fall off
      // the end.
      const step = direction === 'next' ? 1 : -1
      let targetIdx = currentIdx + step
      while (targetIdx >= 0 && targetIdx < slides.length) {
        const candidate = slides[targetIdx]
        if (candidate !== undefined && candidate.skipped !== true) break
        targetIdx += step
      }
      if (targetIdx < 0 || targetIdx >= slides.length) return

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
        // BG2: feed the incoming background into the transition so it
        // animates together with the slide's objects. Without this, the
        // outgoing slide's background remains painted while objects
        // fade / slide, then the new background snaps in only after
        // adoptSlideRoot runs — visually jarring.
        ...(targetSlide.background !== undefined
          ? { incomingBackground: targetSlide.background }
          : {}),
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
          if (link.slideId !== '') setActiveSlideId(link.slideId)
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
  }, [setActiveSlideId])

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
      description: 'Next slide',
      handler: () => {
        navigateToSlide('next')
      },
    },
    {
      keys: ['ArrowLeft', 'PageUp'],
      scope: 'global',
      preventDefault: true,
      description: 'Previous slide',
      handler: () => {
        navigateToSlide('prev')
      },
    },
    {
      keys: ['f', 'F11'],
      scope: 'global',
      preventDefault: true,
      description: 'Toggle fullscreen',
      handler: () => {
        void toggleFullscreen()
      },
    },
    {
      keys: ['n', 'N'],
      scope: 'global',
      preventDefault: true,
      description: 'Toggle presenter view',
      handler: () => {
        setPresenterVisible((v) => !v)
      },
    },
    {
      keys: 'Mod+/',
      scope: 'global',
      preventDefault: true,
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
        >
          {/* Canvas itself is pointer-events:none */}
          <div className="pointer-events-none absolute inset-0">
            <Canvas
              onReady={onCanvasReady}
              artboardSize={{ width: SLIDE_WIDTH, height: SLIDE_HEIGHT }}
            />
          </div>

          {/* Video DOM overlays — slide-space positioned, no compositor.
              Same component as editor; mode='present' enables autoplay +
              volume + click-to-toggle. */}
          {videoObjects.map((vidObj) => (
            <EditorVideoPreview
              key={`present-video-${vidObj.id}`}
              videoObject={vidObj}
              mode="present"
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
        </div>
      </div>

      {/* M19 phase 3: presenter overlay — toggled by 'N' */}
      <PresenterOverlay activeSlideId={activeSlideId} visible={presenterVisible} />

      {/* P9: Keyboard shortcuts cheatsheet — triggered by Mod+/ */}
      <ShortcutsCheatsheet open={cheatsheetOpen} onClose={() => setCheatsheetOpen(false)} />
    </div>
  )
}
