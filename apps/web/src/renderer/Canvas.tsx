/**
 * renderer/Canvas.tsx
 *
 * React komponenta — mount/unmount Pixi Application.
 * Compositor is exposed via CanvasInstanceContext.
 */

// Pixi generates shader/uniform sync code with `new Function`, which the
// production CSP (`script-src 'self'`, no `unsafe-eval`) blocks — the renderer
// then throws "Current environment does not allow unsafe-eval" during
// `app.init()` and the canvas stays empty. This side-effect import swaps that
// codegen for Pixi's official eval-free polyfills. It MUST be evaluated before
// any `Application` is constructed, hence the module-level import here.
// Dev has no CSP, so this only ever mattered in prod.
import 'pixi.js/unsafe-eval'
import { useEffect, useRef, useState } from 'react'
import { Application, TextureSource } from 'pixi.js'

// Enable mipmaps globally so large images (e.g. 4267×3200 imported logos)
// downscale smoothly instead of showing aliased staircase edges. Without
// mipmaps, Pixi's bilinear filtering samples only 4 texels per pixel
// which isn't enough for significant downscaling.
TextureSource.defaultOptions.autoGenerateMipmaps = true
import { SceneGraph } from './SceneGraph'
import { ResourceManager, setDefaultResourceManager } from './ResourceManager'
import { OverlayCompositor } from './overlay/OverlayCompositor'
import { RenderScheduler, setDefaultRenderScheduler } from './RenderScheduler'
import { installPixiBindGroupPatch } from './pixiBindGroupPatch.js'
import { patchHTMLTextRace } from './patchHTMLTextRace.js'
import { destroyPixiApplication } from './pixiApplication.js'

// Install the BindGroup crash workaround once at module load. See the
// patch file for the full Pixi v8 bug writeup.
installPixiBindGroupPatch()
import {
  createImageUrlResolver,
  setDefaultImageUrlResolver,
  getDefaultImageUrlResolver,
} from './imageUrl.js'
import { createVideoInfoResolver, setDefaultVideoInfoResolver } from './videoInfo.js'
import { useSlideObjectChanges } from '../state/useSlideObjectChanges'
import { useSlideBackground } from '../state/useSlideBackground.js'
import { useSlides } from '../state/useSlides.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { computeSlideNumber } from '@narrative/shared'
import { setRenderingSlideNumber } from './slideNumberContext.js'
import { applyBackground } from './ArtboardBackground.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from './constants.js'
import { disposeComponentDocCache } from '../state/componentDocCache.js'
import { markFirstPaint, markPixiReady } from '../state/loadTimings.js'
import type { ObjectChangeSet } from '@narrative/slide-model'
import type { CanvasInstance } from './CanvasInstanceContext.js'

export interface CanvasProps {
  /**
   * Callback volaný po úspěšném inicializaci Pixi (async).
   * Při unmount volán s null pro signalizaci cleanup — consumers (DeckShell)
   * musí vynulovat svůj canvasInstance state, aby stálé konzumery (VideoOverlay)
   * neměly referenci na zničený SceneGraph/Compositor.
   */
  onReady?: ((instance: CanvasInstance | null) => void) | undefined
  /**
   * P2: pixel margin added around the artboard. The Pixi canvas renders
   * into artboard+bleed so objects dragged outside remain visible. Slide
   * (0,0) is kept aligned to the artboard top-left via SceneGraph origin.
   * Default 0 → legacy tight-to-artboard behaviour.
   */
  bleedPx?: number
  /**
   * P2: artboard CSS size. Drives background paint size + out-of-bounds
   * fade. If omitted, falls back to the legacy nominal 1920×1080.
   */
  artboardSize?: { width: number; height: number }
  /**
   * Current editor zoom level. Drives dynamic renderer resolution so
   * the canvas renders enough backing pixels for the CSS
   * transform:scale(zoom) applied by EditorLayout — without this,
   * zoom > 1 upscales fixed-resolution pixels and everything looks
   * blurry. Resolution is capped at 4× to bound GPU memory.
   */
  zoom?: number
}

