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
import { API_BASE } from '../lib/endpoints.js'
import 'pixi.js/unsafe-eval'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { pendingRenderWork } from './renderWork.js'
import {
  adaptiveUploadBudget,
  pixiUploadTarget,
  stageLocator,
  TextureUploadGate,
} from './textureUploadGate.js'
import { installPixiBindGroupPatch } from './pixiBindGroupPatch.js'
import { releaseOwnedGraphicsContexts } from './graphicsContextRelease.js'
import { patchHTMLTextRace } from './patchHTMLTextRace.js'
import { installRunText, type RunTextMipmaps } from './runText/runTextSystem.js'
import { CanvasRegionController } from './canvasRegionController.js'
import type { ResolutionMargin } from './textResolutionStaging.js'
import { holdPlacementRepaints } from './runText/placement.js'
import { watchDevicePixelRatio } from './devicePixelRatioWatch.js'
import { renderStage } from './stageRender.js'
import { registerPerfCanvas, whenPerfHarnessReady } from '../perf/activation.js'
import { destroyPixiApplication } from './pixiApplication.js'
import { limitBatchTextures } from './batchTextures.js'

// Install the BindGroup crash workaround once at module load. See the
// patch file for the full Pixi v8 bug writeup.
installPixiBindGroupPatch()
import {
  createImageUrlResolver,
  setDefaultImageUrlResolver,
  getDefaultImageUrlResolver,
} from './imageUrl.js'
import { createVideoInfoResolver, setDefaultVideoInfoResolver } from './videoInfo.js'
import { useSlideObjectChanges, type SlideObjectChangeInfo } from '../state/useSlideObjectChanges'
import { useSlideBackground } from '../state/useSlideBackground.js'
import { useDeckSelector, useDeckStore } from '../state/useDeckStore.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { computeSlideNumber } from '@narrative/shared'
import { setRenderingSlideNumber } from './slideNumberContext.js'
import { setRenderingSurface } from './colourResolver.js'
import { applyBackground } from './ArtboardBackground.js'
import { deckPictureAssetIds } from './deckPictures.js'
import { scaledUpObjectIds } from './imageVariant.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from './constants.js'
import { disposeComponentDocCache } from '../state/componentDocCache.js'
import { markFirstPaint, markPixiReady } from '../state/loadTimings.js'
import type { ObjectChangeSet } from '@narrative/slide-model'
import type { CanvasInstance } from './CanvasInstanceContext.js'
import { whenIdle } from './textResolutionStaging.js'

/**
 * A zoom commits once neither the zoom nor wheel / pinch input changed for
 * this long. Was 150 ms after the last zoom change; on a busy main thread
 * the steps of one wheel gesture arrived up to ~150 ms apart (M3 Pro at
 * load 20–40, 2026-10-18), and a commit between two of them — 100+ ms of
 * backbuffer reallocation, then every text re-rasterised — landed in the
 * middle of the gesture, for a resolution the next step replaced.
 */
const ZOOM_COMMIT_QUIET_MS = 300

