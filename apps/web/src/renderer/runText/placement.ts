/**
 * renderer/runText/placement.ts — where a run raster lands on the device
 * pixel grid, and keeping it painted for that place (ADR 0018 → Placement).
 *
 * The page rounds a text's baselines (and underlines, and clips) to device
 * pixels where the text is: in absolute coordinates. A raster that rounds
 * them in its own coordinates and is then drawn at a fractional device
 * position puts lines up to a pixel away from where the page — the edit
 * overlay — puts them (measured: 0.95 device px at the fitted zoom, lines of
 * one box rounding differently by a whole pixel at 100 %). So a raster of an
 * upright, unscaled text is painted for its place (`placeLayout`: the layout
 * in world coordinates, the raster's corner on a whole device pixel) and
 * drawn with its quad's corner moved onto that pixel (the texture's trim).
 *
 * A text that moves (dragged, aligned again, a neighbour's autofit) keeps its
 * raster until it has stopped for `SETTLE_MS`, then is painted again for its
 * new place: during a drag it moves by whole device pixels.
 */

import { Matrix } from 'pixi.js'
import type { Container, HTMLText, Renderer, Texture } from 'pixi.js'
import { perfCount } from '@narrative/shared'
import { markRenderDirty } from '../RenderScheduler.js'
import { htmlTextCompatible } from './flag.js'

/**
 * Each renderer's page origin and texel-grid phase (canvasRegionController.ts
 * sets them): a renderer that has them draws the page — the editor canvas,
 * whose texts the edit overlay draws again.
 */
const pageOrigins = new WeakMap<
  object,
  {
    origin: { x: number; y: number }
    phase: { x: number; y: number }
    /** The part of the world the canvas draws (world px; ADR 0020's region). */
    region: { x: number; y: number; width: number; height: number } | null
    /** Bumped whenever the region moves (PlacementWatch: clipped rasters follow it). */
    version: number
  }
>()

/**
 * Where `renderer`'s world has the page's own coordinates' origin — the
 * slide's 0, 0, from which the page (the edit overlay) rounds CSS px — and
 * where its canvas's texels lie: a world point is on a whole texel when its
 * world px × resolution is a whole number plus `phase` (the editor canvas
 * draws a region of its world from a whole device px, ADR 0020). Elsewhere
 * the origin and the phase are 0.
 */
export function setPageOrigin(
  renderer: object,
  origin: { x: number; y: number },
  phase: { x: number; y: number } = { x: 0, y: 0 },
  /** The part of the world the canvas draws (world px), when it draws a region of it. */
  region: { x: number; y: number; width: number; height: number } | null = null,
): void {
  const before = pageOrigins.get(renderer)
  const moved =
    before === undefined ||
    (before.region === null) !== (region === null) ||
    (region !== null &&
      before.region !== null &&
      (before.region.x !== region.x ||
        before.region.y !== region.y ||
        before.region.width !== region.width ||
        before.region.height !== region.height))
  pageOrigins.set(renderer, {
    origin: { ...origin },
    phase: { ...phase },
    region: region === null ? null : { ...region },
    version: (before?.version ?? 0) + (moved ? 1 : 0),
  })
}

/** The part of the world `renderer`'s canvas draws (null: all of it — no region). */
export function drawnRegionOf(
  renderer: object,
): { x: number; y: number; width: number; height: number } | null {
  return pageOrigins.get(renderer)?.region ?? null
}

/** A counter that moves with `renderer`'s drawn region. */
export function drawnRegionVersion(renderer: object): number {
  return pageOrigins.get(renderer)?.version ?? 0
}

/** Whether `renderer` draws the page (setPageOrigin was called for it). */
export function drawsPage(renderer: object): boolean {
  return pageOrigins.has(renderer)
}

export function pageOriginOf(renderer: object): { x: number; y: number } {
  return pageOrigins.get(renderer)?.origin ?? { x: 0, y: 0 }
}

export function gridPhaseOf(renderer: object): { x: number; y: number } {
  return pageOrigins.get(renderer)?.phase ?? { x: 0, y: 0 }
}

