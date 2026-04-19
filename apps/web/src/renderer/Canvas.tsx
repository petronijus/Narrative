/**
 * renderer/Canvas.tsx
 *
 * React komponenta — mount/unmount Pixi Application.
 *
 * Odpovědnosti:
 * - Inicializuje Pixi Application (WebGL/WebGPU renderer).
 * - HiDPI: resolution=devicePixelRatio + autoDensity=true pro správné fyzické pixely.
 * - ResizeObserver: reaguje na změnu velikosti parent kontejneru.
 * - StrictMode safe: React 18 double-mount v dev módu. Ref guard zabraňuje
 *   duplicitní inicializaci — druhý mount detekuje existující instanci a skipne ji.
 * - Všechny slide objekty jdou přes SceneGraph — žádné přímé manipulace s app.stage.
 *
 * Pixi v8 API:
 * - new Application() + await app.init({ ... })
 * - app.canvas (ne app.view jako v Pixi v7)
 * - app.destroy(true, { children: true, texture: true }) při unmount
 */

import { useEffect, useRef } from 'react'
import { Application } from 'pixi.js'
import { SceneGraph } from './SceneGraph'
import { ResourceManager } from './ResourceManager'
import type { SlideObjectData } from './types'

interface CanvasProps {
  slideData: SlideObjectData[]
}

export function Canvas({ slideData }: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  /**
   * Ref guard pro StrictMode double-mount safety.
   * Drží reference na živé instance napříč efektem.
   */
  const instanceRef = useRef<{
    app: Application
    sceneGraph: SceneGraph
    resourceManager: ResourceManager
  } | null>(null)

  // Efekt pro mount/unmount Pixi Application
  useEffect(() => {
    const containerEl = containerRef.current
    if (containerEl === null) return

    // StrictMode guard: pokud instance již existuje, skip
    if (instanceRef.current !== null) return

    let cancelled = false
    let app: Application | null = null
    let sceneGraph: SceneGraph | null = null
    const resourceManager = new ResourceManager()

    const initPixi = async () => {
      app = new Application()

      await app.init({
        // Pixi v8: canvas element je součástí init options
        resizeTo: containerEl,
        // HiDPI: fyzické pixely = CSS pixely × DPR, canvas element má CSS velikost
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        // Průhledné pozadí — editor background je v CSS
        backgroundAlpha: 0,
        // WebGPU s fallback na WebGL
        preference: 'webgpu',
        antialias: true,
      })

      if (cancelled) {
        // Cleanup v případě že efekt byl zrušen mezi init a await
        app.destroy(true, { children: true, texture: true })
        return
      }

      // Přidáme canvas element do DOM
      // Pixi v8 používá app.canvas (HTMLCanvasElement), ne app.view
      containerEl.appendChild(app.canvas)

      // SceneGraph potřebuje Container class — extrahujeme z stage
      sceneGraph = new SceneGraph(app)

      // Uložíme do ref pro StrictMode guard
      instanceRef.current = { app, sceneGraph, resourceManager }

      // Počáteční render dat
      sceneGraph.render(slideData)
    }

    void initPixi()

    return () => {
      cancelled = true

      if (instanceRef.current !== null) {
        const { app: liveApp, sceneGraph: liveGraph, resourceManager: liveRM } = instanceRef.current

        liveGraph.destroy()
        liveRM.destroyAll()
        liveApp.destroy(true, { children: true, texture: true })

        instanceRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only run on mount/unmount
  }, [])

  // Efekt pro reaktivitu na slideData změny
  useEffect(() => {
    const instance = instanceRef.current
    if (instance === null) return
    instance.sceneGraph.render(slideData)
  }, [slideData])

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
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0 }}
      aria-label="Presentation canvas"
    />
  )
}
