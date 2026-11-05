/**
 * renderer/canvasRegionController.ts — applies canvasRegion.ts to the editor
 * canvas: the backing store, the region it draws, the canvas element's place
 * and the render transform, the slide's origin on the device grid (ADR 0020).
 *
 * The world keeps its coordinates: the container (the artboard and its
 * bleed, `inset: -bleed` inside the zoomed artboard) has the world's origin
 * at its corner; the canvas element is placed in it where the region is;
 * the stage is drawn through `translate(−region)` (stageRender.ts).
 */

import { Matrix } from 'pixi.js'
import type { Application } from 'pixi.js'
import type { SceneGraph } from './SceneGraph'
import {
  backingFor,
  gridFraction,
  regionAround,
  regionHolds,
  resolutionToHold,
  type Box,
  type Size,
} from './canvasRegion.js'
import { setPageOrigin, setProspectivePage, type PageGrid } from './runText/placement.js'
import { setStageRenderTransform } from './stageRender.js'

function windowRatio(): number {
  return window.devicePixelRatio || 1
}

export class CanvasRegionController {
  private backing: Size = { width: 1, height: 1 }
  /** What the renderer was last resized to here (null: never). */
  private sizedFor: { width: number; height: number; resolution: number } | null = null
  private region: Box = { x: 0, y: 0, width: 1, height: 1 }
  /** The sub-device-px shift of canvas and overlay root (CSS px of the world). */
  private shift = { x: 0, y: 0 }
  private readonly transform = new Matrix()
  /** What the canvas element and the transform were last set to (null: never). */
  private placedAt: { x: number; y: number; sx: number; sy: number; w: number; h: number } | null =
    null
  private reallocationCount = 0
  /**
   * The device px per CSS px the canvas is laid out for when its owner sets
   * it (`switchPixelRatio`); null: the window's, read at every layout.
   */
  private ownRatio: number | null
  /**
   * A ratio the owner prepares texts for before switching to it
   * (`prepareFor`): the page the canvas will draw then, kept current with
   * every layout, and who to tell when it moves.
   */
  private prospect: {
    ratio: number
    resolution: number
    page: PageGrid
    moved: () => void
  } | null = null

  constructor(
    private readonly app: Application,
    private readonly sceneGraph: SceneGraph,
    private readonly container: HTMLElement,
    private readonly overlayRoot: HTMLElement | null,
    private readonly bleed: () => number,
    /**
     * `window`: the canvas follows the window's devicePixelRatio (the editor:
     * Canvas.tsx watches it and commits the zoom's resolution on the new
     * grid). `owned`: the ratio is the one it was created at until its owner
     * hands it another (`switchPixelRatio`) — present mode, whose
     * DensityHandover prepares the slides for a new ratio off stage and
     * switches the canvas in the task its set takes over (ADR 0020 →
     * Present mode). A window resize then lays the canvas out for the ratio
     * it draws at, not for one nothing is prepared for yet.
     */
    pixelRatio: 'window' | 'owned' = 'window',
  ) {
    this.ownRatio = pixelRatio === 'owned' ? windowRatio() : null
    const canvas = app.canvas
    canvas.style.position = 'absolute'
    canvas.style.left = '0px'
    canvas.style.top = '0px'
    canvas.style.transformOrigin = '0 0'
    setStageRenderTransform(app, this.transform)
  }

  /**
   * How many times `layout()` has changed the backing store's size — the
   * canvas element is reallocated then, and a reallocated backbuffer is
   * empty: the caller draws in the same task (`renderNow`, not a frame
   * later), or the compositor shows a blank canvas. A `markDirty()` from a
   * ResizeObserver or an animation-frame callback lands a frame late — present
   * mode's density change composited an empty frame that way (2026-10-31,
   * e2e/present-density-change.spec.ts → "a reallocated backbuffer composited
   * before it was drawn"). Callers compare it before and after
   * (Canvas.tsx → drawAfterLayout).
   */
  get reallocations(): number {
    return this.reallocationCount
  }

  /** The device px per CSS px the canvas is laid out for (see the constructor's `pixelRatio`). */
  get pixelRatio(): number {
    return this.ownRatio ?? windowRatio()
  }

