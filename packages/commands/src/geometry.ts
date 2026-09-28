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
