/**
 * renderer/fillStyleToPixi.ts
 *
 * P5b: translate our `FillStyle` union into a fill argument that Pixi v8
 * `Graphics.fill()` accepts.
 *
 * Linear gradients:
 * Pixi v8's `FillGradient` ships with a bug in `buildLinearGradient`
 * (see node_modules/pixi.js/lib/scene/graphics/shared/fill/FillGradient.js):
 * when either dx or dy of the start→end vector is negative, it swaps
 * coords axis-by-axis and unconditionally reverses the 1D texture.
 * Effect: as the user's angle slider passes 90° / 180° / 270° the
 * gradient snaps to a mirrored variant instead of smoothly rotating.
 *
 * Workaround: skip FillGradient entirely. Paint the gradient on a
 * shape-sized 2D canvas with the browser's CanvasRenderingContext2D
 * (which handles arbitrary gradient directions without buggy axis
 * games), and hand the resulting Texture to Graphics.fill. The
 * texture already has the rotation baked in, so Pixi just maps it 1:1
 * onto the path's local bounds.
 */

import { Matrix, Texture } from 'pixi.js'
import type { FillStyle, ImageFillStyle } from '@narrative/shared'

export interface ResolvedFillInput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi fill accepts color number, Texture, or object
  input: any
}

function clampStops(
  stops: ReadonlyArray<{ color: number; offset: number }>,
): Array<{ color: number; offset: number }> {
  if (stops.length === 0) return [{ color: 0xffffff, offset: 0 }]
  if (stops.length === 1) {
    const c = stops[0]!.color
    return [
      { color: c, offset: 0 },
      { color: c, offset: 1 },
    ]
  }
  return stops.map((s) => ({ color: s.color, offset: Math.max(0, Math.min(1, s.offset)) }))
}

function numberToRgba(hex: number): string {
  const r = (hex >> 16) & 0xff
  const g = (hex >> 8) & 0xff
  const b = hex & 0xff
  return `rgb(${r}, ${g}, ${b})`
}

/**
 * Paint a shape-sized canvas with the gradient at the authored angle
 * and wrap it in a Pixi Texture. Width / height are rounded + clamped
 * so a freshly created shape (size 0) or an insane slider value doesn't
 * pass absurd dimensions to Canvas2D.
 */
function paintLinearGradientTexture(
  stops: Array<{ color: number; offset: number }>,
  angleDeg: number,
  widthPx: number,
  heightPx: number,
): Texture {
  const w = Math.max(1, Math.round(widthPx))
  const h = Math.max(1, Math.round(heightPx))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!

  // Angle 0 = top→bottom, clockwise: 90° = left→right. Direction vector:
  const angle = (angleDeg * Math.PI) / 180
  const dx = Math.sin(angle)
  const dy = Math.cos(angle)
  // Half-extent along the direction so the gradient line covers the
  // farthest AABB corner — otherwise stops clamp in the corners and
  // we'd see flat wedges near ±45° angles.
  const halfExt = (Math.abs(dx) * w + Math.abs(dy) * h) / 2
  const cx = w / 2
  const cy = h / 2
  const x0 = cx - dx * halfExt
  const y0 = cy - dy * halfExt
  const x1 = cx + dx * halfExt
  const y1 = cy + dy * halfExt

  const linear = ctx.createLinearGradient(x0, y0, x1, y1)
  for (const s of stops) linear.addColorStop(s.offset, numberToRgba(s.color))
  ctx.fillStyle = linear
  ctx.fillRect(0, 0, w, h)

  return Texture.from({ resource: canvas })
}

function paintRadialGradientTexture(
  stops: Array<{ color: number; offset: number }>,
  centerXNorm: number,
  centerYNorm: number,
  widthPx: number,
  heightPx: number,
): Texture {
  const w = Math.max(1, Math.round(widthPx))
  const h = Math.max(1, Math.round(heightPx))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const cx = centerXNorm * w
  const cy = centerYNorm * h
  const outerRadius = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy))
  const radial = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerRadius)
  for (const s of stops) radial.addColorStop(s.offset, numberToRgba(s.color))
  ctx.fillStyle = radial
  ctx.fillRect(0, 0, w, h)
  return Texture.from({ resource: canvas })
}

/**
 * Shape-aware entry point. Renderers that know their AABB call this so
 * the gradient texture is sized to match the painted path and the four
 * corners always land inside the gradient range.
 */
export function fillStyleToPixi(
  fillStyle: FillStyle | undefined,
  solidFallback: number,
  widthPx: number,
  heightPx: number,
): ResolvedFillInput {
  if (fillStyle === undefined) return { input: { color: solidFallback } }
  if (fillStyle.kind === 'linearGradient') {
    const texture = paintLinearGradientTexture(
      clampStops(fillStyle.stops),
      fillStyle.angleDeg,
      widthPx,
      heightPx,
    )
    return { input: { texture } }
  }
  if (fillStyle.kind === 'radialGradient') {
    const texture = paintRadialGradientTexture(
      clampStops(fillStyle.stops),
      fillStyle.centerX ?? 0.5,
      fillStyle.centerY ?? 0.5,
      widthPx,
      heightPx,
    )
    return { input: { texture } }
  }
  return { input: { color: solidFallback } }
}

/**
 * Build the Pixi fill descriptor for an image fill. The texture is
 * already loaded (caller got it from ensureImageFill).
 *
 * We go through `textureSpace: 'local'` so Pixi normalizes the shape
 * AABB to 0..1 before it applies our matrix's inverse to get the UV.
 * In that space our matrix expresses "UV → normalized-bounds": at
 * UV (0,0) the texture's top-left lands at normalized-bounds (tx, ty),
 * and UV (1,1) lands at (tx + a, ty + d). For `cover`, `a` / `d` are
 * the texture's world size divided by the shape dim (`>= 1` in the
 * overflowing axis), and `tx` / `ty` centre the overflow symmetrically.
 *
 * Going via `textureSpace: 'global'` would also drop the user matrix
 * through an additional `.scale(1/texW, 1/texH)` step that shrinks
 * the gradient by ~`texW` ×, leading to the "texture zoomed in past
 * a single pixel" look the earlier revision had.
 */
export function imageFillToPixiFill(
  fill: ImageFillStyle,
  texture: Texture,
  shapeWidth: number,
  shapeHeight: number,
): { texture: Texture; matrix: Matrix; textureSpace: 'local' } {
  const texW = texture.width
  const texH = texture.height
  const fit = fill.fit ?? 'cover'
  const k =
    fit === 'cover'
      ? Math.max(shapeWidth / texW, shapeHeight / texH)
      : Math.min(shapeWidth / texW, shapeHeight / texH)
  // Texture size expressed in fractions of the shape AABB.
  const a = (texW * k) / shapeWidth
  const d = (texH * k) / shapeHeight
  const tx = (1 - a) / 2
  const ty = (1 - d) / 2
  const m = new Matrix()
  m.a = a
  m.d = d
  m.tx = tx
  m.ty = ty
  return { texture, matrix: m, textureSpace: 'local' }
}
