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
import * as Y from 'yjs'
import { getRenderer } from './objectRenderers'
import { setTableCellFaded } from './objectRenderers/tableRenderer.js'
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

  /** Slide-space origin in Pixi world coords — read by hit-test helpers
   *  that need to translate slide coords to world before walking
   *  Container.toLocal(). Avoids hardcoding the bleedPx default at the
   *  call site. */
  getSlideOriginX(): number {
    return this.slideOriginX
  }
  getSlideOriginY(): number {
    return this.slideOriginY
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

      // P16: flip is a uniform transform handled centrally so individual
      // renderers don't have to thread `flipH`/`flipV` through their
      // applyPatch implementations. Pivot is already at the object's
      // centre (every renderer sets it that way), so scale = ±1
      // mirrors the contents around the centre axes — bounds and hit
      // tests stay intact.
      if ('flipH' in patch || 'flipV' in patch) {
        const p = patch as { flipH?: boolean; flipV?: boolean }
        if ('flipH' in patch) node.container.scale.x = p.flipH === true ? -1 : 1
        if ('flipV' in patch) node.container.scale.y = p.flipV === true ? -1 : 1
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
   * P15: hide / restore a text object's Pixi text node during inline
   * edit. The contenteditable overlay is the visible rendering while
   * the user types; we keep the Pixi node in the render tree (so the
   * HTMLText pipe still rasterises Y.Text changes asynchronously) and
   * only toggle alpha. Centralised here so the overlay no longer has
   * to reach into Pixi via a window global.
   *
   * No-op when the id is unknown or its container has no text child.
   */
  setTextNodeFaded(id: string, faded: boolean): void {
    // M29 — table cell ids are encoded as `${tableId}#${r},${c}`. The
    // cell isn't a slide-object so we look up the table's container
    // and let `setTableCellFaded` resolve which HTMLText to fade by
    // walking the table renderer's Y.Text-keyed cell map.
    const hashIdx = id.indexOf('#')
    if (hashIdx > 0) {
      const tableId = id.slice(0, hashIdx)
      const tableContainer = this.nodes.get(tableId)?.container
      if (tableContainer !== undefined) {
        // Look up the cell's Y.Text from the table's snapshot.
        const yText = this._cellYTextForId(tableId, id.slice(hashIdx + 1))
        if (yText !== null) {
          setTableCellFaded(tableContainer, yText, faded)
          this.markDirty()
          return
        }
      }
    }
    const container = this.nodes.get(id)?.container
    if (container === undefined) return
    // Match the same heuristic textRenderer uses internally: the
    // HTMLText child is the only one that exposes `.anchor`. Graphics
    // (mask) and filter sprites do not.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textChild = container.children.find((c) => (c as any).anchor !== undefined) as
      | { alpha: number }
      | undefined
    if (textChild === undefined) return
    textChild.alpha = faded ? 0 : 1
    this.markDirty()
  }

  /** Resolve a table cell's Y.Text from the current snapshot. Used
   *  by `setTextNodeFaded` to translate a synthetic cell id into the
   *  Y.Text identity the table renderer keys its per-cell HTMLText
   *  sub-nodes by. */
  private _cellYTextForId(tableId: string, rcSuffix: string): Y.Text | null {
    const parts = rcSuffix.split(',')
    if (parts.length !== 2) return null
    const r = Number(parts[0])
    const c = Number(parts[1])
    if (!Number.isInteger(r) || !Number.isInteger(c)) return null
    const data = this.nodes.get(tableId)?.data
    if (data === undefined || data.type !== 'table') return null
    const cell = data.rows[r]?.[c]
    if (cell === undefined) return null
    return cell.text instanceof Y.Text ? cell.text : null
  }

  /**
   * P15: re-rasterise every Text node whose `fontFamily` references the
   * given family. Pixi v8 caches glyph atlases keyed by the resolved
   * font; when a FontFace finishes loading AFTER a text node mounted,
   * the atlas still holds fallback glyphs. Calling textRenderer's
   * applyPatch with the same fontFamily forces TextStyle to rebuild,
   * which invalidates the atlas and Pixi re-rasterises with the
   * now-installed font.
   *
   * @param family — canonical family name passed to FontFace; matches
   *   either an exact `fontFamily` value or appears as a comma-separated
   *   token inside one (e.g. `"Inter, sans-serif"`).
   */
  refreshTextNodesUsingFamily(family: string): void {
    if (family === '') return
    const tokens = (raw: string): string[] =>
      raw.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))

    // P15: HTMLText uses its own pipeline (`htmlText` system,
    // SVG-foreignObject rasterisation) that is NOT served by the
    // `_activeTextures` cache nuked above. Its HTMLTextPipe only
    // re-rasterises when `batchableHTMLText.currentKey !== styleKey`
    // — and styleKey is computed from the style fields, so re-applying
    // the SAME fontFamily produces the SAME styleKey and the pipe
    // returns the cached fallback-glyph texture. We must invalidate
    // each HTMLText's gpu-data currentKey directly so the pipe is
    // forced to dispatch a fresh _updateGpuText, which re-runs
    // `getFontCss` and embeds the now-loaded FontFace into the SVG.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rendererUid = (this.app.renderer as any).uid as number | undefined

    let touched = 0
    for (const [, node] of this.nodes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = node.data as any
      if (data?.type !== 'text') continue
      const fam: unknown = data.fontFamily
      const matchesBox = typeof fam === 'string' && fam !== '' && tokens(fam).includes(family)
      // P15: per-run fontFamily — when a deck font finishes loading
      // AFTER the user already applied it via inline format on a
      // sub-range, the box-level fontFamily may not contain it. Walk
      // the Y.Text deltas so those runs also get re-rasterised once
      // the FontFace lands. Without this, run-level custom fonts stay
      // in the fallback face indefinitely after a fresh upload.
      let matchesRun = false
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = data.text as any
      if (!matchesBox && t !== undefined && t !== null && typeof t.toDelta === 'function') {
        try {
          const delta = t.toDelta() as Array<{ attributes?: Record<string, unknown> }>
          for (const op of delta) {
            const runFam = op.attributes?.['fontFamily']
            if (typeof runFam === 'string' && runFam === family) {
              matchesRun = true
              break
            }
          }
        } catch {
          /* defensive — Y.Text may not be initialised yet */
        }
      }
      if (!matchesBox && !matchesRun) continue

      // Find the HTMLText child (only child with `.anchor` on a text
      // container in our renderer) and reset its gpu-data cache key.
      const textChild = node.container.children.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c) => (c as any).anchor !== undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any
      if (textChild !== undefined && rendererUid !== undefined) {
        const gpu = textChild._gpuData?.[rendererUid]
        if (gpu !== undefined) {
          gpu.currentKey = ''
        }
        textChild._didTextUpdate = true
        if (typeof textChild.onViewUpdate === 'function') {
          try {
            textChild.onViewUpdate()
          } catch {
            /* ignore */
          }
        }
      }

      const renderer = getRenderer('text')
      if (renderer !== undefined && renderer.applyPatch !== undefined) {
        // applyPatch with the same fontFamily rebuilds the HTMLTextStyle
        // (new instance reference); combined with the gpu-data cache
        // reset above, the pipe now dispatches a fresh _updateGpuText
        // that re-extracts font CSS and embeds the installed FontFace.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderer.applyPatch(node.container, { fontFamily: fam } as any)
      }

      touched++
    }
    if (touched > 0) this.markDirty()
  }

  /**
   * Re-render every text node flagged `isSlideNumber` so it picks up the
   * latest value from the slide-number context. Walks the entire Pixi
   * tree (including container instances and nested components) since
   * page-number leaves can live anywhere — top-level objects, instance
   * children, nested instances.
   */
  refreshSlideNumberTexts(): void {
    const textRenderer = getRenderer('text') as
      | { refreshSlideNumberText?: (n: Container) => boolean }
      | undefined
    if (textRenderer?.refreshSlideNumberText === undefined) return
    let touched = 0
    const walk = (c: Container): void => {
      if (textRenderer.refreshSlideNumberText!(c)) touched++
      for (const child of c.children) {
        if (child instanceof Container) walk(child)
      }
    }
    walk(this.root)
    if (touched > 0) this.markDirty()
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
  adoptSlideRoot(
    nextRoot: Container,
    nextNodes: Array<SceneNode & { id: string }>,
    nextBackgroundContainer?: Container,
  ): void {
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
    // with it. When the caller provides an `nextBackgroundContainer` that's
    // already parented inside `nextRoot` (the playTransition path — the
    // incoming background is built as part of the animated root so it
    // transitions together with the objects), claim it. Otherwise null
    // so the next `ensureBackgroundContainer()` call creates a fresh one.
    if (nextBackgroundContainer !== undefined && nextBackgroundContainer.parent === nextRoot) {
      this.backgroundContainer = nextBackgroundContainer
    } else {
      this.backgroundContainer = null
    }

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

      // Lines and arrows have a degenerate AABB (height=0 for horizontal,
      // width=0 for vertical, etc.) so a strict bounds test makes them
      // pixel-perfect to hit. Use a point-to-segment distance test with a
      // generous slack pad so the click target is at least ~10 px wide.
      // For diagonal lines this also avoids the opposite problem of the
      // AABB being huge but the actual line covering only a thin diagonal
      // — unreachable corners no longer steal clicks.
      if (node.data.type === 'line' || node.data.type === 'arrow') {
        const ld = node.data
        const threshold = Math.max(ld.strokeWidth / 2 + 6, 10)
        const dist = distanceToSegment(
          localPoint.x,
          localPoint.y,
          ld.p1.x,
          ld.p1.y,
          ld.p2.x,
          ld.p2.y,
        )
        if (dist <= threshold) return id
        continue
      }

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

  /**
   * M16 P8 — Compute ObjectBounds for an arbitrary Container that is NOT
   * tracked in `nodes` (e.g. a phantom instance-leaf container).
   *
   * The container is expected to follow the same pivot convention as
   * slide-level nodes: pivot at (w/2, h/2), container.x/y is the centre.
   * `slideObj` supplies width, height (and optionally rotation). The
   * container's world-space position is derived from Pixi's global
   * transform chain so it correctly accounts for the instance's
   * outer scale/translate/rotate — the leaf's inner-container transform
   * is relative to the instance, not the artboard.
   *
   * Returns null when the container has been destroyed.
   */
  getContainerBoundsFromData(container: Container, slideObj: SlideObject): ObjectBounds | null {
    try {
      if (container.destroyed) return null
    } catch {
      return null
    }
    const w = slideObj.width
    const h = slideObj.height
    const halfW = w / 2
    const halfH = h / 2

    // Walk the Pixi world transform to express the container's local-space
    // corners in artboard (slide) space. container.toGlobal() converts a
    // local point to Pixi world space; we then subtract the slide origin to
    // recover slide coords.
    const cx = this.slideOriginX
    const cy = this.slideOriginY

    // Four local corners. All leaf renderers (rectangle, ellipse, image, …)
    // draw their graphics from local (0,0) to (w,h) and set pivot at
    // (w/2, h/2). So local (0,0) is the rendering top-left, NOT the centre.
    // toGlobal() operates in the container's local frame, so we pass the
    // actual drawn corners (0,0)→(w,h) and compute the centre at (halfW,halfH).
    const localCorners = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ]

    const scratch = new Point()
    const worldCorners = localCorners.map((lc) => {
      container.toGlobal({ x: lc.x, y: lc.y }, scratch)
      return { x: scratch.x - cx, y: scratch.y - cy }
    })

    const xs = worldCorners.map((c) => c.x)
    const ys = worldCorners.map((c) => c.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)

    // Centre in slide coords: the pivot is at local (halfW, halfH).
    container.toGlobal({ x: halfW, y: halfH }, scratch)
    const centreX = scratch.x - cx
    const centreY = scratch.y - cy

    // Rotation: use the container's own rotation but account for any rotation
    // accumulated from parent containers (inner + instance).
    // worldTransform decomposition: atan2(b, a) where a,b are first-column
    // of the 2×2 rotation block.
    const wt = container.worldTransform
    const rotation = Math.atan2(wt.b, wt.a)

    return {
      world: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      corners: worldCorners,
      center: { x: centreX, y: centreY },
      rotation,
    }
  }
}

/**
 * Euclidean distance from point (px, py) to the line segment (ax, ay)→(bx, by).
 * Standard projection-onto-segment + clamp formula. Used for line/arrow hit
 * testing where AABB-based tests are degenerate.
 */
function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax
  const aby = by - ay
  const lenSq = abx * abx + aby * aby
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * abx + (py - ay) * aby) / lenSq
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const cx = ax + t * abx
  const cy = ay + t * aby
  return Math.hypot(px - cx, py - cy)
}