export interface CanvasProps {
  /**
   * Called once Pixi has initialised (async). Called with null on unmount:
   * consumers (DeckShell) must clear their canvasInstance state, so that
   * long-lived consumers (VideoOverlay) keep no reference to a destroyed
   * SceneGraph / compositor.
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
  /**
   * false: nothing is drawn on screen — the canvas stays 1×1 and every
   * frame costs next to nothing, while the scene is complete for
   * `renderer.extract` (captureSlide.ts renders it into a texture of its
   * own). For the render page when only captures are wanted: under
   * software WebGL (SwiftShader, the render worker) each frame drawn at
   * 1920×1080 cost ~0.7 s of CPU on two cores, and a capture waited for
   * every frame queued before it. Fixed for the canvas's lifetime.
   */
  onScreen?: boolean
  /**
   * false: Pixi's garbage collector stays off (`gcActive`), so nothing
   * uploaded is unloaded behind the renderer's back. Present mode keeps
   * slides prepared off stage (renderer/presentSlides.ts) for minutes at a
   * time; with the collector on, whatever was not drawn for a minute — the
   * next slide's text rasters, its pictures — would be unloaded and
   * rasterised or uploaded again the moment it is shown. What stays resident
   * is then the ResourceManager's to budget. Fixed for the canvas's lifetime.
   */
  gc?: boolean
  /**
   * false: pictures are uploaded by the frame that draws them, however many
   * became ready together. Default true: large textures pass the upload gate
   * (textureUploadGate.ts), a bounded number of pixels per frame, so a slide
   * switch or a zoom's larger variants never stack their uploads into one
   * long frame. The render page turns it off — nobody watches its frames,
   * and a capture only waits longer for them. Fixed for the canvas's lifetime.
   */
  paceUploads?: boolean
  /**
   * The most textures one batched draw samples (Pixi's
   * `limits.maxBatchableTextures`; default: what the GPU allows, 16–32).
   * Pixi's batch shader has one branch per texture slot, and under software
   * WebGL (SwiftShader: the render worker) every branch costs — compiling
   * the shader on a page's first draw (~1.1 s on two cores) and every pixel
   * of every draw after it. Fewer slots only mean more draw calls for a scene
   * with many pictures; the pixels are the same (performance.md, F5). The
   * render page sets it. Fixed for the canvas's lifetime.
   */
  batchTextures?: number
  /**
   * Which canvas text rasters get mipmaps (runText/runTextSystem.ts →
   * mipmapsFor). Default `always`: present mode's builds and transitions
   * scale texts down while they play, and the render page's captures are
   * drawn smaller than the canvas. The editor passes `resampled`: its texts
   * rest on the device grid, drawn texel for device pixel, and a mipmap
   * chain there is a third more GPU memory nothing samples. Fixed for the
   * canvas's lifetime.
   */
  textMipmaps?: RunTextMipmaps
  /**
   * Default true: the canvas follows the window's devicePixelRatio itself —
   * a new ratio (the window moved to another display, the browser's zoom)
   * commits the zoom's resolution on the new grid and restages the texts
   * (the editor). false: the canvas keeps the ratio it opened at until its
   * owner switches it (`CanvasInstance.setPixelRatio`): present mode, whose
   * DensityHandover prepares the slides for the new ratio off stage and
   * switches the canvas in the task its set takes over — the canvas's own
   * watch restaged the texts on stage, and the first advance after a change
   * rasterised them (ADR 0020 → Present mode). Fixed for the canvas's
   * lifetime.
   */
  followPixelRatio?: boolean
}

/** The highest resolution the canvas draws at (DPR 2 at the editor's 400 %). */
const MAX_RESOLUTION = 8

/**
 * Off-screen texts are held to this resolution, at most (SceneGraph
 * restageTextResolution): what the canvas's old 25 Mpx cap gave every text,
 * so text memory stays where it was; texts in view get the full resolution.
 */
const OFFSCREEN_TEXT_RESOLUTION = 2.2

/**
 * The raster pixels the texts at the zoom's full resolution may hold
 * together before those beyond the view are held to
 * OFFSCREEN_TEXT_RESOLUTION as well (SceneGraph.restageTextResolution's
 * `margin`; textResolutionStaging.ts → planTextResolutions). Texts in view
 * always get the full resolution; within this budget, so do the texts in the
 * drawn region's margin (a short scroll shows them sharp at once), and texts
 * a scroll left keep theirs. 64 Mpx is 256 MB of exact-size, unmipmapped
 * rasters: the crowded slide (120 texts, DPR 2) zoomed to 544 % held 149 Mpx
 * without it — 81 Mpx of it the texts in view, 49 Mpx texts only the margin
 * met — and 1.86 GB of textures in all before the exact textures
 * (2026-10-31, ADR 0020 → texture memory); HEAD's capped canvas held 571 MB.
 */
const FULL_RESOLUTION_TEXT_BUDGET_PX = 64_000_000

/** The texts beyond the view that may have the full resolution (FULL_RESOLUTION_TEXT_BUDGET_PX). */
function textMargin(region: CanvasRegionController): ResolutionMargin | null {
  const rect = region.visibleStageRect()
  return rect === null ? null : { rect, budgetPx: FULL_RESOLUTION_TEXT_BUDGET_PX }
}

