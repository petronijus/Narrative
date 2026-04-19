/**
 * renderer/SceneGraph.ts
 *
 * Vysokoúrovňový scene graph wrapper nad Pixi Container.
 *
 * M2: Přechod na SlideObject z @narrative/shared (místo lokálního SlideObjectData).
 *     Ellipse/text typy jsou ignorovány s console.warn — renderer agent implementuje
 *     příslušné renderers v fázi 2.
 *
 * M3: SceneGraph.applyChanges(ObjectChangeSet) — chirurgický incremental diff.
 *     - Přidán nodeTypes Map<id, SlideObjectType> pro O(1) renderer lookup bez scan.
 *     - applyChanges preferuje renderer.applyPatch() pokud existuje, jinak fallback update().
 *     - render() zachováno pro backward compat (Canvas.tsx boot, M4 state-sync přechod).
 *
 * Principy:
 * - SceneGraph vlastní root Container a interní mapu node→data.
 * - Žádné přímé mutace Pixi objektů mimo SceneGraph + objectRenderers.
 * - render(array) provádí naivní ID-based diff: add/update/remove.
 * - applyChanges(ObjectChangeSet) — incremental diff s patch-based updates.
 */

import { Container } from 'pixi.js'
import type { Application } from 'pixi.js'
import { getRenderer } from './objectRenderers'
import type { SlideObject, SlideObjectType, ObjectChangeSet } from '@narrative/shared'

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
  /**
   * Mapa objectId → SlideObjectType.
   * Umožňuje O(1) renderer lookup v applyChanges bez potřeby full node scan.
   * Plněna při addObject/applyChanges.added, mazána při removeObject/applyChanges.removed.
   */
  private readonly nodeTypes = new Map<string, SlideObjectType>()

  constructor(app: Application) {
    this.app = app
    this.root = new Container()
    this.app.stage.addChild(this.root)
  }

  /**
   * Přidá nový objekt do scene graph.
   * Pokud typ nemá registrovaný renderer, tiše přeskočí s console.warn.
   * Interní — volej přes render() nebo applyChanges() nebo přímo pro testing.
   */
  addObject(data: SlideObject): void {
    if (this.nodes.has(data.id)) {
      this.updateObject(data.id, data)
      return
    }

    const renderer = getRenderer(data.type)
    if (renderer === undefined) {
      console.warn(`[SceneGraph] No renderer for type: ${data.type}`)
      return
    }

    const container = renderer.mount(data)
    this.root.addChild(container)
    this.nodes.set(data.id, { container, data })
    this.nodeTypes.set(data.id, data.type)
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
    this.nodeTypes.delete(id)
  }

  /**
   * Primitivní reconciler: diff input array vs. current state.
   * Vyvolá add/update/remove podle potřeby.
   *
   * Algoritmus (O(n)):
   * 1. Projdi nová data → add nebo update.
   * 2. Projdi existující node IDs → odstraň ty, co nejsou v nových datech.
   *
   * Zachováno pro backward compat — Canvas.tsx ho používá při bootu a jako fallback
   * dokud state-sync agent nedodá useSlideObjectChanges hook (M3 fáze 1).
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
   * M3: Aplikuje incremental ObjectChangeSet chirurgicky na scene graph.
   *
   * Pořadí operací je záměrné:
   * 1. remove — nejdříve, stabilnější pro ID collision edge cases (remove+add stejného ID)
   * 2. add — přidá nové objekty
   * 3. update — aplikuje patch na existující objekty
   *
   * Pro update preferuje renderer.applyPatch(patch) pokud renderer ho implementuje.
   * Fallback na renderer.update(prev, next) — v tom případě potřebuje plný next objekt
   * z nodes Map (data snapshot). Caller nemusí poskytnout full object v updated[].patch.
   *
   * @param changes - incremental diff od state-sync agenta
   */
  applyChanges(changes: ObjectChangeSet): void {
    // 1. Remove first
    for (const id of changes.removed) {
      this.removeObject(id)
    }

    // 2. Add
    for (const obj of changes.added) {
      this.addObject(obj)
    }

    // 3. Update (patch-based)
    for (const { id, patch } of changes.updated) {
      const node = this.nodes.get(id)
      const type = this.nodeTypes.get(id)

      if (node === undefined || type === undefined) {
        console.warn(`[SceneGraph] applyChanges: update for unknown ID ${id}`)
        continue
      }

      const renderer = getRenderer(type)
      if (renderer === undefined) {
        console.warn(`[SceneGraph] applyChanges: no renderer for type ${type}`)
        continue
      }

      if (renderer.applyPatch !== undefined) {
        // Chirurgický patch — renderer ví co se přesně změnilo
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- patch je Partial<SlideObject>, renderer akceptuje Partial<T extends SlideObject>
        renderer.applyPatch(node.container, patch as any)
      } else {
        // Fallback: plný update s aktuálním snapotem + patch merge
        const merged = { ...node.data, ...patch } as SlideObject
        renderer.update(node.container, node.data, merged)
      }

      // Aktualizuj data snapshot v node (merge patch do existujícího stavu)
      node.data = { ...node.data, ...patch } as SlideObject
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

  /**
   * Hit test v world-space souřadnicích.
   * Vrací ID nejhořejšího objektu na daném bodě (z-order: poslední = nahoře), nebo null.
   *
   * Implementace: AABB (axis-aligned bounding box) — ignoruje rotaci objektu.
   * Rotated hit test přidáme v M7 (transform handles).
   * TODO(M7): Použít rotovaný OBB (oriented bounding box) pro přesný hit test.
   *
   * @param worldX - X souřadnice v Pixi world space
   * @param worldY - Y souřadnice v Pixi world space
   * @returns ID objektu nebo null pokud není žádný hit
   */
  hitTest(worldX: number, worldY: number): string | null {
    // Iterujeme v reverse insertion order — poslední přidaný je nahoře (highest z-order)
    const entries = [...this.nodes.entries()]

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry === undefined) continue
      const [id, node] = entry
      const { x, y, width, height } = node.data

      // AABB: bounding box vychází z dat objektu (left-top origin)
      if (worldX >= x && worldX <= x + width && worldY >= y && worldY <= y + height) {
        return id
      }
    }

    return null
  }

  /**
   * Vrátí SceneNode pro dané ID (pro interní použití a testy).
   * Neexponuj jako public API — slouží pro test introspekci.
   * @internal
   */
  getNode(id: string): { container: Container; data: SlideObject } | undefined {
    return this.nodes.get(id)
  }

  /** Počet aktuálně spravovaných objektů (pro debugging a testy). */
  get objectCount(): number {
    return this.nodes.size
  }
}
