/**
 * renderer/SceneGraph.ts
 *
 * Vysokoúrovňový scene graph wrapper nad Pixi Container.
 *
 * M2: Přechod na SlideObject z @narrative/shared (místo lokálního SlideObjectData).
 *     Ellipse/text typy jsou ignorovány s console.warn — renderer agent implementuje
 *     příslušné renderers v fázi 2.
 *
 * Principy:
 * - SceneGraph vlastní root Container a interní mapu node→data.
 * - Žádné přímé mutace Pixi objektů mimo SceneGraph + objectRenderers.
 * - render(array) provádí naivní ID-based diff: add/update/remove.
 *   Plný reconciler (driven Yjs observations s batching) přijde v M3.
 *
 * M3: SceneGraph.render() bude volán z reconciler diff engine, ne z React useEffect.
 */

import { Container } from 'pixi.js'
import type { Application } from 'pixi.js'
import { getRenderer } from './objectRenderers'
import type { SlideObject } from '@narrative/shared'

interface SceneNode {
  container: Container
  data: SlideObject
}

export class SceneGraph {
  private readonly app: Application
  /** Root container přidaný na app.stage. Všechny slide objekty jsou jeho children. */
  private readonly root: Container
  /** Mapa objectId → SceneNode (Container + poslední data snapshot). */
  private readonly nodes = new Map<string, SceneNode>()

  constructor(app: Application) {
    this.app = app
    this.root = new Container()
    this.app.stage.addChild(this.root)
  }

  /**
   * Přidá nový objekt do scene graph.
   * Pokud typ nemá registrovaný renderer, tiše přeskočí s console.warn.
   * Interní — volej přes render() nebo přímo pro testing.
   */
  addObject(data: SlideObject): void {
    if (this.nodes.has(data.id)) {
      this.updateObject(data.id, data)
      return
    }

    const renderer = getRenderer(data.type)
    if (renderer === undefined) {
      // Ellipse/text nemají renderer v M2 phase 1 — renderer agent implementuje v fázi 2
      console.warn(`[SceneGraph] No renderer for type: ${data.type}`)
      return
    }

    const container = renderer.mount(data)
    this.root.addChild(container)
    this.nodes.set(data.id, { container, data })
  }

  /**
   * Aktualizuje existující objekt novými daty.
   */
  updateObject(id: string, next: SlideObject): void {
    const node = this.nodes.get(id)
    if (node === undefined) {
      console.warn(`[SceneGraph] updateObject: unknown ID ${id}`)
      return
    }

    const renderer = getRenderer(next.type)
    if (renderer === undefined) {
      console.warn(`[SceneGraph] No renderer for type at update: ${next.type}`)
      return
    }

    renderer.update(node.container, node.data, next)
    node.data = next
  }

  /**
   * Odstraní objekt ze scene graph a uvolní jeho Pixi zdroje.
   */
  removeObject(id: string): void {
    const node = this.nodes.get(id)
    if (node === undefined) return

    const renderer = getRenderer(node.data.type)
    renderer?.destroy(node.container)

    if (!node.container.destroyed) {
      this.root.removeChild(node.container)
    }

    this.nodes.delete(id)
  }

  /**
   * Primitivní reconciler: diff input array vs. current state.
   * Vyvolá add/update/remove podle potřeby.
   *
   * Algoritmus (O(n)):
   * 1. Projdi nová data → add nebo update.
   * 2. Projdi existující node IDs → odstraň ty, co nejsou v nových datech.
   *
   * M3: Toto bude nahrazeno Yjs-driven reconcilerem s batching a O(diff) complexity.
   */
  render(objects: SlideObject[]): void {
    const incomingIds = new Set<string>()

    for (const obj of objects) {
      incomingIds.add(obj.id)
      if (this.nodes.has(obj.id)) {
        this.updateObject(obj.id, obj)
      } else {
        this.addObject(obj)
      }
    }

    // Odstraň objekty, které nejsou v nové sadě
    for (const id of this.nodes.keys()) {
      if (!incomingIds.has(id)) {
        this.removeObject(id)
      }
    }
  }

  /**
   * Uvolní všechny Pixi zdroje a vyprázdní scene graph.
   * Volat při unmount Canvas komponenty (před app.destroy).
   */
  destroy(): void {
    for (const id of [...this.nodes.keys()]) {
      this.removeObject(id)
    }
    if (!this.root.destroyed) {
      this.app.stage.removeChild(this.root)
      this.root.destroy()
    }
  }

  /** Počet aktuálně spravovaných objektů (pro debugging a testy). */
  get objectCount(): number {
    return this.nodes.size
  }
}