/**
 * Run a layout of the region (`layout`: whether anything moved) and draw what
 * it did: in this task when it reallocated the backbuffer — an empty one
 * must not reach the compositor, and a frame asked for from a ResizeObserver
 * or an animation-frame callback comes a frame late (present mode's density
 * change composited an empty frame that way, 2026-10-31) — otherwise in the
 * next frame when anything moved.
 */
function drawAfterLayout(
  region: CanvasRegionController,
  scheduler: RenderScheduler,
  layout: () => boolean,
): void {
  const before = region.reallocations
  const moved = layout()
  if (region.reallocations !== before) scheduler.renderNow()
  else if (moved) scheduler.markDirty()
}

/**
 * The renderer's resolution for `zoom`: one backing pixel per device pixel
 * at every zoom (ADR 0018 → Placement, ADR 0020). Below 100 % too: a canvas
 * drawn at 1× and shrunk by the compositor cannot put a text's lines where
 * the edit overlay draws them. The backing store's size does not depend on
 * it (canvasRegion.ts): the canvas draws the region the window shows.
 */
function resolutionFor(zoom: number, pixelRatio: number): number {
  return Math.max(0.05, Math.min(MAX_RESOLUTION, pixelRatio * zoom))
}

export function Canvas({
  onReady,
  bleedPx = 0,
  artboardSize,
  zoom = 1,
  onScreen = true,
  gc = true,
  paceUploads = true,
  batchTextures,
  textMipmaps = 'always',
  followPixelRatio = true,
}: CanvasProps = {}) {
  // Read once: the canvas is set up for one way of drawing.
  const onScreenRef = useRef(onScreen)
  const gcRef = useRef(gc)
  const paceUploadsRef = useRef(paceUploads)
  const batchTexturesRef = useRef(batchTextures)
  const textMipmapsRef = useRef(textMipmaps)
  const followPixelRatioRef = useRef(followPixelRatio)
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRootRef = useRef<HTMLDivElement>(null)
  /** The zoom as last rendered (the canvas starts at its resolution). */
  const zoomRef = useRef(zoom)
  const bleedRef = useRef(bleedPx)
  useLayoutEffect(() => {
    zoomRef.current = zoom
    bleedRef.current = bleedPx
  }, [zoom, bleedPx])
  /** The region the canvas draws (canvasRegionController.ts); null until Pixi is up, and offscreen. */
  const regionRef = useRef<CanvasRegionController | null>(null)
  /** The device px per CSS px the canvas draws for: the region's (the window's before it exists). */
  const pixelRatio = useCallback(
    (): number => regionRef.current?.pixelRatio ?? (window.devicePixelRatio || 1),
    [],
  )
  /**
   * Lay the canvas out again for its resolution (a resize, a new viewport):
   * the backing store, the region, the device-grid shift; drawn again when
   * anything moved.
   */
  const realign = useCallback((): void => {
    const region = regionRef.current
    const inst = instanceRef.current
    if (region === null || inst === null || !onScreenRef.current) return
    drawAfterLayout(region, inst.scheduler, () => region.layout())
  }, [])

  /**
   * Give the canvas `resolution` (a zoom commit, a new pixel ratio): the
   * region laid out for it — no reallocation while the window keeps its
   * size (ADR 0020) — pictures at its density, texts staged to it, those in
   * view first and in full, the others up to OFFSCREEN_TEXT_RESOLUTION.
   */
  const commitResolution = useCallback((resolution: number): void => {
    const inst = instanceRef.current
    const region = regionRef.current
    if (inst === null || region === null) return
    inst.sceneGraph.pinTextResolution()
    const reallocationsBefore = region.reallocations
    region.layout(resolution)
    // A picture that now covers more pixels than its texture holds loads
    // its larger variant and swaps it in (objectRenderers/imageRenderer.ts).
    inst.sceneGraph.setPixelDensity(resolution)
    inst.sceneGraph.restageTextResolution(
      resolution,
      region.visibleStageRect(0),
      OFFSCREEN_TEXT_RESOLUTION,
      textMargin(region),
    )
    // A reallocated backbuffer (a new pixel ratio) is drawn in this task (drawAfterLayout).
    if (region.reallocations !== reallocationsBefore) inst.scheduler.renderNow()
    else inst.scheduler.markDirty()
  }, [])

  /** `performance.now()` of the last wheel / pinch input (the zoom commit waits for it to stop). */
  const lastZoomInputAt = useRef(-Infinity)
  /**
   * The placement watch's hold while a zoom gesture is under way (released
   * at its commit): texts are compared with their rasters' places once, at
   * the gesture's end, not at every phase the region passed through.
   */
  const zoomPlacementHold = useRef<(() => void) | null>(null)
  const releaseZoomPlacementHold = useCallback((): void => {
    zoomPlacementHold.current?.()
    zoomPlacementHold.current = null
  }, [])

  /** Pending changes from before Pixi is ready. Buffer and flush once instance exists. */
  const pendingChangesRef = useRef<
    Array<{ changes: ObjectChangeSet; info: SlideObjectChangeInfo }>
  >([])

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
    setDefaultImageUrlResolver(createImageUrlResolver(API_BASE))
    setDefaultVideoInfoResolver(createVideoInfoResolver(API_BASE))

    let cancelled = false
    let app: Application | null = null
    const resourceManager = new ResourceManager()

    // Install default ResourceManager so imageRenderer can acquire/release textures.
    setDefaultResourceManager(resourceManager)

    const initPixi = async () => {
      // With `?perf=1` the harness chunk installs its GL counters before the
      // context exists (perf/activation.ts); otherwise this resolves at once.
      await whenPerfHarnessReady()
      if (cancelled) return
      app = new Application()

      await app.init({
        // Sized by the region controller below (canvasRegionController.ts);
        // the zoom's own resolution from the first paint (resolutionFor): a
        // deck opened at the fitted zoom is not rasterised twice.
        width: 1,
        height: 1,
        resolution: onScreenRef.current
          ? resolutionFor(zoomRef.current, pixelRatio())
          : window.devicePixelRatio || 1,
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
        gcActive: gcRef.current,
      })

      if (cancelled) {
        // Unmounted while init() ran (in dev: StrictMode's first mount, which
        // can resolve after the second mount has painted). Must not release
        // Pixi's page-wide pools under the live canvas — pixiApplication.ts.
        destroyPixiApplication(app)
        return
      }

      // Before anything is drawn: Pixi sizes each batcher and its shader by
      // this limit when it first builds one (BatcherPipe, GraphicsContextSystem).
      if (batchTexturesRef.current !== undefined) {
        limitBatchTextures(app.renderer, batchTexturesRef.current)
      }

      // Userland mitigation for a Pixi v8 WebGL race in
      // HTMLTextSystem._buildTexturePromise — see patchHTMLTextRace
      // for the full breakdown. Without this, duplicate component
      // instances rendering identical text leaves can show each
      // other's content (or a totally unrelated text node's content)
      // for a frame after any rasterise event. Must run AFTER
      // `app.init()` so `app.renderer.htmlText` exists.
      patchHTMLTextRace(app.renderer, { wakeRenderScheduler: true, counters: 'text' })
      // Where the page draws text from glyph runs (ADR 0018); the race-patched
      // raster above stays the fallback for what the runs cannot draw.
      installRunText(app.renderer, {
        wakeRenderScheduler: true,
        counters: 'text',
        mipmaps: textMipmapsRef.current,
      })
      // A Graphics destroyed with its tree releases its own context (graphicsContextRelease.ts).
      releaseOwnedGraphicsContexts()

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
      if (onScreenRef.current) {
        const region = new CanvasRegionController(
          app,
          sceneGraph,
          containerEl,
          overlayRootEl,
          () => bleedRef.current,
          followPixelRatioRef.current ? 'window' : 'owned',
        )
        regionRef.current = region
        region.layout(resolutionFor(zoomRef.current, region.pixelRatio))
        // E2E / debugging: the region the canvas draws (dev builds only).
        if (import.meta.env.DEV) {
          ;(
            window as unknown as { __narrative_canvas_region?: CanvasRegionController }
          ).__narrative_canvas_region = region
        }
        // The ticker (a playing timeline) draws through the region too.
        const liveApp = app
        liveApp.render = (): void => renderStage(liveApp)
      } else if (bleedPx !== 0) {
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
      // Pictures pick their size variant by the backing store's density
      // (imageVariant.ts): set before the buffered changes mount anything.
      sceneGraph.setPixelDensity(app.renderer.resolution)

      // Large textures go to the GPU a bounded amount per frame, what the
      // window shows first (textureUploadGate.ts); installed before the
      // buffered changes mount anything.
      if (paceUploadsRef.current) {
        const liveApp = app
        resourceManager.setUploadGate(
          new TextureUploadGate(pixiUploadTarget(liveApp.renderer), {
            budget: adaptiveUploadBudget(),
            viewport: () => regionRef.current?.visibleStageRect() ?? null,
            locate: stageLocator(liveApp.stage),
          }),
        )
      }

      // OverlayCompositor: DOM overlay sync nad Pixi canvasem.
      // overlayRootEl je sousedící <div> s position:absolute;inset:0;pointer-events:none.
      // Compositor přidá registrované overlay elementy do tohoto divu a synchuje pozice
      // přes Pixi ticker každý frame (DPR-aware, žádný GC churn).
      const compositor = new OverlayCompositor(app, overlayRootEl)
      compositor.setRenderScheduler(scheduler)

      instanceRef.current = { app, sceneGraph, resourceManager, compositor, scheduler }
      registerPerfCanvas({ app, sceneGraph, scheduler, pendingLoads: pendingRenderWork })
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

      // Flush the changes that arrived before the init (e.g. the initial
      // emission of useSlideObjectChanges, synchronous on subscribe).
      for (const pending of pendingChangesRef.current) {
        applySlideChangesRef.current(sceneGraph, pending.changes, pending.info)
      }
      pendingChangesRef.current = []

      // P12b: with autoStart:false the renderer never paints by itself.
      // Force a single synchronous frame so the editor isn't blank until
      // the first user interaction. SceneGraph's markDirty() calls take
      // over from here.
      scheduler.renderNow()
      markFirstPaint()

      // Tell the consumers (DeckShell → CanvasInstanceContext) the instance is ready.
      onReady?.({
        sceneGraph,
        compositor,
        pixelRatio,
        setPixelRatio: (ratio: number): void => {
          const region = regionRef.current
          const live = instanceRef.current
          if (!onScreenRef.current || region === null || live === null) {
            throw new Error('Canvas.setPixelRatio: an on-screen canvas only')
          }
          if (Math.abs(region.pixelRatio - ratio) < 1e-9) return
          region.switchPixelRatio(ratio, resolutionFor(zoomRef.current, ratio))
          // Drawn before this task ends: the reallocated backbuffer is empty,
          // and the owner's own draw (the swapped-in slide) counts.
          live.scheduler.renderBeforeTaskEnds()
        },
        preparePixelRatio: (ratio: number, moved: () => void) => {
          const region = regionRef.current
          if (!onScreenRef.current || region === null) {
            throw new Error('Canvas.preparePixelRatio: an on-screen canvas only')
          }
          const resolution = resolutionFor(zoomRef.current, ratio)
          return { resolution, release: region.prepareFor(ratio, resolution, moved) }
        },
      })

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
        registerPerfCanvas(null)

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
        // Its waiters go without an upload: the renderer is going.
        liveRM.uploads?.destroy()
        liveRM.setUploadGate(null)
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

        regionRef.current?.destroy()
        regionRef.current = null
        // The renderer (and its watch) went: nothing left to hold.
        zoomPlacementHold.current = null
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
  // Both are selected from the deck store (a number, a string): an object
  // edit does not re-render the canvas (performance.md → E1).
  const { activeSlideId } = useActiveSlide()
  const currentSlideNumber = useDeckSelector((store) =>
    activeSlideId !== null ? computeSlideNumber(store.getSlides(), activeSlideId) : undefined,
  )
  setRenderingSlideNumber(currentSlideNumber)

  const deckStore = useDeckStore()
  const deckStoreRef = useRef(deckStore)
  deckStoreRef.current = deckStore

  // A picture a build of the active slide scales up past its rest size
  // (zoomIn, popIn, an overshooting easing) is drawn from `display`, the
  // variant it had before the canvas chose (imageVariant.ts). The floor reads
  // the slide when a picture chooses; a change of the slide's builds tells
  // the mounted pictures again.
  const activeSlideIdRef = useRef(activeSlideId)
  activeSlideIdRef.current = activeSlideId
  const scaledUpKey = useDeckSelector((store) => {
    const slide = activeSlideId !== null ? store.getSlide(activeSlideId) : undefined
    return slide === undefined ? '' : [...scaledUpObjectIds(slide)].sort().join(',')
  })
  useEffect(() => {
    const instance = instanceRef.current
    if (instance === null) return
    instance.sceneGraph.setVariantFloor((picture) => {
      const id = activeSlideIdRef.current
      const slide = id !== null ? deckStoreRef.current.getSlide(id) : undefined
      return slide !== undefined && scaledUpObjectIds(slide).has(picture.id) ? 'display' : undefined
    })
  }, [scaledUpKey, pixiReady])
  useEffect(() => {
    const instance = instanceRef.current
    if (instance === null) return
    instance.sceneGraph.refreshSlideNumberTexts()
  }, [currentSlideNumber, pixiReady])
  // The active slide's surface (its layout's, A4.2d): its colour tokens
  // resolve on it; a change repaints what it affects.
  const surface = useDeckSelector((store) =>
    activeSlideId !== null ? store.getSlide(activeSlideId)?.layout?.surface : undefined,
  )
  useEffect(() => {
    setRenderingSurface(surface)
  }, [surface])
  useEffect(() => {
    return () => setRenderingSurface(undefined)
  }, [])

  // Reaktivita na Y.Doc přes incremental changes (M3).
  // Initial state přichází synchronně jako první emise (added = current).
  // Batching per rAF v subscribeToObjectChanges — tento callback se volá 1× per tick.
  //
  // The scene graph also learns which slide it holds. Present mode swaps
  // whole prepared slides in (SceneGraph.swapSlideScene) before the active
  // slide changes, so the removal emitted for the slide it left is stale by
  // then, and the first emission of the slide it swapped in has nothing to
  // do — as long as the deck store still has that slide at the version the
  // scene was built from; otherwise it is applied as updates (addObject of a
  // mounted id updates it).

  // Every picture of the deck resolved in one batched request (or a few, a
  // hundred assets each) once the deck is there: the slide panel's
  // thumbnails and the canvas then find their URLs cached instead of each
  // asking (renderer/imageUrl.ts; performance.md → L3). Pictures added later
  // are resolved as they mount, a task's worth per request.
  useEffect(() => {
    let done = false
    const prefetch = (): boolean => {
      const slides = deckStore.getSlides()
      if (slides.length === 0) return false
      let resolver: ReturnType<typeof getDefaultImageUrlResolver>
      try {
        resolver = getDefaultImageUrlResolver()
      } catch {
        return false
      }
      void resolver.prefetch(deckPictureAssetIds(slides))
      return true
    }
    if (prefetch()) return
    const unsubscribe = deckStore.subscribe(() => {
      if (done || !prefetch()) return
      done = true
      unsubscribe()
    })
    return () => {
      done = true
      unsubscribe()
    }
  }, [deckStore])

  const applySlideChanges = (
    sceneGraph: SceneGraph,
    changes: ObjectChangeSet,
    info: SlideObjectChangeInfo,
  ): void => {
    if (info.kind === 'leave') {
      const held = sceneGraph.heldSlideId
      if (held !== null && held !== info.slideId) return
      sceneGraph.applyChanges(changes)
      sceneGraph.holdSlide(null)
      return
    }
    if (info.kind === 'initial') {
      const objects = deckStore.getSlide(info.slideId)?.objects
      if (sceneGraph.holdsSlideAt(info.slideId, objects)) return
      sceneGraph.applyChanges(changes)
      sceneGraph.holdSlide(info.slideId, objects ?? null)
      return
    }
    sceneGraph.applyChanges(changes)
    sceneGraph.markHeldEdited()
  }
  // The init's flush of buffered changes runs later: it reads the latest.
  const applySlideChangesRef = useRef(applySlideChanges)
  useEffect(() => {
    applySlideChangesRef.current = applySlideChanges
  })
  useSlideObjectChanges((changes, info) => {
    const instance = instanceRef.current
    if (instance === null) {
      // Pixi ještě neinicializován — buffer a flush v init
      pendingChangesRef.current.push({ changes, info })
      return
    }
    applySlideChanges(instance.sceneGraph, changes, info)
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
  // Committed once the gesture is over: `ZOOM_COMMIT_QUIET_MS` after the last
  // zoom change AND the last wheel / pinch input (a zoom resting at its clamp while the
  // wheel still turns is the same gesture — committing there resized the
  // backbuffer and re-rasterised every text for a resolution the next wheel
  // step replaced), and then from an idle callback: on a busy main thread
  // the timer can fire while wheel events of the same gesture are still
  // queued, and each of them (a new zoom → this effect's cleanup) must get
  // to cancel the commit first. A commit is the expensive part — the
  // backbuffer reallocation alone is ~110 ms at the 25 Mpx cap with MSAA
  // (M3 Pro, 2026-10-18) — so one per gesture, and none for a gesture that
  // ends where it started.
  //
  // The commit does not let Pixi re-rasterise every text in one frame (its
  // `resolutionChange` runner would): texts are pinned to the resolution
  // they were drawn at, the renderer's changes, and the new one is handed to
  // the texts a batch per frame, those on screen first, the rest when idle
  // (SceneGraph.pinTextResolution / restageTextResolution; plan
  // canvas-performance step 3). While a gesture is under way the previous
  // commit's staging is paused.
  useEffect(() => {
    const instance = instanceRef.current
    if (instance === null) return
    // The zoom moved: rasters for the committed resolution may be about to
    // be replaced. The commit below replaces the staging, or resumes it.
    instance.sceneGraph.pauseTextRestage()
    if (onScreenRef.current)
      zoomPlacementHold.current ??= holdPlacementRepaints(instance.app.renderer)

    const effectiveRes = resolutionFor(zoom, pixelRatio())
    // The live zoom (a CSS scale) may show more of the world than the
    // region holds, or another part of it: follow it now — a new transform,
    // no reallocation; texts keep their rasters until the commit.
    if (onScreenRef.current) {
      const region = regionRef.current
      if (region !== null) {
        drawAfterLayout(
          region,
          instance.scheduler,
          () => region.follow(() => instance.sceneGraph.pinTextResolution()).moved,
        )
      }
    }

    let cancelIdle: (() => void) | null = null
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    /** Commit `delay` ms from now, or later while zoom input keeps coming. */
    const arm = (delay: number): void => {
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        const quiet = performance.now() - lastZoomInputAt.current
        if (quiet < ZOOM_COMMIT_QUIET_MS) {
          arm(ZOOM_COMMIT_QUIET_MS - quiet)
          return
        }
        // 500 ms at the latest: a main thread that never idles still gets sharp text.
        cancelIdle = whenIdle(commit, 500)
      }, delay)
    }

    const commit = (): void => {
      cancelIdle = null
      const inst = instanceRef.current
      if (inst === null || !onScreenRef.current) {
        releaseZoomPlacementHold()
        return
      }
      // Input that arrived while the idle callback waited: still the gesture.
      const quiet = performance.now() - lastZoomInputAt.current
      if (quiet < ZOOM_COMMIT_QUIET_MS) {
        arm(ZOOM_COMMIT_QUIET_MS - quiet)
        return
      }
      const renderer = inst.app.renderer
      if (Math.abs(renderer.resolution - effectiveRes) < 1e-6) {
        realign()
        inst.sceneGraph.resumeTextRestage()
      } else {
        commitResolution(effectiveRes)
      }
      // The gesture is over: what moved off its place is painted again
      // (a resolution change is the staging's, not the watch's).
      releaseZoomPlacementHold()
    }

    arm(ZOOM_COMMIT_QUIET_MS)

    return () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      cancelIdle?.()
    }
  }, [zoom, pixiReady, realign, commitResolution, releaseZoomPlacementHold, pixelRatio])

  // A pointer gesture (a drag, a resize, a slider scrubbed in the inspector)
  // holds the placement watch until the button is released: a text that
  // moves is painted again for where it rests at the gesture's end, not
  // wherever the page stalled for 150 ms along the way (a garbage
  // collection mid-drag painted every dragged text once more —
  // `transform.move.multi`, 2026-10-30).
  useEffect(() => {
    const inst = instanceRef.current
    if (inst === null || !onScreenRef.current) return
    const renderer = inst.app.renderer
    let release: (() => void) | null = null
    const down = (): void => {
      release ??= holdPlacementRepaints(renderer)
    }
    const up = (): void => {
      release?.()
      release = null
    }
    const opts: AddEventListenerOptions = { capture: true, passive: true }
    window.addEventListener('pointerdown', down, opts)
    window.addEventListener('pointerup', up, opts)
    window.addEventListener('pointercancel', up, opts)
    window.addEventListener('blur', up)
    return () => {
      window.removeEventListener('pointerdown', down, opts)
      window.removeEventListener('pointerup', up, opts)
      window.removeEventListener('pointercancel', up, opts)
      window.removeEventListener('blur', up)
      up()
    }
  }, [pixiReady])

  // When the last zoom input arrived (the zoom commit above waits for it to
  // stop): a wheel with Ctrl/Cmd (Chrome's trackpad pinch is one too) or
  // Safari's pinch, anywhere, and a plain wheel over the canvas — it scrolls
  // the editor, and the commit waits for that rather than resize the
  // backbuffer mid-scroll.
  useEffect(() => {
    const note = (): void => {
      lastZoomInputAt.current = performance.now()
    }
    const onWheel = (e: WheelEvent): void => {
      const container = containerRef.current
      if (
        e.ctrlKey ||
        e.metaKey ||
        (container !== null && e.target instanceof Node && container.contains(e.target))
      ) {
        note()
      }
    }
    const opts: AddEventListenerOptions = { capture: true, passive: true }
    window.addEventListener('wheel', onWheel, opts)
    window.addEventListener('gesturechange', note, opts)
    return () => {
      window.removeEventListener('wheel', onWheel, opts)
      window.removeEventListener('gesturechange', note, opts)
    }
  }, [])

  // The region follows what the window shows (canvasRegionController.ts):
  // a resize of the viewport or the window lays the canvas out again (a new
  // backing store only when its pixel count changes); a scroll moves the
  // region when the view leaves it, and once the scroll has settled, texts
  // that came into view get the full resolution (the off-screen ones were
  // held to OFFSCREEN_TEXT_RESOLUTION). A pass that finds nothing changed
  // writes nothing.
  useEffect(() => {
    const inst = instanceRef.current
    if (inst === null || !onScreenRef.current) return
    let frame = 0
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    const promoteInView = (): void => {
      settleTimer = null
      const live = instanceRef.current
      const region = regionRef.current
      if (live === null || region === null) return
      const res = live.app.renderer.resolution
      // Only at the zoom's own resolution: a gesture's staging is the commit's.
      if (Math.abs(res - resolutionFor(zoomRef.current, pixelRatio())) > 1e-6) return
      live.sceneGraph.restageTextResolution(
        res,
        region.visibleStageRect(0),
        OFFSCREEN_TEXT_RESOLUTION,
        textMargin(region),
      )
    }
    const onScroll = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const region = regionRef.current
        const live = instanceRef.current
        if (region === null || live === null) return
        drawAfterLayout(
          region,
          live.scheduler,
          () => region.follow(() => live.sceneGraph.pinTextResolution()).moved,
        )
        if (settleTimer !== null) clearTimeout(settleTimer)
        settleTimer = setTimeout(promoteInView, 200)
      })
    }
    const onLayout = (): void => {
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = 0
        realign()
      })
    }
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', onLayout)
    const observer = new ResizeObserver(onLayout)
    const containerEl = containerRef.current
    if (containerEl !== null) observer.observe(containerEl)
    const viewport = containerEl?.closest('.artboard')?.parentElement ?? null
    if (viewport !== null) observer.observe(viewport)
    observer.observe(document.body)
    // A new pixel ratio (the window moved to another display, the browser's
    // zoom): the canvas takes the zoom's resolution on the new grid. Not on a
    // canvas whose owner switches the ratio (`followPixelRatio`: present
    // mode's DensityHandover, through `setPixelRatio`).
    const unwatch = followPixelRatioRef.current
      ? watchDevicePixelRatio(() => commitResolution(resolutionFor(zoomRef.current, pixelRatio())))
      : () => undefined
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onLayout)
      observer.disconnect()
      unwatch()
      if (frame !== 0) cancelAnimationFrame(frame)
      if (settleTimer !== null) clearTimeout(settleTimer)
    }
  }, [pixiReady, realign, commitResolution, pixelRatio])

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
