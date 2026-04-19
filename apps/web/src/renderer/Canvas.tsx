/**
 * renderer/Canvas.tsx
 *
 * React komponenta — mount/unmount Pixi Application.
 *
 * M2: Objekty čteny z Y.Doc přes useSlideObjects() hook místo slideData prop.
 *     Ellipse a text renderers nejsou implementovány (renderer agent v fázi 2).
 *     Pokud Y.Doc vrátí ellipse/text, SceneGraph je tiše přeskočí s console.warn.
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
import { useSlideObjects } from '../state/useSlideObjects'

export function Canvas() {
  const containerRef = useRef<HTMLDivElement>(null)

  const { objects } = useSlideObjects()

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
    const resourceManager = new ResourceManager()

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
      instanceRef.current = { app, sceneGraph, resourceManager }

      // Inicializační render — objects může být stale zde, ale useEffect
      // pro objects changes se postará o aktualizaci
      console.debug('[Canvas] Pixi initialized, Y.Doc observer active')
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
  }, []) // intentional empty deps: mount-only effect with StrictMode guard

  // Efekt pro reaktivitu na Y.Doc objects changes
  useEffect(() => {
    const instance = instanceRef.current
    if (instance === null) return

    // SceneGraph.render() interně volá getRenderer(type).
    // Pro ellipse/text: renderer není registrován → getRenderer vrátí undefined → SceneGraph skip.
    // SceneGraph.ts z M1 musí toto chování podporovat (viz níže).
    instance.sceneGraph.render(objects)
  }, [objects])

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
