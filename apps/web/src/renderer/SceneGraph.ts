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

import { Container, Point } from 'pixi.js'
import type { Application } from 'pixi.js'
import { getRenderer } from './objectRenderers'
import type { SlideObject, SlideObjectType, ObjectChangeSet } from '@narrative/shared'
import type { ObjectBounds } from './types'
import type { RenderScheduler } from './RenderScheduler'

interface SceneNode {
  container: Container
  data: SlideObject
}

export class SceneGraph {
  private readonly app: Application
  /**
   * Root container přidaný na app.stage. Všechny slide objekty jsou jeho children.
   *
   * Mutable (not `readonly`) because M13 Magic Move / slide transitions build
   * an "incoming" Container off-stage and then hand it over to SceneGraph via
   * `adoptSlideRoot()` — at that point the SceneGraph's root reference is
   * replaced wholesale rather than mutated in place.
   */
  private root: Container
  /** Mapa objectId → SceneNode (Container + poslední data snapshot). */
  private readonly nodes = new Map<string, SceneNode>()
  /**
   * Mapa objectId → SlideObjectType.
   * Umožňuje O(1) renderer lookup v applyChanges bez potřeby full node scan.
   * Plněna při addObject/applyChanges.added, mazána při removeObject/applyChanges.removed.
   */
  private readonly nodeTypes = new Map<string, SlideObjectType>()
  /**
   * Reverse lookup Container → objectId, kept in sync with `nodes`.
   * Used by hitTest to walk root.children (visual z-order is the source
   * of truth after layer reorder) and resolve the topmost container
   * back to its slide-object id in O(1).
   */
  private readonly containerToId = new Map<Container, string>()
  /**
   * Scratch Point pro hitTest — reuse per-frame, žádný GC churn.
   * Inicializován lazily při prvním hitTest volání.
   */
  private _hitTestWorldPoint: Point | null = null
  private _hitTestLocalPoint: Point | null = null

  /**
   * P2: dedicated Container for the artboard background, always the
   * FIRST child of `root` so every slide object stacks on top. Created
   * lazily on first background access, persists across object adds /
   * removes (it's not in the `nodes` map).
   */
  private backgroundContainer: Container | null = null

  /**
   * P2: slide bounds in pixi coords (= artboard CSS size). Used to fade
   * objects whose AABB sits entirely outside the artboard. Zero means
   * "no bounds set yet" → all objects at full alpha.
   */
  private slideBoundsW = 0
  private slideBoundsH = 0

  /**
   * P2: bleed offset — pixi-world position of slide (0,0). Non-zero when
   * Canvas renders with a bleed margin around the artboard so objects
   * dragged outside remain visible.
   */
  private slideOriginX = 0
  private slideOriginY = 0

  /**
   * P12b: optional render scheduler. When set, every Pixi scene mutation
   * (add/remove/update/reorder/origin/bounds change) calls `markDirty()`
   * so a rAF-coalesced render lands on the next frame. Pixi's auto-render
   * loop is OFF (`autoStart: false` in Canvas.tsx), so without this poke
   * the new scene state would never reach the screen.
   *
   * Null is allowed for tests + headless thumbnail rendering.
   */
  private scheduler: RenderScheduler | null = null

  constructor(app: Application) {
    this.app = app
    this.root = new Container()
    this.app.stage.addChild(this.root)
  }

  /**
   * P12b: install (or replace) the render scheduler. Canvas.tsx wires this
   * up after `app.init()`.
   */
  setRenderScheduler(scheduler: RenderScheduler | null): void {
    this.scheduler = scheduler
  }

  private markDirty(): void {
    this.scheduler?.markDirty()
  }

  /**
   * P2: shifts the slide root so that slide (0,0) sits at
   * (originX, originY) in pixi world coords. Used to give the canvas a
   * bleed margin around the artboard.
   */
  setSlideOrigin(originX: number, originY: number): void {
    if (this.slideOriginX === originX && this.slideOriginY === originY) return
    this.slideOriginX = originX
    this.slideOriginY = originY
    this.root.x = originX
    this.root.y = originY
    this.markDirty()
  }

  /**
   * P2: sets the artboard size in pixi coords (= slide-local px). Drives
   * out-of-bounds fade. No-op if unchanged.
   */
  setSlideBounds(width: number, height: number): void {
    if (this.slideBoundsW === width && this.slideBoundsH === height) return
    this.slideBoundsW = width
    this.slideBoundsH = height
    for (const node of this.nodes.values()) {
      this.applyOutsideFade(node)
    }
    this.markDirty()
  }