/**
 * The grid a raster is painted for: the canvas's resolution, the page's
 * origin, the texel grid's phase and the drawn region (setPageOrigin) — as
 * the canvas has them now, or as it will have them at another resolution
 * (`setProspectivePage`).
 */
export interface PageGrid {
  resolution: number
  origin: { x: number; y: number }
  phase: { x: number; y: number }
  region: { x: number; y: number; width: number; height: number } | null
}

/** Each renderer's prospective page (setProspectivePage). */
const prospects = new WeakMap<object, PageGrid>()

/**
 * The page `renderer`'s canvas will draw once it switches to
 * `page.resolution` (null: none is coming). Present mode prepares a standby
 * set of slides for a new display density while the canvas still draws at
 * the old one (present/densityHandover.ts): its texts, rasterised at the new
 * resolution, are placed on the grid the canvas will have then, exactly as
 * a presentation opened at that density places them — not left off the
 * grid because the canvas's resolution was still another when they were
 * painted (canvasRegionController.ts → prepareFor).
 */
export function setProspectivePage(renderer: object, page: PageGrid | null): void {
  if (page === null) prospects.delete(renderer)
  else
    prospects.set(renderer, {
      resolution: page.resolution,
      origin: { ...page.origin },
      phase: { ...page.phase },
      region: page.region === null ? null : { ...page.region },
    })
}

/**
 * The grid a raster of `resolution` texels per world px is placed on:
 * `renderer`'s page now when it draws at that resolution, the prospective
 * page when that one is for it (setProspectivePage), else null — the raster
 * is not on a canvas's device grid (a text pinned to another resolution, the
 * staging's to give it its own).
 */
export function pageGridFor(renderer: { resolution: number }, resolution: number): PageGrid | null {
  if (Math.abs(resolution - renderer.resolution) < 1e-6)
    return {
      resolution: renderer.resolution,
      origin: pageOriginOf(renderer),
      phase: gridPhaseOf(renderer),
      region: drawnRegionOf(renderer),
    }
  const p = prospects.get(renderer)
  return p !== undefined && Math.abs(resolution - p.resolution) < 1e-6 ? p : null
}

/** `v` (world px × resolution) rounded to the texel grid of phase `phase`. */
export function onTexelGrid(v: number, phase: number): number {
  return Math.round(v - phase) + phase
}

/**
 * `node`'s transform into its scene's world: the product of its own and its
 * ancestors' local transforms, up to the root and without the root's own.
 * The world is the root's space (the editor stage is never moved; the canvas
 * draws a region of it through a render transform — ADR 0020), and Pixi puts
 * that render transform in the root's local transform while it renders
 * (RenderGroupSystem.render): `getGlobalTransform` called from a raster asked
 * for during a render — a text's first raster, a resolution change — saw
 * the region's offset as part of the world, and the raster was painted for
 * another place.
 */
export function sceneTransform(node: Container, out: Matrix): Matrix {
  out.identity()
  let n: Container | null = node
  while (n !== null && n.parent !== null) {
    n.updateLocalTransform()
    out.prepend(n.localTransform)
    n = n.parent
  }
  return out
}

/** How long a text must stay put before it is painted again for its new place. */
export const SETTLE_MS = 150

const scratch = new Matrix()

/**
 * The world position (CSS px of the canvas) of the top-left corner of the
 * raster `text` draws — null when the text is rotated, skewed or scaled, or
 * rastered at another resolution than the renderer draws at (its pixels are
 * resampled then, and no grid is shared with the page).
 */
/**
 * The scale a text is drawn at when it is its own (a shrunk autofit box,
 * `textNode.scale`), upright, under unscaled parents: its raster is painted
 * at the canvas's resolution times it, texel on device pixel. 1 otherwise —
 * a scaled stage (thumbnails) or a rotated box keeps its rasters as they are.
 */
export function ownScale(text: HTMLText): number {
  if (htmlTextCompatible()) return 1
  const own = text.scale.x
  if (own <= 0 || Math.abs(text.scale.y - own) > 1e-6 || Math.abs(own - 1) < 1e-6) return 1
  const m = sceneTransform(text, scratch)
  const e = 1e-6
  if (Math.abs(m.b) > e || Math.abs(m.c) > e || Math.abs(m.a - own) > e || Math.abs(m.d - own) > e)
    return 1
  return own
}