export function Canvas({ onReady, bleedPx = 0, artboardSize, zoom = 1 }: CanvasProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRootRef = useRef<HTMLDivElement>(null)

  /** Pending changes from before Pixi is ready. Buffer and flush once instance exists. */
  const pendingChangesRef = useRef<ObjectChangeSet[]>([])

  /**
   * Always points at the latest artboardSize so the async Pixi init can
   * push bounds to SceneGraph the moment it becomes available — the
   * `artboardSize`-driven useEffect below can't do that alone because
   * instanceRef is null on first render.
   */
  const artboardSizeRef = useRef(artboardSize)
  artboardSizeRef.current = artboardSize

  /**
   * Ref guard pro StrictMode double-mount safety.
   * Drží reference na živé instance napříč efektem.
   */
  const instanceRef = useRef<{
    app: Application
    sceneGraph: SceneGraph
    resourceManager: ResourceManager
    compositor: OverlayCompositor
    scheduler: RenderScheduler
  } | null>(null)

  /**
   * State flag mirroring instanceRef's "Pixi initialised" moment so the
   * background-paint / bounds effects can re-run the first time Pixi
   * becomes available (instanceRef alone doesn't trigger React updates).
   */
  const [pixiReady, setPixiReady] = useState(false)

  // Efekt pro mount/unmount Pixi Application
  useEffect(() => {
    const containerEl = containerRef.current
    const overlayRootEl = overlayRootRef.current
    if (containerEl === null || overlayRootEl === null) return

    // StrictMode guard: pokud instance již existuje, skip
    if (instanceRef.current !== null) return

    // Install default image / video URL resolvers. Auth is carried by the
    // narrative_session HttpOnly cookie via fetch credentials, no token
    // plumbing needed.
    const apiBase = (import.meta.env['VITE_API_URL'] as string | undefined) ?? ''
    setDefaultImageUrlResolver(createImageUrlResolver(apiBase))
    setDefaultVideoInfoResolver(createVideoInfoResolver(apiBase))

    let cancelled = false
    let app: Application | null = null
    const resourceManager = new ResourceManager()

    // Install default ResourceManager so imageRenderer can acquire/release textures.
    setDefaultResourceManager(resourceManager)

    const initPixi = async () => {
      app = new Application()

      await app.init({
        resizeTo: containerEl,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        backgroundAlpha: 0,
        // P12b: don't run Pixi's built-in 60 Hz auto-render loop. The
        // RenderScheduler below schedules a single rAF render whenever
        // the scene mutates, so an idle editor uses ~0% GPU instead of
        // ~30%. Animation playback re-enables the ticker through
        // `app.ticker.start()` for the duration of the timeline.
        autoStart: false,
        // Pixi v8 WebGPU BindGroupSystem intermittently null-derefs on the
        // first render tick when a Graphics instance has a texture-based
        // fill (image fill, canvas-built gradient fill) — see console
        // crash: `BindGroupSystem._createBindGroup → reading '2'` inside
        // GpuGraphicsAdaptor.execute. The WebGL2 renderer path is stable,
        // the feature set we use (Graphics fills + textures + filters) is
        // fully covered, and the perf win from WebGPU isn't worth the
        // reliability hit on a creative tool. Revisit when we upgrade past
        // pixi.js 8.18.x.
        preference: 'webgl',
        antialias: true,
      })

      if (cancelled) {
        // Unmounted while init() ran (in dev: StrictMode's first mount, which
        // can resolve after the second mount has painted). Must not release
        // Pixi's page-wide pools under the live canvas — pixiApplication.ts.
        destroyPixiApplication(app)
        return
      }

      // Userland mitigation for a Pixi v8 WebGL race in
      // HTMLTextSystem._buildTexturePromise — see patchHTMLTextRace
      // for the full breakdown. Without this, duplicate component
      // instances rendering identical text leaves can show each
      // other's content (or a totally unrelated text node's content)
      // for a frame after any rasterise event. Must run AFTER
      // `app.init()` so `app.renderer.htmlText` exists.
      patchHTMLTextRace(app.renderer, { wakeRenderScheduler: true })

      containerEl.appendChild(app.canvas)

      // Pixi v8's EventSystem installs `canvas.oncontextmenu = (e) => e.preventDefault()`
      // by default to suppress the native browser context menu over the
      // canvas. We need contextmenu events to bubble up to Radix's
      // ContextMenuTrigger above the artboard, so wipe Pixi's handler and
      // install one that just preventDefault's the BROWSER menu but lets
      // the event propagate to React.
      app.canvas.oncontextmenu = (e: MouseEvent): void => {
        e.preventDefault()
      }

      const sceneGraph = new SceneGraph(app)
      // P12b: install the render scheduler before any mutations land so
      // the very first applyChanges flush queues a frame.
      const scheduler = new RenderScheduler(app)
      setDefaultRenderScheduler(scheduler)
      sceneGraph.setRenderScheduler(scheduler)
      if (bleedPx !== 0) {
        sceneGraph.setSlideOrigin(bleedPx, bleedPx)
      }
      const initialArtboard = artboardSizeRef.current
      if (
        initialArtboard !== undefined &&
        initialArtboard.width > 0 &&
        initialArtboard.height > 0
      ) {
        sceneGraph.setSlideBounds(initialArtboard.width, initialArtboard.height)
      }

      // OverlayCompositor: DOM overlay sync nad Pixi canvasem.
      // overlayRootEl je sousedící <div> s position:absolute;inset:0;pointer-events:none.
      // Compositor přidá registrované overlay elementy do tohoto divu a synchuje pozice
      // přes Pixi ticker každý frame (DPR-aware, žádný GC churn).
      const compositor = new OverlayCompositor(app, overlayRootEl)
      compositor.setRenderScheduler(scheduler)

      instanceRef.current = { app, sceneGraph, resourceManager, compositor, scheduler }
      markPixiReady()
      setPixiReady(true)

      // E2E hook (P6): expose the live SceneGraph so Playwright specs can
      // assert that the Pixi side is in sync with Y.Doc after layer
      // reorder. Dev-only — stripped from prod bundles.
      if (import.meta.env.DEV) {
        ;(window as unknown as { __narrative_scene_graph?: SceneGraph }).__narrative_scene_graph =
          sceneGraph
      }

      // P12: expose the live Pixi Application + ResourceManager so the
      // perf HUD can sample FPS, draw counts and texture refcounts
      // without prop-drilling through every editor surface. Available
      // in dev and prod — the HUD itself is opt-in (toolbar toggle).
      // Preserve any fields already on `__narrative_perf` (notably the
      // loadTimings that `markDeckLoadStart()` wrote in DeckShell BEFORE
      // Pixi finished initialising). A naive overwrite here clobbered
      // the timings and the HUD showed nothing.
      {
        const w = window as unknown as {
          __narrative_perf?: Record<string, unknown>
        }
        const existing = w.__narrative_perf ?? {}
        w.__narrative_perf = { ...existing, app, resourceManager }
      }

      // Flush pending changes co přišly před initem (např. initial emission
      // z useSlideObjectChanges subscribe synchronně po subscribe).
      for (const pending of pendingChangesRef.current) {
        sceneGraph.applyChanges(pending)
      }
      pendingChangesRef.current = []

      // P12b: with autoStart:false the renderer never paints by itself.
      // Force a single synchronous frame so the editor isn't blank until
      // the first user interaction. SceneGraph's markDirty() calls take
      // over from here.
      scheduler.renderNow()
      markFirstPaint()

      // Informuj konzumenty (DeckShell → CanvasInstanceContext) o dostupné instanci
      onReady?.({ sceneGraph, compositor })

      if (import.meta.env.DEV) {
        console.debug('[Canvas] Pixi initialized, Y.Doc observer active, OverlayCompositor ready')
      }
    }

    void initPixi()

    return () => {
      cancelled = true

      if (instanceRef.current !== null) {
        const {
          app: liveApp,
          sceneGraph: liveGraph,
          resourceManager: liveRM,
          compositor: liveCompositor,
          scheduler: liveScheduler,
        } = instanceRef.current

        // Notify parent first so downstream consumers drop stale references
        // (e.g. VideoOverlay holds sceneGraph/compositor and would leak DOM
        // elements against a torn-down Pixi app otherwise).
        onReady?.(null)

        // Stop the Pixi ticker FIRST so a rAF callback that's already
        // been scheduled for the next frame can't fire against our
        // about-to-be-destroyed scene graph. Fixes the "Cannot read
        // properties of null (reading 'clear')" crash users hit when
        // bouncing quickly between the editor and present mode.
        try {
          liveApp.ticker.stop()
        } catch {
          // App was already destroyed by a concurrent cleanup — safe to ignore.
        }

        // Cancel any pending rAF so it can't fire against torn-down GL state.
        liveScheduler.destroy()
        setDefaultRenderScheduler(null)

        liveGraph.destroy()
        liveRM.destroyAll()
        // M16 P6: tear down all cached component master docs + their WS
        // connections. SceneGraph.destroy above has already destroyed the
        // componentInstance nodes (which release their cache refs), so the
        // linger-timer entries are the only ones still alive — flush them.
        disposeComponentDocCache()
        // Compositor musí být zničen PŘED app.destroy() — potřebuje ticker pro cleanup
        liveCompositor.destroy()
        // Pixi v8's Application.destroy can throw inside the system runner
        // (TexturePool.returnTexture sees a destroyed renderer state) when
        // a HTMLText texture is mid-flight during route navigation —
        // happens reliably on edit→present transitions with a
        // componentInstance on the slide. Swallow so the rest of the
        // editor unmount finishes; the Pixi GL context will be GC'd.
        try {
          destroyPixiApplication(liveApp)
        } catch {
          // Pixi v8 TexturePool race during edit↔present navigation
          // (HTMLText texture mid-flight at SystemRunner emit time).
          // Non-fatal — GL context is GC'd by the browser. Silenced
          // because it fires on every edit→present transition with a
          // componentInstance on stage and is pure noise for QA.
        }

        // Drop the perf HUD's reference so it doesn't sample a torn-down app.
        const w = window as unknown as { __narrative_perf?: unknown }
        if (w.__narrative_perf !== undefined) delete w.__narrative_perf

        instanceRef.current = null
        setPixiReady(false)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // intentional empty deps: mount-only effect with StrictMode guard; onReady stable via parent useCallback

  // Page-number support: keep the renderer's slide-number context aligned
  // with the deck's active slide. Set synchronously during render so that
  // any text node mounted later in this render pass (via useSlideObjectChanges
  // initial emission) sees the correct value when its `buildHtml` reads
  // the global. The follow-up effect refreshes already-mounted text nodes
  // when the value changes (e.g. after a slide reorder where the active
  // slide stays the same).
  const slides = useSlides()
  const { activeSlideId } = useActiveSlide()
  const currentSlideNumber =
    activeSlideId !== null ? computeSlideNumber(slides, activeSlideId) : undefined
  setRenderingSlideNumber(currentSlideNumber)
  useEffect(() => {
    const instance = instanceRef.current
    if (instance === null) return
    instance.sceneGraph.refreshSlideNumberTexts()
  }, [currentSlideNumber, pixiReady])

  // Reaktivita na Y.Doc přes incremental changes (M3).
  // Initial state přichází synchronně jako první emise (added = current).
  // Batching per rAF v subscribeToObjectChanges — tento callback se volá 1× per tick.
  useSlideObjectChanges((changes) => {
    const instance = instanceRef.current
    if (instance === null) {
      // Pixi ještě neinicializován — buffer a flush v init
      pendingChangesRef.current.push(changes)
      return
    }
    instance.sceneGraph.applyChanges(changes)
  })

  // P2: paint the artboard background on every slide-background change.
  // Ensures a background-only Container is mounted as child[0] of the
  // slide root so objects stack above it.
  const background = useSlideBackground()
  useEffect(() => {
    const instance = instanceRef.current
    if (instance === null) return
    const container = instance.sceneGraph.ensureBackgroundContainer()
    const resolver = (() => {
      try {
        return getDefaultImageUrlResolver()
      } catch {
        return null
      }
    })()
    const rm = instance.resourceManager
    const bgWidth =
      artboardSize !== undefined && artboardSize.width > 0 ? artboardSize.width : SLIDE_WIDTH
    const bgHeight =
      artboardSize !== undefined && artboardSize.height > 0 ? artboardSize.height : SLIDE_HEIGHT
    applyBackground({
      container,
      background,
      width: bgWidth,
      height: bgHeight,
      ...(resolver !== null
        ? { resolveAssetUrl: (assetId) => resolver({ assetId, variant: 'display' }) }
        : {}),
      acquireTexture: (url) => rm.acquireTexture(url),
      releaseTexture: (url) => rm.releaseTexture(url),
    })
    // P12b: applyBackground mutates Pixi children synchronously and may
    // also resolve a texture asynchronously. Mark dirty now for the sync
    // path; the async branch posts back through ResourceManager which
    // ends up retriggering this effect on completion.
    instance.scheduler.markDirty()
  }, [background, artboardSize?.width, artboardSize?.height, pixiReady])

  // P2: propagate artboard size to SceneGraph so it can fade out-of-
  // bounds objects.
  useEffect(() => {
    const instance = instanceRef.current
    if (instance === null) return
    if (artboardSize === undefined) return
    if (artboardSize.width <= 0 || artboardSize.height <= 0) return
    instance.sceneGraph.setSlideBounds(artboardSize.width, artboardSize.height)
  }, [artboardSize?.width, artboardSize?.height, pixiReady])

  // Adjust renderer resolution when zoom changes so the canvas
  // renders enough backing pixels for the CSS-scaled display. Without
  // this, zoom > 1 upscales fixed-resolution pixels → blurry text and
  // graphics.
  //
  // Resolution is capped by a pixel budget (25 M pixels ≈ 100 MB
  // VRAM) rather than a fixed multiplier. This keeps the canvas safe
  // on any display/zoom combination — on a 1× DPR display zoom=2
  // gets full sharpness (resolution=2), while a 2× HiDPI display
  // caps at ~2.2× instead of the 4× that would OOM.
  //
  // Debounced by 150 ms so rapid mousewheel zoom only commits the
  // resolution change once after the zoom stabilizes. This avoids
  // Pixi's HTMLTextPipe generatingTexture race where mid-flight
  // rasterizations silently skip new resolution changes.
  useEffect(() => {
    const instance = instanceRef.current
    if (instance === null) return

    const dpr = window.devicePixelRatio || 1
    const container = containerRef.current
    const cw = container?.clientWidth ?? 1
    const ch = container?.clientHeight ?? 1
    const maxPixels = 25_000_000
    const pixelCap = Math.sqrt(maxPixels / (cw * ch))
    const effectiveRes = Math.min(pixelCap, dpr * Math.max(1, zoom))

    const debounceTimer = setTimeout(() => {
      const inst = instanceRef.current
      if (inst === null) return
      const renderer = inst.app.renderer
      if (Math.abs(renderer.resolution - effectiveRes) < 0.01) return
      renderer.resolution = effectiveRes
      if (container !== null && cw > 0 && ch > 0) {
        renderer.resize(cw, ch)
      }
      // Force all HTMLText nodes to re-rasterize at the new resolution.
      // Pixi's async text pipeline + our wireRedrawOnAsyncTextureUpdate
      // don't cover resolution-only changes — this resets each node's
      // GPU cache key and catchup guard so the re-rasterization gets
      // scheduled with follow-up render frames.
      inst.sceneGraph.forceTextResolutionRefresh()
    }, 150)

    return () => clearTimeout(debounceTimer)
  }, [zoom, pixiReady])

  // ResizeObserver — reaguje na změnu velikosti parent kontejneru.
  // Uses clientWidth/clientHeight (CSS-transform-independent) so the
  // resize is correct when the container sits inside a scaled wrapper.
  useEffect(() => {
    const containerEl = containerRef.current
    if (containerEl === null) return

    const observer = new ResizeObserver(() => {
      const instance = instanceRef.current
      if (instance === null) return

      const width = containerEl.clientWidth
      const height = containerEl.clientHeight
      if (width > 0 && height > 0) {
        instance.app.renderer.resize(width, height)
      }
    })

    observer.observe(containerEl)
    return () => observer.disconnect()
  }, [])

  // Re-paint whenever the page becomes user-visible again. Two ways to get
  // here, both of which leave a blank or half-drawn canvas:
  //
  //   - the tab was backgrounded (browsers discard the WebGL backbuffer to
  //     save memory, and with autoStart:false nothing re-paints on its own);
  //   - the page came back from the bfcache, where Pixi never re-initialises
  //     so there is no `renderNow()` first paint at all.
  //
  // `renderNow()` rather than `markDirty()` on purpose. A hidden tab gets no
  // animation frames, so any `markDirty()` issued while it was hidden — the
  // deck's own content arriving over the WebSocket, typically — leaves a
  // handle pending; `markDirty()` early-returns while one is, and would
  // therefore do nothing at exactly the moment a repaint is needed.
  // `renderNow()` cancels that stalled frame and paints synchronously.
  useEffect(() => {
    const repaint = (): void => {
      if (document.hidden) return
      instanceRef.current?.scheduler.renderNow()
    }
    const onPageShow = (e: PageTransitionEvent): void => {
      if (e.persisted) repaint()
    }
    document.addEventListener('visibilitychange', repaint)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', repaint)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])

  return (
    // Wrapper je position:relative aby overlayRoot byl správně umístěn.
    // overflow:visible povolen aby bleed canvas/overlay vyčnívaly mimo
    // artboard a objekty dragnuté mimo slide zůstaly vidět.
    <div style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
      {/* Canvas container — Pixi appenduje canvas sem. Při bleedPx>0 se
          roztahuje o bleedPx na každou stranu nad rámec artboardu. */}
      <div
        ref={containerRef}
        style={{
          position: 'absolute',
          inset: bleedPx !== 0 ? `-${bleedPx}px` : 0,
          pointerEvents: 'none',
        }}
        aria-label="Presentation canvas"
      />
      {/* Overlay root — DOM elementy nad canvasem, synchronizovány OverlayCompositor */}
      <div
        ref={overlayRootRef}
        style={{
          position: 'absolute',
          inset: bleedPx !== 0 ? `-${bleedPx}px` : 0,
          pointerEvents: 'none',
          // overflow:hidden aby overlay elementy nevyčnívaly mimo canvas area
          overflow: 'hidden',
        }}
        aria-hidden="true"
      />
    </div>
  )
}
