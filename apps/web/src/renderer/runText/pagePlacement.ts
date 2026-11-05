/**
 * renderer/runText/pagePlacement.ts — a turned, flipped or shrunk text box
 * painted as the page draws it (ADR 0018 → Placement: transformed boxes).
 *
 * The edit overlay draws such a box through transformed elements
 * (ui/TextEditOverlay.tsx): the rig, turned and flipped about the box's
 * centre, and in a shrinking box the frame, scaled from its corner. The page
 * does not draw them as the scene graph's matrix product: each engine
 * snaps a transformed element's offset first and rounds the baselines inside
 * it, then rasterises the glyphs through the whole transform (measured with
 * Canvas2D models in both engines, 2026-10-27: pixel-identical to the page,
 * black text, DPR 1 and 2, 0°, 15°, 90°, 180°, frames scaled 0.64):
 *
 *   - WebKit (RenderLayer::paintLayerByApplyingTransform): the layer's offset
 *     in its parent (plus the subpixel offset carried in from the layers
 *     above) is rounded to a device px of the parent's own coordinates
 *     (1 / devicePixelRatio of its units); what rounding took away is added
 *     back *inside* the transform, to everything the layer paints. Baselines
 *     are rounded to a device px of the innermost layer's coordinates
 *     (TextBoxPainter::textOriginFromPaintRect).
 *   - Blink: the offset is rounded to a whole px of the parent's
 *     coordinates and the fraction is dropped (a transform other than a
 *     translation cannot carry it — PaintPropertyTreeBuilder); baselines are
 *     rounded to a whole px of the innermost layer's coordinates.
 *
 * A raster of such a text is therefore painted in device px — the layout in
 * the innermost layer's coordinates, drawn through the transform the page
 * draws it with — and drawn upright, texel on device pixel: Core Graphics
 * and Skia then place and rasterise every glyph of the canvas as they do the
 * page's (a turned glyph's origin rounded to a whole device px, its outline
 * turned), instead of a raster of the upright text being turned and
 * resampled by the GPU.
 */

import { Matrix } from 'pixi.js'
import { sceneTransform } from './placement.js'
import type { Container, HTMLText } from 'pixi.js'

/** The engines whose rules are known (layoutCache.ts → layoutEngine). */
export type PageEngine = 'blink' | 'webkit'

/** An affine map, `[a, b, c, d, e, f]` as Canvas2D and DOMMatrix order it. */
export type Affine = [number, number, number, number, number, number]

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

/** `m ∘ n` (n first). */
export function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

export function apply(m: Affine, p: { x: number; y: number }): { x: number; y: number } {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] }
}

function translate(x: number, y: number): Affine {
  return [1, 0, 0, 1, x, y]
}

/** A position as the page holds it: a LayoutUnit (1/64 px). */
function layoutUnit(v: number): number {
  return Math.round(v * 64) / 64
}

/**
 * WebKit's roundToDevicePixel: `round(v × dsf) / dsf`, halves up — negative
 * halves too (it moves them to positive values first: LayoutUnit.h).
 */
function roundToDevicePixel(v: number, dsf: number): number {
  return Math.floor(v * dsf + 0.5) / dsf
}

/** Blink's LayoutUnit::Round: halves up. */
function roundHalfUp(v: number): number {
  return Math.floor(v + 0.5)
}

/**
 * The CSS transform the overlay gives the rig (textEditOverlayLook.ts →
 * boxTransformCss), as the engine computes it: `rotate(<rad>rad)` then the
 * flip. DOMMatrix runs the engine's own transform code — a quarter turn given
 * in radians comes out exactly as the page's (Blink and WebKit both snap
 * it), where `Math.cos(π / 2)` does not.
 */
export function rigMatrix(rotation: number, flipH: boolean, flipV: boolean): Affine | null {
  const parts: string[] = []
  if (rotation !== 0 && Number.isFinite(rotation)) parts.push(`rotate(${rotation}rad)`)
  if (flipH || flipV) parts.push(`scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})`)
  if (parts.length === 0) return null
  const css = parts.join(' ')
  let m = rigMatrices.get(css)
  if (m === undefined) {
    const d = new DOMMatrix(css)
    m = [d.a, d.b, d.c, d.d, d.e, d.f]
    rigMatrices.set(css, m)
  }
  return m
}