  private applyOutsideFade(node: SceneNode): void {
    const w = this.slideBoundsW
    const h = this.slideBoundsH
    // Respect the object's authored opacity — outside-fade multiplies
    // on top of it so tuning opacity in the Inspector still does what
    // it says. Objects without an opacity field default to 1.
    const baseAlpha =
      typeof (node.data as { opacity?: number }).opacity === 'number'
        ? (node.data as { opacity: number }).opacity
        : 1
    if (w === 0 || h === 0) {
      node.container.alpha = baseAlpha
      return
    }
    const { x, y, width, height } = node.data
    const outside = x + width <= 0 || x >= w || y + height <= 0 || y >= h
    node.container.alpha = outside ? baseAlpha * 0.35 : baseAlpha
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
    const node = { container, data }
    this.nodes.set(data.id, node)
    this.nodeTypes.set(data.id, data.type)
    this.containerToId.set(container, data.id)
    this.applyOutsideFade(node)
    this.markDirty()
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
    this.applyOutsideFade(node)
    this.markDirty()
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
    this.containerToId.delete(node.container)
    this.markDirty()
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

    // 3. Re-sync Pixi child order to match Y.Array / `changes.snapshot`.
    // `addObject` appends to the end of root.children; without this
    // step a layer-order mutation that expressed itself as "removed X +
    // added X" would leave X drawn on top even though Y.Doc moved it
    // to the back. The artboard-background container (P2) is pinned at
    // child 0, so object containers live from `bgOffset` onward.
    const bgOffset = this.backgroundContainer !== null ? 1 : 0
    for (let i = 0; i < changes.snapshot.length; i++) {
      const obj = changes.snapshot[i]
      if (obj === undefined) continue
      const node = this.nodes.get(obj.id)
      if (node === undefined) continue
      const targetIdx = i + bgOffset
      const currentIdx = this.root.getChildIndex(node.container)
      if (currentIdx !== targetIdx && targetIdx < this.root.children.length) {
        this.root.setChildIndex(node.container, targetIdx)
      }
    }

    // 4. Update (patch-based)
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
      this.applyOutsideFade(node)
    }

