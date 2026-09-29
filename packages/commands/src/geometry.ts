/**
 * commands/src/geometry.ts — object frame geometry shared by the transform
 * commands and the editor's handles.
 *
 * An object's frame is its UNROTATED layout box (x, y, width, height, slide
 * px) plus `rotation` in radians about the box centre. A cropped image also
 * has `imageRect`: where the whole picture sits, in absolute slide px, in the
 * same unrotated frame of reference.
 *
 * The editor's resize handles (TransformHandles) and `object.resize` use the
 * functions below, so a drag and an agent's resize land on the same box.
 */

import { polygonSides, regularPolygonVertices, triangleVertices } from '@narrative/shared'

/** A point of the frame that stays put while it is resized. */
export type Anchor =
  | 'topLeft'
  | 'top'
  | 'topRight'
  | 'left'
  | 'center'
  | 'right'
  | 'bottomLeft'
  | 'bottom'
  | 'bottomRight'

export const ANCHORS: readonly Anchor[] = [
  'topLeft',
  'top',
  'topRight',
  'left',
  'center',
  'right',
  'bottomLeft',
  'bottom',
  'bottomRight',
]

/** Where an anchor sits in the frame's local axes, as a unit sign per axis. */
const ANCHOR_SIGN: Readonly<Record<Anchor, { sx: number; sy: number }>> = {
  topLeft: { sx: -1, sy: -1 },
  top: { sx: 0, sy: -1 },
  topRight: { sx: 1, sy: -1 },
  left: { sx: -1, sy: 0 },
  center: { sx: 0, sy: 0 },
  right: { sx: 1, sy: 0 },
  bottomLeft: { sx: -1, sy: 1 },
  bottom: { sx: 0, sy: 1 },
  bottomRight: { sx: 1, sy: 1 },
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Frame extends Rect {
  /** Radians about the box centre. */
  rotation: number
}

/**
 * Top-left of a frame resized to `width` x `height` so that `anchor` stays
 * exactly where it is on the slide — along the object's own (rotated) axes.
 */
export function placeResized(
  frame: Frame,
  width: number,
  height: number,
  anchor: Anchor,
): { x: number; y: number } {
  const { sx, sy } = ANCHOR_SIGN[anchor]
  const cos = Math.cos(frame.rotation)
  const sin = Math.sin(frame.rotation)
  const cx = frame.x + frame.width / 2
  const cy = frame.y + frame.height / 2
  const ax = sx * (frame.width / 2)
  const ay = sy * (frame.height / 2)
  const anchorX = cx + cos * ax - sin * ay
  const anchorY = cy + sin * ax + cos * ay
  const nx = sx * (width / 2)
  const ny = sy * (height / 2)
  const centerX = anchorX - (cos * nx - sin * ny)
  const centerY = anchorY - (sin * nx + cos * ny)
  return { x: centerX - width / 2, y: centerY - height / 2 }
}

/** A crop rect carried from one frame to another: it scales and moves with the frame. */
export function scaleCrop(crop: Rect, from: Rect, to: Rect): Rect {
  const sx = from.width === 0 ? 1 : to.width / from.width
  const sy = from.height === 0 ? 1 : to.height / from.height
  return {
    x: to.x + (crop.x - from.x) * sx,
    y: to.y + (crop.y - from.y) * sy,
    width: crop.width * sx,
    height: crop.height * sy,
  }
}

/** The slide-space corners of a frame, in order TL, TR, BR, BL. */
export function frameCorners(frame: Frame): Array<{ x: number; y: number }> {
  const cos = Math.cos(frame.rotation)
  const sin = Math.sin(frame.rotation)
  const cx = frame.x + frame.width / 2
  const cy = frame.y + frame.height / 2
  const hw = frame.width / 2
  const hh = frame.height / 2
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([lx, ly]) => ({
    x: cx + cos * lx! - sin * ly!,
    y: cy + sin * lx! + cos * ly!,
  }))
}