export function rasterTop(
  text: HTMLText,
  raster: { width: number; height: number },
  padding: number,
  /** The raster's resolution (texels per unit of the text's own space). */
  resolution: number,
  rendererResolution: number,
  /** The layout's own content size (CSS px, unrounded; default: the raster's). */
  content?: { width: number; height: number },
): {
  x: number
  y: number
  shift: { x: number; y: number }
  /** The text's own scale (1: upright and unscaled) and its frame's corner (world). */
  scale: number
  frame: { x: number; y: number } | null
  /** The corner of the box the text is in (world): where the page puts it, by its CSS position. */
  box: { x: number; y: number; width: number; anchor: number } | null
} | null {
  if (htmlTextCompatible()) return null
  const m = sceneTransform(text, scratch)
  const e = 1e-6
  // Upright, the same scale both ways, and that scale the text's own (a
  // shrunk autofit box): a scaled stage (thumbnails) keeps its rasters.
  if (Math.abs(m.b) > e || Math.abs(m.c) > e || Math.abs(m.a - m.d) > e || m.a <= 0) return null
  const own = text.scale.x
  if (Math.abs(text.scale.y - own) > e || Math.abs(m.a - own) > e) return null
  const scale = own
  // Texels on device pixels: the raster at the canvas's resolution times the scale.
  if (Math.abs(resolution - rendererResolution * scale) > 1e-6) return null
  // Pixi's quad (updateTextBounds): the anchor applies to the texture's
  // frame, the padding is taken off the corner (the text's own units).
  const w = raster.width / resolution
  const h = raster.height / resolution
  const ax = text.anchor.x
  const ay = text.anchor.y
  // The frame is the content rounded up to whole device px: anchored at its
  // right (or middle), the text would sit that excess to the left of where
  // the page puts it. Painted that much to the right instead.
  const cw = content === undefined ? w : Math.max(1, content.width) + 2 * padding
  const ch = content === undefined ? h : Math.max(1, content.height) + 2 * padding
  const lx = -ax * w - padding + ax * 2 * padding
  const ly = -ay * h - padding + ay * 2 * padding
  const parent = text.parent
  // The box's corner: its container's origin (textRenderer: the pivot puts
  // the box's top-left at the container's (0, 0)), in the world.
  const corner =
    parent === null
      ? null
      : (() => {
          const pm = sceneTransform(parent, new Matrix())
          // The box's width (the container's pivot is its centre) and the
          // text's anchor in it (textRenderer → applyHorizontalAlign).
          return { x: pm.tx, y: pm.ty, width: parent.pivot.x * 2, anchor: ax }
        })()
  return {
    x: m.tx + lx * scale,
    y: m.ty + ly * scale,
    shift: { x: ax * (w - cw), y: ay * (h - ch) },
    scale,
    frame: Math.abs(scale - 1) < e || corner === null ? null : { x: corner.x, y: corner.y },
    box: corner,
  }
}

interface GpuText {
  texture?: Texture
  generatingTexture?: boolean
  roundPixels?: number
}

/** Where a placed raster was painted for (rasterTop's answer, the parts the paint read). */
export interface RasterAt {
  x: number
  y: number
  scale: number
  frame: { x: number; y: number } | null
  box: { x: number; y: number; width: number } | null
}

const CLOSE = 1e-4

const whole = (v: number): boolean => Math.abs(v - Math.round(v)) < CLOSE

/**
 * Whether a raster painted for `before` is the raster `now` would get: the
 * text moved by (dx, dy) world px — its corner, its box's corner and its
 * frame's together, nothing scaled or resized — and that move is a whole
 * number of everything the paint rounds to (placeLayout): device px of the
 * canvas (`deviceResolution`: the corner's texel and the quad's trim), the
 * page's rounding unit (1 / `unit` CSS px: baselines, underlines) and its
 * LayoutUnits (1/64 px). Each rounding commutes with such a move, so the
 * placed layout is the old one moved by whole texels, and the quad (moved
 * with the text, the trim unchanged) lands it there. Measured cases: a drag
 * at 100 % (whole px), a build animation's end at its start place, a table
 * moved by whole px. The grid phase must be the same (the caller checks).
 */