  /**
   * Present mode's density switch (ADR 0020 → Present mode; called through
   * Canvas.tsx → CanvasInstance.setPixelRatio by present/densityHandover.ts):
   * lay the canvas out for `ratio` device px per CSS px at `resolution` —
   * the backing store for the viewport at that ratio (reallocated when its
   * size changes), the region the store covers at the resolution, the
   * device-grid shift. The texts drawn now keep their rasters: each is
   * pinned to the resolution it was drawn at first (a text that follows the
   * renderer would rasterise again at its next draw — on stage, after
   * ready), and nothing is restaged: what is shown at the new ratio was
   * prepared for it. The caller draws before its task ends (a reallocated
   * backbuffer is empty). Returns whether the backing store was reallocated.
   */
  switchPixelRatio(ratio: number, resolution: number): boolean {
    if (this.ownRatio === null)
      throw new Error('CanvasRegionController: the canvas follows the window’s pixel ratio')
    if (!(ratio > 0) || !(resolution > 0))
      throw new Error(`bad pixel ratio ${ratio} / ${resolution}`)
    this.sceneGraph.pinTextResolution()
    this.ownRatio = ratio
    // What was prospective is the canvas's own page from here on.
    if (this.prospect !== null && Math.abs(this.prospect.ratio - ratio) < 1e-9) this.endProspect()
    const before = this.reallocationCount
    this.layout(resolution)
    return this.reallocationCount !== before
  }

  /**
   * Texts are about to be rasterised for `ratio` device px per CSS px at
   * `resolution` while the canvas still draws at its current ratio (present
   * mode's standby set, present/densityHandover.ts): publish the page the
   * canvas will draw once `switchPixelRatio(ratio, resolution)` runs — its
   * texel grid's phase and its region, computed as that switch will lay the
   * canvas out — so their rasters are placed where a canvas opened at that
   * ratio places them (runText/placement.ts → setProspectivePage). Every
   * layout until then computes it again; when it moves (a resize, a scroll
   * of the region), `moved` is told — the rasters prepared for the old one
   * are off the grid. Ends with the switch to `ratio`, or with the returned
   * function. For a canvas whose owner sets its ratio only.
   */
  prepareFor(ratio: number, resolution: number, moved: () => void): () => void {
    if (this.ownRatio === null)
      throw new Error('CanvasRegionController: the canvas follows the window’s pixel ratio')
    this.endProspect()
    const prospect = { ratio, resolution, page: this.pageAt(ratio, resolution), moved }
    this.prospect = prospect
    setProspectivePage(this.app.renderer, prospect.page)
    return () => {
      if (this.prospect === prospect) this.endProspect()
    }
  }

  private endProspect(): void {
    if (this.prospect === null) return
    this.prospect = null
    setProspectivePage(this.app.renderer, null)
  }

  /** The page the canvas would draw laid out for `ratio` at `resolution` now (`layout` after `switchPixelRatio`). */
  private pageAt(ratio: number, resolution: number): PageGrid {
    const v = this.viewportRect()
    const backing = backingFor({ width: v.width, height: v.height }, ratio)
    const region = this.regionFor(backing, resolution)
    const bleed = this.bleed()
    return {
      resolution,
      origin: { x: bleed, y: bleed },
      phase: this.gridAt(region, resolution, ratio).phase,
      region: { ...region },
    }
  }

  /** Publish the prospective page again after a layout; tell its owner when it moved. */
  private refreshProspect(): void {
    const p = this.prospect
    if (p === null) return
    const page = this.pageAt(p.ratio, p.resolution)
    if (samePage(page, p.page)) return
    p.page = page
    setProspectivePage(this.app.renderer, page)
    // Told after the layout that moved it (its owner starts the preparation over).
    queueMicrotask(() => {
      if (this.prospect === p) p.moved()
    })
  }

  /** What the controller holds now (e2e / debugging). */
  debugState(): {
    backing: Size
    region: Box
    shift: { x: number; y: number }
    viewport: DOMRect
    visible: Box | null
  } {
    return {
      backing: this.backing,
      region: this.region,
      shift: this.shift,
      viewport: this.viewportRect(),
      visible: this.visibleWorld(),
    }
  }