/** The axis-aligned box a frame covers on the slide (its rotated outline's bounds). */
export function visualBounds(frame: Frame): Rect {
  const corners = frameCorners(frame)
  const xs = corners.map((c) => c.x)
  const ys = corners.map((c) => c.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

// ---------------------------------------------------------------------------
// Resize handles (the editor's drag)
// ---------------------------------------------------------------------------

export type ResizeHandle = 'TL' | 'TC' | 'TR' | 'ML' | 'MR' | 'BL' | 'BC' | 'BR'

/** Handle position in the frame's local axes, as a unit sign per axis. */
const HANDLE_SIGN: Readonly<Record<ResizeHandle, { sx: number; sy: number }>> = {
  TL: { sx: -1, sy: -1 },
  TR: { sx: 1, sy: -1 },
  BR: { sx: 1, sy: 1 },
  BL: { sx: -1, sy: 1 },
  TC: { sx: 0, sy: -1 },
  BC: { sx: 0, sy: 1 },
  ML: { sx: -1, sy: 0 },
  MR: { sx: 1, sy: 0 },
}

/** The anchor that stays put while a handle is dragged: the opposite handle. */
export const OPPOSITE_ANCHOR: Readonly<Record<ResizeHandle, Anchor>> = {
  TL: 'bottomRight',
  TC: 'bottom',
  TR: 'bottomLeft',
  ML: 'right',
  MR: 'left',
  BL: 'topRight',
  BC: 'top',
  BR: 'topLeft',
}

/**
 * The box a handle drag produces: `dx` / `dy` is the pointer's slide-space
 * travel since the drag started, applied to the frame as it was then. The
 * opposite handle stays put; `lockAspect` keeps the start aspect ratio on a
 * corner handle (the dominant axis drives the other). Minimum 1 px a side.
 */
export function resizeFromHandle(
  start: Frame,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  lockAspect: boolean,
): Rect {
  if (start.rotation === 0) return resizeAligned(start, handle, dx, dy, lockAspect)

  const sign = HANDLE_SIGN[handle]
  const cos = Math.cos(start.rotation)
  const sin = Math.sin(start.rotation)
  const cx = start.x + start.width / 2
  const cy = start.y + start.height / 2

  const anchorLocalX = -sign.sx * (start.width / 2)
  const anchorLocalY = -sign.sy * (start.height / 2)
  const anchorX = cx + cos * anchorLocalX - sin * anchorLocalY
  const anchorY = cy + sin * anchorLocalX + cos * anchorLocalY

  const handleLocalX = sign.sx * (start.width / 2)
  const handleLocalY = sign.sy * (start.height / 2)
  const handleX = cx + cos * handleLocalX - sin * handleLocalY + dx
  const handleY = cy + sin * handleLocalX + cos * handleLocalY + dy

  // The dragged handle relative to the anchor, in the frame's local axes.
  const wx = handleX - anchorX
  const wy = handleY - anchorY
  const localX = cos * wx + sin * wy
  const localY = -sin * wx + cos * wy

  let width = start.width
  let height = start.height
  if (sign.sx !== 0) width = Math.max(1, sign.sx > 0 ? localX : -localX)
  if (sign.sy !== 0) height = Math.max(1, sign.sy > 0 ? localY : -localY)
  if (lockAspect && sign.sx !== 0 && sign.sy !== 0) {
    const ratio = start.width / start.height
    // Compare scaled magnitudes so the dominant axis wins whatever the ratio.
    if (Math.abs(localX) * start.height > Math.abs(localY) * start.width) height = width / ratio
    else width = height * ratio
  }
  return { ...placeResized(start, width, height, OPPOSITE_ANCHOR[handle]), width, height }
}

/** `resizeFromHandle` for an unrotated frame (kept bit-for-bit as the editor always had it). */
function resizeAligned(
  start: Rect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  lockAspect: boolean,
): Rect {
  const ratio = start.width / start.height
  const corner = (w: number, h: number): { width: number; height: number } => {
    let width = Math.max(1, w)
    let height = Math.max(1, h)
    if (lockAspect) {
      if (Math.abs(dx) > Math.abs(dy)) height = width / ratio
      else width = height * ratio
    }
    return { width, height }
  }
  switch (handle) {
    case 'TL': {
      const { width, height } = corner(start.width - dx, start.height - dy)
      return {
        x: start.x + start.width - width,
        y: start.y + start.height - height,
        width,
        height,
      }
    }
    case 'TR': {
      const { width, height } = corner(start.width + dx, start.height - dy)
      return { x: start.x, y: start.y + start.height - height, width, height }
    }
    case 'BR': {
      const { width, height } = corner(start.width + dx, start.height + dy)
      return { x: start.x, y: start.y, width, height }
    }
    case 'BL': {
      const { width, height } = corner(start.width - dx, start.height + dy)
      return { x: start.x + start.width - width, y: start.y, width, height }
    }
    case 'TC': {
      const height = Math.max(1, start.height - dy)
      return { x: start.x, y: start.y + start.height - height, width: start.width, height }
    }
    case 'BC':
      return { x: start.x, y: start.y, width: start.width, height: Math.max(1, start.height + dy) }
    case 'ML': {
      const width = Math.max(1, start.width - dx)
      return { x: start.x + start.width - width, y: start.y, width, height: start.height }
    }
    case 'MR':
      return { x: start.x, y: start.y, width: Math.max(1, start.width + dx), height: start.height }
  }
}

// ---------------------------------------------------------------------------
// Point-drawn objects: paths, lines, arrows
// ---------------------------------------------------------------------------

export interface Point {
  x: number
  y: number
}

/**
 * Where an object sits and how it is turned and mirrored. The renderer draws
 * a local point `p` (relative to the box's top-left) at
 * `centre + R(rotation) · S · (p - size / 2)`, with S = diag(±1, ±1) from
 * flipH / flipV — the Pixi container's pivot is the box centre and its scale
 * carries the mirror (renderer/objectRenderers/applyFlip.ts).
 */
export interface Placement extends Frame {
  flipH?: boolean
  flipV?: boolean
}

/** A vector in the object's local axes, as it points on the slide (R · S · v). */
function localVectorToSlide(p: Placement, v: Point): Point {
  const fx = p.flipH === true ? -v.x : v.x
  const fy = p.flipV === true ? -v.y : v.y
  const cos = Math.cos(p.rotation)
  const sin = Math.sin(p.rotation)
  return { x: cos * fx - sin * fy, y: sin * fx + cos * fy }
}

/** The inverse: a slide vector in the object's local axes (S · R(-rotation) · v). */
function slideVectorToLocal(p: Pick<Placement, 'rotation' | 'flipH' | 'flipV'>, v: Point): Point {
  const cos = Math.cos(p.rotation)
  const sin = Math.sin(p.rotation)
  const rx = cos * v.x + sin * v.y
  const ry = -sin * v.x + cos * v.y
  return { x: p.flipH === true ? -rx : rx, y: p.flipV === true ? -ry : ry }
}

/** Where a local point of an object is drawn on the slide. */
export function localToSlide(p: Placement, point: Point): Point {
  const v = localVectorToSlide(p, { x: point.x - p.width / 2, y: point.y - p.height / 2 })
  return { x: p.x + p.width / 2 + v.x, y: p.y + p.height / 2 + v.y }
}

/**
 * A path anchor (the stored `PathAnchor` shape): `x` / `y` a point, `cpIn` /
 * `cpOut` bezier handles relative to it, `moveTo` starting a new subpath.
 */
export interface PathPoint extends Point {
  cpIn?: Point
  cpOut?: Point
  moveTo?: boolean
}

/** A path's anchors as drawn on the slide: points in slide px, handles as slide vectors. */
export function anchorsOnSlide(p: Placement, anchors: readonly PathPoint[]): PathPoint[] {
  return anchors.map((a) => {
    const out: PathPoint = { ...a, ...localToSlide(p, a) }
    if (a.cpIn !== undefined) out.cpIn = localVectorToSlide(p, a.cpIn)
    if (a.cpOut !== undefined) out.cpOut = localVectorToSlide(p, a.cpOut)
    return out
  })
}

/**
 * The segments a path draws, the way the path renderer traces it
 * (renderer/objectRenderers/pathRenderer.ts `buildPath`): consecutive
 * anchors join with a cubic when the first has `cpOut` and the second
 * `cpIn`, with a straight line otherwise; an anchor with `moveTo` starts a
 * new subpath; a closed path joins each subpath's last anchor back to its
 * first. A handle no segment uses is not drawn.
 */
function* segments(
  anchors: readonly PathPoint[],
  closed: boolean,
): Generator<[PathPoint, PathPoint]> {
  if (anchors.length === 0) return
  let start = anchors[0]!
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1]!
    const cur = anchors[i]!
    if (cur.moveTo === true) {
      if (closed) yield [prev, start]
      start = cur
      continue
    }
    yield [prev, cur]
  }
  if (closed) yield [anchors[anchors.length - 1]!, start]
}