    if (changes.removed.length > 0 || changes.added.length > 0 || changes.updated.length > 0) {
      this.markDirty()
    }
  }

  // -------------------------------------------------------------------------
  // M13 — Slide transition support
  // -------------------------------------------------------------------------

  /**
   * Returns the Pixi Application that owns the stage — lets present-mode
   * transitions parent a temporary "incoming" container as a sibling of
   * `this.root` during the cross-slide animation.
   */
  getApp(): Application {
    return this.app
  }

  /**
   * Returns the active root Container. Present-mode transitions treat this
   * as the "outgoing" container when wiring runSlideTransition().
   */
  getRoot(): Container {
    return this.root
  }

  /**
   * Looks up the Container for a given object id. Present-mode transitions
   * use this to build the Magic Move pair list (outgoing Container per id
   * paired with the freshly-mounted incoming Container).
   */
  getContainer(id: string): Container | undefined {
    return this.nodes.get(id)?.container
  }

  /**
   * P6 E2E: full list of ids currently mounted in the scene graph. Used
   * by Playwright specs to assert the Pixi side matches Y.Doc after a
   * layer reorder.
   */
  getMountedIds(): string[] {
    return [...this.nodes.keys()]
  }

  /**
   * P2: returns (and lazily creates) the artboard-background Container —
   * kept as the FIRST child of the active root so every slide object
   * stacks above it. Consumers call this from the background observer +
   * paint into it via `applyBackground()`.
   */
  ensureBackgroundContainer(): Container {
    if (this.backgroundContainer === null || this.backgroundContainer.destroyed) {
      this.backgroundContainer = new Container()
      this.backgroundContainer.eventMode = 'none'
      this.root.addChildAt(this.backgroundContainer, 0)
      this.markDirty()
    } else if (this.backgroundContainer.parent !== this.root) {
      this.root.addChildAt(this.backgroundContainer, 0)
      this.markDirty()
    }
    return this.backgroundContainer
  }

  /**
   * Adopts a pre-built "incoming" slide root as the new active root. Called
   * by the present-mode transition runner AFTER `runSlideTransition()`
   * resolves — swaps the SceneGraph's bookkeeping to match what's now on
   * stage without re-mounting everything from scratch (which would cause a
   * visible flash between the transition end and the Y.Doc observer diff).
   *
   * Contract:
   *   - `nextRoot` is already on stage. This call removes the old root,
   *     clears all per-object state (nodes + nodeTypes), and installs the
   *     new root + its per-object entries. Old containers are destroyed.
   *   - `nextNodes` must list every direct slide-object child of nextRoot
   *     keyed by id. SceneGraph trusts this mapping verbatim and does not
   *     re-scan.
   */
  adoptSlideRoot(nextRoot: Container, nextNodes: Array<SceneNode & { id: string }>): void {
    // Destroy the previous root and all its children (the outgoing slide's
    // nodes) in one pass. This also runs each renderer's destroy() path via
    // Container.destroy({ children: true }), because renderers only hang
    // extra state as Symbol-tagged metadata rather than via a destroy hook —
    // texture release is the exception, handled through ResourceManager.
    if (this.root !== nextRoot && !this.root.destroyed) {
      if (this.root.parent !== null) {
        this.root.parent.removeChild(this.root)
      }
      // Explicitly walk the old nodes via their registered renderers so that
      // ResourceManager textures + renderer-side bookkeeping get cleaned up,
      // not just the Pixi Container tree.
      for (const id of [...this.nodes.keys()]) {
        this.removeObject(id)
      }
      this.root.destroy({ children: false })
    } else {
      // Same-instance no-op guard.
      this.nodes.clear()
      this.nodeTypes.clear()
      this.containerToId.clear()
    }

    this.root = nextRoot
    this.root.x = this.slideOriginX
    this.root.y = this.slideOriginY
    if (nextRoot.parent === null) {
      this.app.stage.addChild(nextRoot)
    }
    // Background container was a child of the OLD root and got destroyed
    // with it. Drop the reference so the next `ensureBackgroundContainer()`
    // call creates a fresh one on the new root.
    this.backgroundContainer = null

    for (const entry of nextNodes) {
      const node = { container: entry.container, data: entry.data }
      this.nodes.set(entry.id, node)
      this.nodeTypes.set(entry.id, entry.data.type)
      this.containerToId.set(entry.container, entry.id)
      this.applyOutsideFade(node)
    }
    this.markDirty()
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
   * M7: Respektuje rotaci objektu pomocí Pixi container.toLocal() — transformuje
   * world point do object-local space (zohledňuje pivot + rotaci) a testuje vůči
   * local AABB (0,0) → (width, height).
   *
   * Pro rotation=0 je výsledek identický s původním AABB chováním (backward compat).
   *
   * TODO(M29 / ellipse polish): Striktní elliptic hit test v ellipse rovnici
   * (x/a)²+(y/b)²≤1 místo AABB. Pro M7 editor UX je AABB dostatečně user-friendly.
   *
   * Performance: scratch Point objekty jsou reused mezi voláními — žádný GC churn
   * na per-frame hot path.
   *
   * @param worldX - X souřadnice v Pixi world space
   * @param worldY - Y souřadnice v Pixi world space
   * @returns ID objektu nebo null pokud není žádný hit
   */
  hitTest(worldX: number, worldY: number): string | null {
    // Lazy init scratch points — Point konstruktor vyžaduje Pixi runtime
    if (this._hitTestWorldPoint === null) {
      this._hitTestWorldPoint = new Point()
      this._hitTestLocalPoint = new Point()
    }
    const worldPoint = this._hitTestWorldPoint
    const localPoint = this._hitTestLocalPoint!

    // Editor hands us slide-local coords (relative to the artboard
    // top-left). With P2 bleed the pixi "world" origin is offset by
    // slideOrigin, so we convert slide-local → pixi world before
    // letting container.toLocal() walk the transform chain.
    worldPoint.set(worldX + this.slideOriginX, worldY + this.slideOriginY)

    // Walk the live Pixi child list in reverse so the topmost (last
    // drawn) container wins. Iterating `this.nodes` insertion order
    // looked correct historically — every newly added object both
    // appended to root.children AND was the most-recently inserted
    // map entry. P6 layer reorder broke that invariant: setChildIndex
    // mutates Pixi z-order without touching the Map, so the Map's
    // reverse iteration ends up returning the object that USED to be
    // on top, leaving the moved rect "stuck" as the hit-test winner
    // even after Send-to-back. The Pixi child list is the source of
    // truth for visual stacking; use it.
    const children = this.root.children
    for (let i = children.length - 1; i >= 0; i--) {
      const container = children[i] as Container | undefined
      if (container === undefined) continue
      // Skip the artboard background container (when present it sits
      // at index 0 and is not registered in `nodes`); also skip
      // anything else not tracked as a slide object.
      const id = this.containerToId.get(container)
      if (id === undefined) continue
      const node = this.nodes.get(id)
      if (node === undefined) continue
      const { width, height } = node.data

      node.container.toLocal(worldPoint, undefined, localPoint)

      if (
        localPoint.x >= 0 &&
        localPoint.x <= width &&
        localPoint.y >= 0 &&
        localPoint.y <= height
      ) {
        return id
      }
    }

    return null
  }

  /**
   * Vrátí bounds objektu v různých formách pro editor-ui.
   *
   * world: AABB v world coords (axis-aligned bounding box rotovaného obdélníku).
   * corners: 4 rohy v world coords po aplikaci rotace (TL, TR, BR, BL clockwise).
   * center: střed objektu = container.x/y (pivot point po offsetu).
   * rotation: container.rotation v radiánech.
   *
   * Výpočet corners: z definice objektu (data.width × height) s pivot na středu,
   * container.x/y je středový bod. Aplikujeme rotaci ručně z local corners → world.
   *
   * @param id - ID objektu
   * @returns ObjectBounds nebo null pokud objekt neexistuje
   */
  getBounds(id: string): ObjectBounds | null {
    const node = this.nodes.get(id)
    if (node === undefined) return null

    const { container, data } = node
    const w = data.width
    const h = data.height
    // container.x/y je střed objektu (pivot = w/2, h/2 nastavuje renderer)
    const cx = container.x
    const cy = container.y
    const θ = container.rotation

    const cosθ = Math.cos(θ)
    const sinθ = Math.sin(θ)

    const halfW = w / 2
    const halfH = h / 2

    // Local corners relativně ke středu (před rotací)
    const localCorners = [
      { x: -halfW, y: -halfH }, // TL
      { x: halfW, y: -halfH }, // TR
      { x: halfW, y: halfH }, // BR
      { x: -halfW, y: halfH }, // BL
    ]

    // Transformace do world space: rotace kolem středu + posun na cx/cy
    const corners = localCorners.map((p) => ({
      x: cx + p.x * cosθ - p.y * sinθ,
      y: cy + p.x * sinθ + p.y * cosθ,
    }))

    // AABB z world corners
    const xs = corners.map((c) => c.x)
    const ys = corners.map((c) => c.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)

    return {
      world: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      corners,
      center: { x: cx, y: cy },
      rotation: θ,
    }
  }

  /**
   * Vrátí union bounds pro skupinu objektů (multi-select).
   *
   * Výsledný AABB je sjednocením world AABB všech zadaných objektů.
   * rotation je vždy 0 — multi-select group nemá vlastní rotaci
   * (transform handles pro group rotation jsou editor-ui concern).
   * corners odpovídají rohům merged AABB (axis-aligned).
   * center je střed merged AABB.
   *
   * Objekty, které neexistují v scene graph, jsou tiše ignorovány.
   * Vrátí null pokud žádný ze zadaných ids neexistuje.
   *
   * @param ids - pole ID objektů
   * @returns union ObjectBounds nebo null
   */
  getMultiBounds(ids: string[]): ObjectBounds | null {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let found = false

    for (const id of ids) {
      const b = this.getBounds(id)
      if (b === null) continue
      found = true
      if (b.world.x < minX) minX = b.world.x
      if (b.world.y < minY) minY = b.world.y
      if (b.world.x + b.world.width > maxX) maxX = b.world.x + b.world.width
      if (b.world.y + b.world.height > maxY) maxY = b.world.y + b.world.height
    }

    if (!found) return null

    const w = maxX - minX
    const h = maxY - minY
    const cx = minX + w / 2
    const cy = minY + h / 2

    return {
      world: { x: minX, y: minY, width: w, height: h },
      corners: [
        { x: minX, y: minY }, // TL
        { x: maxX, y: minY }, // TR
        { x: maxX, y: maxY }, // BR
        { x: minX, y: maxY }, // BL
      ],
      center: { x: cx, y: cy },
      rotation: 0,
    }
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

  /**
   * Public accessor for the root Container.
   *
   * Exposed so that consumers like PeerCursors and the thumbnail renderer can
   * reference the root without an unsafe cast. The root is the direct child of
   * app.stage that holds all slide objects.
   *
   * Read-only intent — callers must not mutate or destroy this container.
   */
  get rootContainer(): Container {
    return this.root
  }
}