  /** The stage's viewport: the nearest scrolling ancestor, or the window. */
  private viewportRect(): DOMRect {
    let el: HTMLElement | null = this.container.parentElement
    while (el !== null) {
      const cs = getComputedStyle(el)
      if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY)) return el.getBoundingClientRect()
      el = el.parentElement
    }
    return new DOMRect(0, 0, window.innerWidth, window.innerHeight)
  }

  /** How the world maps to the page now: the container's corner and its scale (the live zoom). */
  private placement(): { left: number; top: number; scale: number } {
    const r = this.container.getBoundingClientRect()
    const scale = this.container.offsetWidth > 0 ? r.width / this.container.offsetWidth : 1
    return { left: r.left, top: r.top, scale: scale > 0 ? scale : 1 }
  }

  /** What the window shows of the world (CSS px of the world); null when nothing. */
  visibleWorld(): Box | null {
    const v = this.viewportRect()
    const p = this.placement()
    const left = Math.max(v.left, 0)
    const top = Math.max(v.top, 0)
    const right = Math.min(v.right, window.innerWidth)
    const bottom = Math.min(v.bottom, window.innerHeight)
    if (right <= left || bottom <= top) return null
    return {
      x: (left - p.left) / p.scale,
      y: (top - p.top) / p.scale,
      width: (right - left) / p.scale,
      height: (bottom - top) / p.scale,
    }
  }

  /** The visible part of the world in canvas space for staging and uploads (world CSS px), widened by `widen`. */
  visibleStageRect(widen = 0.25): Box | null {
    const v = this.visibleWorld()
    if (v === null) return null
    return {
      x: v.x - v.width * widen,
      y: v.y - v.height * widen,
      width: v.width * (1 + 2 * widen),
      height: v.height * (1 + 2 * widen),
    }
  }

  /**
   * Lay the canvas out for `resolution` (default: the renderer's): the
   * backing store for the viewport (reallocated only when its pixel count
   * changes — a window resize, a new pixel ratio), the region around what
   * the window shows, the device-grid shift. Returns whether anything moved.
   */
  layout(resolution = this.app.renderer.resolution): boolean {
    const dpr = this.pixelRatio
    const v = this.viewportRect()
    const backing = backingFor({ width: v.width, height: v.height }, dpr)
    const renderer = this.app.renderer
    const screenW = backing.width / resolution
    const screenH = backing.height / resolution
    // Resized only when what it was sized for changed. Not compared with
    // `renderer.screen`: Pixi updates the screen from its texture's frame,
    // which keeps its old size when the pixel count does not change — at a
    // resolution other than the first the screen never matched, every layout
    // resized, dropped the canvas's placement and drew a frame (a zoom
    // gesture that ended where it started drew one at its commit:
    // `viewport.zoom.wheel` settle 21 → 332 ms, 2026-10-30).
    const sized = this.sizedFor
    if (
      sized === null ||
      backing.width !== this.backing.width ||
      backing.height !== this.backing.height ||
      Math.abs(renderer.resolution - resolution) > 1e-9 ||
      Math.abs(sized.resolution - resolution) > 1e-9 ||
      Math.abs(sized.width - screenW) > 1e-6 ||
      Math.abs(sized.height - screenH) > 1e-6
    ) {
      // Same pixel count: Pixi keeps the backbuffer (TextureSource.resize).
      const was = { width: renderer.canvas.width, height: renderer.canvas.height }
      renderer.resize(screenW, screenH, resolution)
      // A canvas element whose width or height is set to another value is cleared.
      if (renderer.canvas.width !== was.width || renderer.canvas.height !== was.height)
        this.reallocationCount++
      this.sizedFor = { width: screenW, height: screenH, resolution }
      this.backing = backing
      // autoDensity wrote the canvas's CSS size; apply() writes its own again.
      this.placedAt = null
    }
    this.region = this.regionFor(backing, resolution)
    return this.apply(resolution)
  }

  /**
   * The region `layout` gives a backing store of `backing` at `resolution`:
   * around what the window shows, kept where it is while it still holds the
   * view at the same size.
   */
  private regionFor(backing: Size, resolution: number): Box {
    const visible = this.visibleWorld() ?? this.region
    const region = regionAround(visible, backing, resolution)
    const same =
      Math.abs(region.width - this.region.width) < 1e-9 &&
      Math.abs(region.height - this.region.height) < 1e-9 &&
      regionHolds(this.region, visible)
    return same ? this.region : region
  }

  /**
   * Where the canvas's corner goes for `region` at `resolution` and `dpr`:
   * the world point at it (a whole device px at or next to the region's
   * corner, from the world's origin on the page), and the texel grid's phase
   * there (runText/placement.ts → setPageOrigin).
   */
  private gridAt(
    region: Box,
    resolution: number,
    dpr: number,
  ): { at: { x: number; y: number }; phase: { x: number; y: number } } {
    const p = this.placement()
    // Device px of the world's origin (the container's corner), and of the
    // canvas's corner — a whole device px at or next to the region's.
    const originDevice = { x: p.left * dpr, y: p.top * dpr }
    const z = resolution
    const corner = {
      x: Math.round(originDevice.x + region.x * z),
      y: Math.round(originDevice.y + region.y * z),
    }
    // The world point at that corner: what the render transform moves to (0, 0).
    const at = { x: (corner.x - originDevice.x) / z, y: (corner.y - originDevice.y) / z }
    return { at, phase: { x: gridFraction(at.x * z), y: gridFraction(at.y * z) } }
  }

  /**
   * After a scroll or a live zoom: move the region if the view left it, and
   * lower the resolution at once if the view outgrew it (a zoom-out gesture;
   * texts keep their rasters — the caller pins them). Returns whether the
   * canvas must be drawn again.
   */
  follow(beforeLowering: () => void = () => {}): { moved: boolean; resolution: number | null } {
    const visible = this.visibleWorld()
    if (visible === null) return { moved: false, resolution: null }
    const res = this.app.renderer.resolution
    if (regionHolds(this.region, visible)) {
      return { moved: this.apply(res), resolution: null }
    }
    const fits = visible.width <= this.region.width && visible.height <= this.region.height
    if (fits) {
      this.region = regionAround(visible, this.backing, res)
      this.apply(res)
      return { moved: true, resolution: null }
    }
    const lower = resolutionToHold(visible, this.backing, res)
    beforeLowering()
    this.layout(lower)
    return { moved: true, resolution: lower }
  }

  /** Place the canvas, the overlay root and the slide for the current region. Returns whether anything changed. */
  private apply(resolution: number): boolean {
    const bleed = this.bleed()
    const z = resolution
    const { at, phase } = this.gridAt(this.region, z, this.pixelRatio)
    // Chrome draws a replaced element (the canvas) at whole px of its own
    // coordinates — the zoomed artboard's CSS px here: a canvas at
    // `top: 1092.5px` at 400 % was drawn 2 device px off, and a canvas
    // 772.33 px wide was scaled by the snap. So the box is laid out at whole
    // CSS px, and a transform (never snapped) takes it the rest of the way —
    // to the corner, at exactly the backing store's size on the device.
    const box = {
      left: Math.floor(at.x),
      top: Math.floor(at.y),
      width: Math.max(1, Math.ceil(this.backing.width / z)),
      height: Math.max(1, Math.ceil(this.backing.height / z)),
    }
    const tx = at.x - box.left
    const ty = at.y - box.top
    const sx = this.backing.width / (box.width * z)
    const sy = this.backing.height / (box.height * z)
    const placed = this.placedAt
    const changed =
      placed === null ||
      placed.x !== at.x ||
      placed.y !== at.y ||
      placed.sx !== sx ||
      placed.sy !== sy ||
      placed.w !== box.width ||
      placed.h !== box.height
    if (changed) {
      const canvas = this.app.canvas
      canvas.style.left = `${box.left}px`
      canvas.style.top = `${box.top}px`
      canvas.style.width = `${box.width}px`
      canvas.style.height = `${box.height}px`
      // Scaled about the box's corner: the default origin (its centre) moved
      // the corner by (1 − s) × size / 2 — a device px at 349 %.
      canvas.style.transformOrigin = '0 0'
      canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`
      this.transform.set(1, 0, 0, 1, -at.x, -at.y)
      this.placedAt = { x: at.x, y: at.y, sx, sy, w: box.width, h: box.height }
    }
    if (this.overlayRoot !== null && this.overlayRoot.style.transform !== '')
      this.overlayRoot.style.transform = ''
    // The texel grid's phase in the world's device px: text rasters land on
    // it (runText/placement.ts → setPageOrigin).
    this.shift = phase
    this.sceneGraph.setSlideOrigin(bleed, bleed)
    setPageOrigin(this.app.renderer, { x: bleed, y: bleed }, phase, this.region)
    this.refreshProspect()
    return changed
  }

  destroy(): void {
    this.endProspect()
    setStageRenderTransform(this.app, null)
  }
}

function samePage(a: PageGrid, b: PageGrid): boolean {
  const r = (x: PageGrid['region'], y: PageGrid['region']): boolean =>
    x === null || y === null
      ? x === y
      : x.x === y.x && x.y === y.y && x.width === y.width && x.height === y.height
  return (
    a.resolution === b.resolution &&
    a.origin.x === b.origin.x &&
    a.origin.y === b.origin.y &&
    a.phase.x === b.phase.x &&
    a.phase.y === b.phase.y &&
    r(a.region, b.region)
  )
}