/** Parameters in (0, 1) where a cubic's coordinate has a turning point. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  // B'(t) / 3 = a t^2 + b t + c
  const a = -p0 + 3 * p1 - 3 * p2 + p3
  const b = 2 * (p0 - 2 * p1 + p2)
  const c = p1 - p0
  const inside = (t: number): boolean => t > 0 && t < 1
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b].filter(inside)
  const d = b * b - 4 * a * c
  if (d < 0) return []
  const r = Math.sqrt(d)
  return [(-b + r) / (2 * a), (-b - r) / (2 * a)].filter(inside)
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

/**
 * The bounding box of what a path draws — its anchors and the true extent
 * of every curved segment (the cubic's turning points), not its control
 * handles, which only pull the curve.
 */
export function drawnBounds(anchors: readonly PathPoint[], closed: boolean): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const grow = (x: number, y: number): void => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const a of anchors) grow(a.x, a.y)
  for (const [from, to] of segments(anchors, closed)) {
    if (from.cpOut === undefined || to.cpIn === undefined) continue
    const xs = [from.x, from.x + from.cpOut.x, to.x + to.cpIn.x, to.x] as const
    const ys = [from.y, from.y + from.cpOut.y, to.y + to.cpIn.y, to.y] as const
    for (const t of cubicExtrema(...xs)) grow(cubicAt(...xs, t), cubicAt(...ys, t))
    for (const t of cubicExtrema(...ys)) grow(cubicAt(...xs, t), cubicAt(...ys, t))
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * The box and local anchors that draw `slideAnchors` exactly where they are,
 * for an object turned by `rotation` and mirrored by `flipH` / `flipV`. The
 * box is the bounding box of what the path draws ({@link drawnBounds}) in
 * the object's own axes — the inverse of {@link anchorsOnSlide}, whatever
 * the placement. A line is two anchors without handles.
 */
export function fitAnchors(
  slideAnchors: readonly PathPoint[],
  turn: Pick<Placement, 'rotation' | 'flipH' | 'flipV'>,
  closed = false,
): { box: Rect; anchors: PathPoint[] } {
  const local = slideAnchors.map((a) => {
    const out: PathPoint = { ...a, ...slideVectorToLocal(turn, a) }
    if (a.cpIn !== undefined) out.cpIn = slideVectorToLocal(turn, a.cpIn)
    if (a.cpOut !== undefined) out.cpOut = slideVectorToLocal(turn, a.cpOut)
    return out
  })
  if (local.length === 0) return { box: { x: 0, y: 0, width: 0, height: 0 }, anchors: [] }
  const bounds = drawnBounds(local, closed)
  const minX = bounds.x
  const minY = bounds.y
  const width = bounds.width
  const height = bounds.height
  // The local frame is origin-free: the box centre, taken back to the slide,
  // is the rotation pivot.
  const centre = localVectorToSlide(
    { x: 0, y: 0, width: 0, height: 0, ...turn },
    { x: minX + width / 2, y: minY + height / 2 },
  )
  return {
    box: { x: centre.x - width / 2, y: centre.y - height / 2, width, height },
    anchors: local.map((a) => ({ ...a, x: a.x - minX, y: a.y - minY })),
  }
}

// ---------------------------------------------------------------------------
// Shape outlines as path anchors
// ---------------------------------------------------------------------------

/** Cubic-bezier handle length for a quarter circle, as a fraction of the radius. */
const KAPPA = (4 * (Math.SQRT2 - 1)) / 3

export type CornerRadii = number | { tl: number; tr: number; br: number; bl: number }

export type OutlineShape =
  | { type: 'rectangle'; cornerRadius?: CornerRadii }
  | { type: 'ellipse' }
  | { type: 'triangle' }
  | { type: 'polygon'; sides: number }

/**
 * The outline a parametric shape draws, as closed-path anchors in its local
 * box (w x h), traced clockwise from the top the way the shape renderers
 * trace it: rounded corners clamp to half the shorter side, a triangle fills
 * its box (PowerPoint's `triangle`), polygons (3–12 sides) point up inscribed
 * in the box's ellipse (@narrative/shared shapeGeometry), an ellipse is four
 * quarter arcs.
 */
export function shapeOutline(shape: OutlineShape, w: number, h: number): PathPoint[] {
  switch (shape.type) {
    case 'triangle':
      return triangleVertices(w, h)
    case 'polygon':
      return regularPolygonVertices(polygonSides(shape.sides), w, h)
    case 'ellipse': {
      const kx = (w / 2) * KAPPA
      const ky = (h / 2) * KAPPA
      return [
        { x: w / 2, y: 0, cpIn: { x: -kx, y: 0 }, cpOut: { x: kx, y: 0 } },
        { x: w, y: h / 2, cpIn: { x: 0, y: -ky }, cpOut: { x: 0, y: ky } },
        { x: w / 2, y: h, cpIn: { x: kx, y: 0 }, cpOut: { x: -kx, y: 0 } },
        { x: 0, y: h / 2, cpIn: { x: 0, y: ky }, cpOut: { x: 0, y: -ky } },
      ]
    }
    case 'rectangle': {
      const r = shape.cornerRadius
      const max = Math.min(w, h) / 2
      const clamp = (v: number | undefined): number => Math.max(0, Math.min(v ?? 0, max))
      const tl = clamp(typeof r === 'number' ? r : r?.tl)
      const tr = clamp(typeof r === 'number' ? r : r?.tr)
      const br = clamp(typeof r === 'number' ? r : r?.br)
      const bl = clamp(typeof r === 'number' ? r : r?.bl)
      const out: PathPoint[] = []
      // Each corner is either one sharp point or an arc between two points,
      // its handles pointing along the edges (KAPPA x radius long).
      const corner = (
        radius: number,
        at: Point,
        enter: Point, // unit vector along the edge arriving at the corner
        leave: Point, // unit vector along the edge leaving it
      ): void => {
        if (radius === 0) {
          out.push({ x: at.x, y: at.y })
          return
        }
        const k = radius * KAPPA
        out.push({
          x: at.x - enter.x * radius,
          y: at.y - enter.y * radius,
          cpOut: { x: enter.x * k, y: enter.y * k },
        })
        out.push({
          x: at.x + leave.x * radius,
          y: at.y + leave.y * radius,
          cpIn: { x: -leave.x * k, y: -leave.y * k },
        })
      }
      corner(tl, { x: 0, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 })
      corner(tr, { x: w, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 })
      corner(br, { x: w, y: h }, { x: 0, y: 1 }, { x: -1, y: 0 })
      corner(bl, { x: 0, y: h }, { x: -1, y: 0 }, { x: 0, y: -1 })
      return out
    }
  }
}