export function gridShiftKeepsRaster(
  before: RasterAt,
  now: RasterAt,
  deviceResolution: number,
  unit: number,
): boolean {
  if (Math.abs(before.scale - now.scale) > 1e-6) return false
  const dx = now.x - before.x
  const dy = now.y - before.y
  const moved = (
    a: { x: number; y: number } | null,
    b: { x: number; y: number } | null,
  ): boolean =>
    a === null || b === null
      ? a === b
      : Math.abs(b.x - a.x - dx) < CLOSE && Math.abs(b.y - a.y - dy) < CLOSE
  if (!moved(before.frame, now.frame) || !moved(before.box, now.box)) return false
  if (before.box !== null && now.box !== null && Math.abs(before.box.width - now.box.width) > 1e-6)
    return false
  for (const d of [dx, dy])
    if (!whole(d * deviceResolution) || !whole(d * unit) || !whole(d * 64)) return false
  return true
}

interface Placed {
  /** The renderer's texel-grid phase the raster was painted for. */
  phase?: { x: number; y: number }
  /**
   * A raster painted in device px (pagePlacement.ts): the text's world
   * transform, the renderer's resolution and its page origin it was painted
   * for — any change of them moves it off its pixels.
   */
  device?: string
  /** The text's resolution the raster was planned at. */
  base?: number
  /**
   * A raster cut to the canvas's drawn region (too large for a texture whole):
   * the world rectangle it covers, and the region's version then — when the
   * region moves out of it, the text is painted again for the new region.
   */
  covers?: { x: number; y: number; width: number; height: number }
  regionVersion?: number
  /**
   * The text's transform relative to its render group, and the group's, when
   * last checked: unchanged, the place is too, and the check is skipped.
   */
  seen?: string
  /** Where the raster was painted for (null: not placed). */
  top: RasterAt | null
  /** The page's rounding unit the paint used (placeLayout `unit`). */
  unit: number
  padding: number
  resolution: number
  content: { width: number; height: number }
}

/** Each renderer's holds on repainting moved texts (holdPlacementRepaints), and its watch. */
const holds = new WeakMap<object, number>()
const watches = new WeakMap<object, PlacementWatch>()

/**
 * Stop `renderer`'s watch from painting texts again for where they moved,
 * until the returned function is called (counted: every hold is released on
 * its own). Its callers:
 *
 *   - the editor's zoom gesture (Canvas.tsx): the region follows the live
 *     zoom and the grid's phase wanders with it, while the canvas is scaled
 *     by the compositor anyway; at the gesture's end (the commit, or a
 *     gesture that ended where it started) everything is compared once.
 *     A raster painted for a phase the gesture passed through was wasted
 *     (`viewport.zoom.wheel`: every text twice, 2026-10-30).
 *   - a pointer gesture (Canvas.tsx: from pointerdown to pointerup): a
 *     dragged text is painted for where it rests at the end, not wherever
 *     the page stalled for `SETTLE_MS` on the way (a GC mid-drag).
 *   - present mode (presentSlides.ts): every slide is painted while it is
 *     prepared, at rest; builds and transitions move texts for a moment and
 *     put them back, and nothing is painted after ready (ADR 0016) — a
 *     build's first state held between steps was painted, and its end again.
 *
 * A raster cut to the drawn region is still painted again once the region
 * leaves it (that is a raster missing pixels, not one off the grid).
 */