const rigMatrices = new Map<string, Affine>()

/** A text box as the overlay draws it. */
export interface BoxOnPage {
  /** The box's top-left in the page's coordinates (slide px). */
  origin: { x: number; y: number }
  /** The rig's transform (rotation and flip, about `centre`); null: none (no layer). */
  rig: Affine | null
  /** The rig's transform origin: the box's centre, in its own coordinates. */
  centre: { x: number; y: number }
  /** The frame's scale (a shrinking box's type scale); 1: no frame layer. */
  scale: number
}

/** Where the page draws a box's content: the innermost layer's coordinates. */
export interface PageSpace {
  /** The innermost layer's coordinates → the page's (slide px). */
  toPage: Affine
  /**
   * Added to every position the layer paints (WebKit: what snapping the
   * layers took away; 0 in Blink, which drops it). For an untransformed box
   * the box's own offset in the page: positions are then the page's.
   */
  offset: { x: number; y: number }
  /** Baselines are rounded to 1 / `unit` px of the layer's coordinates. */
  unit: number
}

/**
 * The innermost layer a box's text is painted in, as `engine` draws it at
 * device pixel ratio `dsf` (the module comment has the rules).
 */
export function pageSpace(box: BoxOnPage, engine: PageEngine, dsf: number): PageSpace {
  const webkit = engine === 'webkit'
  const snap = (v: number): number => (webkit ? roundToDevicePixel(v, dsf) : roundHalfUp(v))
  let toPage: Affine = IDENTITY
  // The offset of the next layer within the current one, not yet snapped.
  let at = { x: layoutUnit(box.origin.x), y: layoutUnit(box.origin.y) }
  const enter = (local: Affine): void => {
    const snapped = { x: snap(at.x), y: snap(at.y) }
    toPage = multiply(toPage, multiply(translate(snapped.x, snapped.y), local))
    at = webkit ? { x: at.x - snapped.x, y: at.y - snapped.y } : { x: 0, y: 0 }
  }
  if (box.rig !== null) {
    const c = box.centre
    enter(multiply(translate(c.x, c.y), multiply(box.rig, translate(-c.x, -c.y))))
  }
  if (box.scale !== 1) enter([box.scale, 0, 0, box.scale, 0, 0])
  return { toPage, offset: at, unit: webkit ? dsf : 1 }
}

const scratch = new Matrix()

/** Text nodes of text boxes (objectRenderers/textRenderer.ts marks them): the parent is the box. */
const boxTexts = new WeakSet<HTMLText>()

export function markTextBoxNode(text: HTMLText): void {
  boxTexts.add(text)
}

/**
 * The box `text` is drawn in, as the overlay draws it — null when it is not a
 * text box's text, or when the box sits under anything but translations
 * (a group: the overlay's structure there is another).
 *
 * `pageOrigin`: the world position of the slide's (0, 0).
 */
export function boxOnPage(
  text: HTMLText,
  pageOrigin: { x: number; y: number },
): (BoxOnPage & { frame: Container }) | null {
  if (!boxTexts.has(text)) return null
  const box = text.parent
  if (box === null) return null
  const outer = box.parent
  if (outer === null) return null
  // In the world (placement.ts → sceneTransform).
  const w = sceneTransform(outer, scratch)
  const e = 1e-9
  if (Math.abs(w.a - 1) > e || Math.abs(w.d - 1) > e || Math.abs(w.b) > e || Math.abs(w.c) > e)
    return null
  // The container: position − pivot is the box's top-left (the pivot is its centre).
  const flipH = box.scale.x < 0
  const flipV = box.scale.y < 0
  if (Math.abs(Math.abs(box.scale.x) - 1) > e || Math.abs(Math.abs(box.scale.y) - 1) > e)
    return null
  if (box.skew.x !== 0 || box.skew.y !== 0) return null
  return {
    origin: {
      x: w.tx + box.x - box.pivot.x - pageOrigin.x,
      y: w.ty + box.y - box.pivot.y - pageOrigin.y,
    },
    rig: rigMatrix(box.rotation, flipH, flipV),
    centre: { x: box.pivot.x, y: box.pivot.y },
    scale: text.scale.x,
    frame: box,
  }
}
