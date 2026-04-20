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

import { useEffect, useRef } from 'react'
import { Application } from 'pixi.js'
import { SceneGraph } from './SceneGraph'
import { ResourceManager, setDefaultResourceManager } from './ResourceManager'
import { OverlayCompositor } from './overlay/OverlayCompositor'
import { createImageUrlResolver, setDefaultImageUrlResolver } from './imageUrl.js'
import { createVideoInfoResolver, setDefaultVideoInfoResolver } from './videoInfo.js'
import { useSlideObjectChanges } from '../state/useSlideObjectChanges'
import { useAuth } from '../state/AuthContext.js'
import type { ObjectChangeSet } from '@narrative/slide-model'
import type { CanvasInstance } from './CanvasInstanceContext.js'

export interface CanvasProps {
  /**
   * Callback volaný po úspěšném inicializaci Pixi (async).
   * Při unmount volán s null pro signalizaci cleanup.
   */
  onReady?: ((instance: CanvasInstance) => void) | undefined
}

export function Canvas({ onReady }: CanvasProps = {}) {
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
   * Ref guard pro StrictMode double-mount safety.
   * Drží reference na živé instance napříč efektem.
   */
  const instanceRef = useRef<{
    app: Application
    sceneGraph: SceneGraph
    resourceManager: ResourceManager
    compositor: OverlayCompositor
  } | null>(null)

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
        preference: 'webgpu',
        antialias: true,
      })

      if (cancelled) {
        app.destroy(true, { children: true, texture: true })
        return
      }

      containerEl.appendChild(app.canvas)

      const sceneGraph = new SceneGraph(app)

      // OverlayCompositor: DOM overlay sync nad Pixi canvasem.
      // overlayRootEl je sousedící <div> s position:absolute;inset:0;pointer-events:none.
      // Compositor přidá registrované overlay elementy do tohoto divu a synchuje pozice
      // přes Pixi ticker každý frame (DPR-aware, žádný GC churn).
      const compositor = new OverlayCompositor(app, overlayRootEl)

      instanceRef.current = { app, sceneGraph, resourceManager, compositor }

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

        liveGraph.destroy()
        liveRM.destroyAll()
        // Compositor musí být zničen PŘED app.destroy() — potřebuje ticker pro cleanup
        liveCompositor.destroy()
        liveApp.destroy(true, { children: true, texture: true })

        instanceRef.current = null
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
    // Wrapper je position:relative aby overlayRoot byl správně umístěn
    <div style={{ position: 'absolute', inset: 0 }}>
      {/* Canvas container — Pixi appenduje canvas sem */}
      <div
        ref={containerRef}
        style={{ position: 'absolute', inset: 0 }}
        aria-label="Presentation canvas"
      />
      {/* Overlay root — DOM elementy nad canvasem, synchronizovány OverlayCompositor */}
      <div
        ref={overlayRootRef}
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          // overflow:hidden aby overlay elementy nevyčnívaly mimo canvas area
          overflow: 'hidden',
        }}
        aria-hidden="true"
      />
    </div>
  )
}
