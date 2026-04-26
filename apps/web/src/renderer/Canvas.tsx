/**
 * renderer/Canvas.tsx
 *
 * React komponenta — mount/unmount Pixi Application.
 *
 * M2 fáze 2a: Přidán OverlayCompositor a overlayRoot div. Compositor je
 * instanciován po app.init() a uvolněn před app.destroy() při unmount.
 *
 * Compositor instance je exponována přes compositorRef prop (nebo React context
 * pokud editor-ui potřebuje přímý přístup — viz TODO níže).
 *
 * Pixi v8 API:
 * - new Application() + await app.init({ ... })
 * - app.canvas (ne app.view jako v Pixi v7)
 * - app.destroy(true, { children: true, texture: true }) při unmount
 *
 * DOM overlay vrstva:
 * - overlayRoot: <div> uvnitř stejného parent jako canvas, position:absolute;inset:0;pointer-events:none
 * - OverlayCompositor synchuje DOM elementy s Pixi world coords každý ticker tick
 * - editor-ui agent (fáze 2b) použije compositor pro text edit overlay a selection outlines
 *
 * TODO(M2-2b): Exportovat compositor přes React context aby editor-ui mohl registrovat overlays.
 *   Alternativně přijmout `onCompositorReady: (c: OverlayCompositor) => void` prop.
 */

import { useEffect, useRef, useState } from 'react'
import { Application } from 'pixi.js'
import { SceneGraph } from './SceneGraph'
import { ResourceManager, setDefaultResourceManager } from './ResourceManager'
import { OverlayCompositor } from './overlay/OverlayCompositor'
import { installPixiBindGroupPatch } from './pixiBindGroupPatch.js'

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
import { applyBackground } from './ArtboardBackground.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from './constants.js'
import { useAuth } from '../state/AuthContext.js'
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
}

export function Canvas({ onReady, bleedPx = 0, artboardSize }: CanvasProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRootRef = useRef<HTMLDivElement>(null)
  const { token } = useAuth()

  // Stable ref so the image URL resolver always reads the current token
  // even if the user re-authenticates mid-session.
  const tokenRef = useRef<string | null>(token)
  tokenRef.current = token

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

    // Install default image URL resolver bound to this Canvas's token ref.
    // Done once at mount time. The token getter is a stable closure over tokenRef
    // so it always returns the latest token even after re-auth.
    const apiBase = (import.meta.env['VITE_API_URL'] as string | undefined) ?? ''
    setDefaultImageUrlResolver(createImageUrlResolver(apiBase, () => tokenRef.current))
    setDefaultVideoInfoResolver(createVideoInfoResolver(apiBase, () => tokenRef.current))

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
        app.destroy(true, { children: true, texture: true })
        return
      }

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

      instanceRef.current = { app, sceneGraph, resourceManager, compositor }
      setPixiReady(true)

      // E2E hook (P6): expose the live SceneGraph so Playwright specs can
      // assert that the Pixi side is in sync with Y.Doc after layer
      // reorder. Dev-only — stripped from prod bundles.
      if (import.meta.env.DEV) {
        ;(window as unknown as { __narrative_scene_graph?: SceneGraph }).__narrative_scene_graph =
          sceneGraph
      }

      // Flush pending changes co přišly před initem (např. initial emission
      // z useSlideObjectChanges subscribe synchronně po subscribe).
      for (const pending of pendingChangesRef.current) {
        sceneGraph.applyChanges(pending)
      }
      pendingChangesRef.current = []

      // Informuj konzumenty (DeckShell → CanvasInstanceContext) o dostupné instanci
      onReady?.({ sceneGraph, compositor })

      console.debug('[Canvas] Pixi initialized, Y.Doc observer active, OverlayCompositor ready')
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

        liveGraph.destroy()
        liveRM.destroyAll()
        // Compositor musí být zničen PŘED app.destroy() — potřebuje ticker pro cleanup
        liveCompositor.destroy()
        liveApp.destroy(true, { children: true, texture: true })

        instanceRef.current = null
        setPixiReady(false)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // intentional empty deps: mount-only effect with StrictMode guard; onReady stable via parent useCallback

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

  // ResizeObserver — reaguje na změnu velikosti parent kontejneru
  useEffect(() => {
    const containerEl = containerRef.current
    if (containerEl === null) return

    const observer = new ResizeObserver(() => {
      const instance = instanceRef.current
      if (instance === null) return

      const { width, height } = containerEl.getBoundingClientRect()
      if (width > 0 && height > 0) {
        instance.app.renderer.resize(width, height)
      }
    })

    observer.observe(containerEl)
    return () => observer.disconnect()
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