export function holdPlacementRepaints(renderer: object): () => void {
  holds.set(renderer, (holds.get(renderer) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (holds.get(renderer) ?? 1) - 1
    if (n > 0) {
      holds.set(renderer, n)
      return
    }
    holds.delete(renderer)
    // Compared once, now that nothing holds it.
    watches.get(renderer)?.recheck()
  }
}

/** Whether `renderer`'s watch is held (holdPlacementRepaints). */
export function placementHeld(renderer: object): boolean {
  return (holds.get(renderer) ?? 0) > 0
}

/**
 * The run rasters of one renderer and the places they were painted for:
 * `record` after each raster, and every rendered frame compares (renderer
 * `postrender`); a text whose place changed on the device grid is painted
 * again once nothing has moved for `SETTLE_MS`.
 */
export class PlacementWatch {
  private readonly placed = new Map<HTMLText, Placed>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly renderer: Renderer,
    private readonly counters: string,
    /**
     * Whether a text rastered at `base` would now be painted in device px
     * (runTextSystem → devicePlan): an unplaced raster of it is painted again,
     * as one painted for another place is (a raster made while the
     * renderer's resolution was still another, at a zoom commit).
     */
    private readonly inDevicePx: (text: HTMLText, base: number) => boolean = () => false,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi's runners are untyped on Renderer
    ;(renderer as any).runners?.postrender?.add(this)
    watches.set(renderer, this)
  }

  /** A raster of `text` was painted for `top` (its texture's trim puts the quad on that pixel). */
  record(
    text: HTMLText,
    top: RasterAt | null,
    padding: number,
    resolution: number,
    content: { width: number; height: number },
    /** The text's resolution the raster was planned at (its own: `resolution` over its scale). */
    base: number = resolution,
    /** A raster cut to the drawn region: the world rectangle it covers. */
    covers: { x: number; y: number; width: number; height: number } | null = null,
    /** The page's rounding unit the paint used (placeLayout `unit`). */
    unit = 1,
    /** The texel grid's phase the raster was painted for (default: the canvas's now; pageGridFor). */
    phase: { x: number; y: number } = gridPhaseOf(this.renderer),
  ): void {
    this.placed.set(text, {
      phase: { ...phase },
      base,
      ...(covers !== null
        ? { covers: { ...covers }, regionVersion: drawnRegionVersion(this.renderer) }
        : {}),
      top: top === null ? null : copyAt(top),
      unit,
      padding,
      resolution,
      content: { width: content.width, height: content.height },
    })
  }

  /** A raster of `text` was painted in device px for where it is now (pagePlacement.ts). */
  recordDevice(
    text: HTMLText,
    /** A raster cut to the drawn region: the world rectangle it covers. */
    covers: { x: number; y: number; width: number; height: number } | null = null,
    /** The page it was painted for (default: the canvas's now; pageGridFor). */
    grid: PageGrid | null = null,
  ): void {
    const resolution = grid?.resolution ?? this.renderer.resolution
    this.placed.set(text, {
      phase: { ...(grid?.phase ?? gridPhaseOf(this.renderer)) },
      device: this.deviceKey(text, resolution, grid?.origin ?? pageOriginOf(this.renderer)),
      ...(covers !== null
        ? { covers: { ...covers }, regionVersion: drawnRegionVersion(this.renderer) }
        : {}),
      top: null,
      unit: 1,
      padding: 0,
      resolution,
      content: { width: 0, height: 0 },
    })
  }

  private deviceKey(
    text: HTMLText,
    resolution = this.renderer.resolution,
    o: { x: number; y: number } = pageOriginOf(this.renderer),
  ): string {
    const m = sceneTransform(text, scratch)
    return `${m.a},${m.b},${m.c},${m.d},${m.tx},${m.ty},${resolution},${o.x},${o.y}`
  }

  /** Called by Pixi after every frame this renderer draws. */
  postrender(): void {
    if (this.placed.size === 0) return
    if (this.moved().length > 0) this.schedule()
  }

  /** Compare every text once, after `SETTLE_MS` (a hold was released). */
  recheck(): void {
    if (this.placed.size > 0) this.schedule()
  }

  private gpuOf(text: HTMLText): GpuText | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi keeps per-renderer GPU data untyped
    return (text as any)._gpuData?.[this.renderer.uid] as GpuText | undefined
  }

  /**
   * Texts whose raster is not the one their place now asks for. `quick`:
   * only those whose transforms changed since the last check (every frame);
   * otherwise every one (the settle timer). While the renderer is held
   * (holdPlacementRepaints) only cut rasters the region left.
   */
  private moved(quick = true): HTMLText[] {
    const out: HTMLText[] = []
    const holding = placementHeld(this.renderer)
    for (const [text, p] of this.placed) {
      if (text.destroyed) {
        this.placed.delete(text)
        continue
      }
      const gpu = this.gpuOf(text)
      if (gpu === undefined || gpu.generatingTexture === true || gpu.texture === undefined) continue
      // A raster cut to the drawn region: painted again once the region
      // leaves what it covers (a scroll moves the region, not the text).
      const regionVersion = drawnRegionVersion(this.renderer)
      if (p.covers !== undefined && p.regionVersion !== regionVersion) {
        const r = drawnRegionOf(this.renderer)
        const c = p.covers
        if (
          r !== null &&
          (r.x < c.x - 1e-3 ||
            r.y < c.y - 1e-3 ||
            r.x + r.width > c.x + c.width + 1e-3 ||
            r.y + r.height > c.y + c.height + 1e-3)
        ) {
          // Kept pending until the new raster records its own region.
          out.push(text)
          continue
        }
        p.regionVersion = regionVersion
      }
      // Held: its place is compared when the hold ends (`seen` left as it was).
      if (holding) continue
      // Cheap first: Pixi keeps these up to date per frame; the full walk up
      // the parents only when one moved.
      const local = text.worldTransform
      const group = (text.renderGroup ?? text.parentRenderGroup)?.worldTransform
      const seen = `${local.a},${local.b},${local.c},${local.d},${local.tx},${local.ty},${group?.tx},${group?.ty},${group?.a},${group?.d},${this.renderer.resolution}`
      if (quick && seen === p.seen) continue
      p.seen = seen
      const phase = gridPhaseOf(this.renderer)
      const samePhase = p.phase === undefined || (p.phase.x === phase.x && p.phase.y === phase.y)
      if (p.device !== undefined) {
        if (!samePhase || p.device !== this.deviceKey(text)) out.push(text)
        continue
      }
      const frame = gpu.texture.frame
      const raster = {
        width: Math.round(frame.width * p.resolution),
        height: Math.round(frame.height * p.resolution),
      }
      const now = rasterTop(
        text,
        raster,
        p.padding,
        p.resolution,
        this.renderer.resolution,
        p.content,
      )
      if (now === null) {
        // Not on the device grid now (turned, scaled by a parent, or drawn at
        // another resolution — the staging's to give it): a raster painted
        // again at its resolution would be resampled just the same. Only a
        // text the device-px painter now draws is painted again.
        if (this.inDevicePx(text, p.base ?? p.resolution)) out.push(text)
        continue
      }
      if (p.top === null) {
        // Painted off the grid, on it now: painted for its place.
        out.push(text)
        continue
      }
      if (!samePhase) {
        out.push(text)
        continue
      }
      if (Math.abs(now.x - p.top.x) < 1e-4 && Math.abs(now.y - p.top.y) < 1e-4) continue
      // (A raster cut to the drawn region covers a part of the world that
      // does not move with the text: painted again.)
      if (
        p.covers === undefined &&
        gridShiftKeepsRaster(p.top, now, this.renderer.resolution, p.unit)
      ) {
        // Moved by whole texels of everything the paint rounds: the raster
        // is the one it would get, its quad moved with the text.
        p.top = copyAt(now)
        continue
      }
      out.push(text)
    }
    return out
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const moved = this.moved(false)
      if (moved.length === 0) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi's render pipes are untyped
      const pipe = (this.renderer as any).renderPipes?.htmlText as
        { _updateGpuText(text: HTMLText): Promise<void> } | undefined
      if (pipe === undefined) return
      for (const text of moved) {
        perfCount(`${this.counters}.raster.replaced`)
        pipe._updateGpuText(text).catch((e: unknown) => console.error(e))
      }
      markRenderDirty()
    }, SETTLE_MS)
  }

  /** Forget everything (the renderer is going away). */
  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.placed.clear()
    if (watches.get(this.renderer) === this) watches.delete(this.renderer)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi's runners are untyped on Renderer
    ;(this.renderer as any).runners?.postrender?.remove(this)
  }
}

function copyAt(a: RasterAt): RasterAt {
  return {
    x: a.x,
    y: a.y,
    scale: a.scale,
    frame: a.frame === null ? null : { x: a.frame.x, y: a.frame.y },
    box: a.box === null ? null : { x: a.box.x, y: a.box.y, width: a.box.width },
  }
}
