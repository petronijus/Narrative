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

import { Matrix, Texture, type Container } from 'pixi.js'
import type { FillStyle, ImageFillStyle } from '@narrative/shared'
import { getDefaultResourceManager } from './ResourceManager.js'

export interface ResolvedFillInput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi fill accepts color number, Texture, or object
  input: any
}

/**
 * Per-container memo of the procedural-texture keys currently in use,
 * keyed by an arbitrary slot id. Lets a renderer release the previous
 * key whenever a slot's fill changes (or on destroy). Shape renderers
 * (rect / ellipse / triangle / polygon / path) carry exactly one fill
 * per Container and use the default slot — `'_default'` — so they
 * effectively see a scalar. Multi-fill renderers (the table cell grid
 * paints one fill per cell on a shared container) pass distinct slot
 * keys so the slots don't clobber each other.
 *
 * Backed by a Map on the Container via Symbol tag so we don't need a
 * side-table.
 */
const PROC_SLOTS_TAG = Symbol('proceduralFillSlots')
const DEFAULT_PROC_SLOT = '_default'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol metadata on Pixi Container is untyped
const asAny = (n: Container): any => n as any

function getSlotsMap(node: Container): Map<string, string> | undefined {
  return asAny(node)[PROC_SLOTS_TAG] as Map<string, string> | undefined
}

function ensureSlotsMap(node: Container): Map<string, string> {
  let map = getSlotsMap(node)
  if (map === undefined) {
    map = new Map()
    asAny(node)[PROC_SLOTS_TAG] = map
  }
  return map
}

function getHeldProceduralKey(node: Container, slotKey = DEFAULT_PROC_SLOT): string | undefined {
  return getSlotsMap(node)?.get(slotKey)
}

function setHeldProceduralKey(
  node: Container,
  key: string | undefined,
  slotKey = DEFAULT_PROC_SLOT,
): void {
  const slots = getSlotsMap(node)
  if (key === undefined) {
    if (slots === undefined) return
    slots.delete(slotKey)
    if (slots.size === 0) delete asAny(node)[PROC_SLOTS_TAG]
    return
  }
  ensureSlotsMap(node).set(slotKey, key)
}

/**
 * Build a structural key for a gradient fill so the ResourceManager can
 * cache the painted texture. Includes every input that affects the
 * pixels: kind, dimensions, stops, angle / center.
 */
function gradientKey(
  fillStyle: FillStyle & { kind: 'linearGradient' | 'radialGradient' },
  widthPx: number,
  heightPx: number,
): string {
  const w = Math.max(1, Math.round(widthPx))
  const h = Math.max(1, Math.round(heightPx))
  const stops = fillStyle.stops
    .map((s) => `${s.offset.toFixed(3)}@${s.color.toString(16)}x${(s.alpha ?? 1).toFixed(3)}`)
    .join(',')
  if (fillStyle.kind === 'linearGradient') {
    return `lin:${w}x${h}:${fillStyle.angleDeg.toFixed(2)}:${stops}`
  }
  return `rad:${w}x${h}:${(fillStyle.centerX ?? 0.5).toFixed(3)},${(fillStyle.centerY ?? 0.5).toFixed(3)}:${stops}`
}

/**
 * Release the procedural texture currently held in `slotKey` on
 * `container`. Renderers call this from their `destroy()` hook so the
 * ResourceManager can drop the ref count. Single-slot callers (shapes)
 * omit `slotKey` and the default slot is released.
 */
export function releaseProceduralFill(container: Container, slotKey?: string): void {
  const key = getHeldProceduralKey(container, slotKey)
  if (key === undefined) return
  try {
    getDefaultResourceManager().releaseProcedural(key)
  } catch {
    // ResourceManager not installed (tests) — safe to drop.
  }
  setHeldProceduralKey(container, undefined, slotKey)
}

/**
 * Release every procedural slot held on `container`. Used by multi-slot
 * renderers (the table cell grid) so the destroy hook doesn't have to
 * enumerate slot keys it owns.
 */
export function releaseAllProceduralFills(container: Container): void {
  const slots = getSlotsMap(container)
  if (slots === undefined) return
  let rm: ReturnType<typeof getDefaultResourceManager>
  try {
    rm = getDefaultResourceManager()
  } catch {
    delete asAny(container)[PROC_SLOTS_TAG]
    return
  }
  for (const key of slots.values()) rm.releaseProcedural(key)
  delete asAny(container)[PROC_SLOTS_TAG]
}

export function clampStops(
  stops: ReadonlyArray<{ color: number; offset: number; alpha?: number }>,
): Array<{ color: number; offset: number; alpha: number }> {
  if (stops.length === 0) return [{ color: 0xffffff, offset: 0, alpha: 1 }]
  if (stops.length === 1) {
    const s = stops[0]!
    const a = s.alpha ?? 1
    return [
      { color: s.color, offset: 0, alpha: a },
      { color: s.color, offset: 1, alpha: a },
    ]
  }
  return stops.map((s) => ({
    color: s.color,
    offset: Math.max(0, Math.min(1, s.offset)),
    alpha: Math.max(0, Math.min(1, s.alpha ?? 1)),
  }))
}

function numberToRgba(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 0xff
  const g = (hex >> 8) & 0xff
  const b = hex & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Paint a shape-sized canvas with the gradient at the authored angle
 * and wrap it in a Pixi Texture. Width / height are rounded + clamped
 * so a freshly created shape (size 0) or an insane slider value doesn't
 * pass absurd dimensions to Canvas2D.
 */
function paintLinearGradientTexture(
  stops: Array<{ color: number; offset: number; alpha: number }>,
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
  for (const s of stops) linear.addColorStop(s.offset, numberToRgba(s.color, s.alpha))
  ctx.fillStyle = linear
  ctx.fillRect(0, 0, w, h)

  return Texture.from({ resource: canvas })
}

function paintRadialGradientTexture(
  stops: Array<{ color: number; offset: number; alpha: number }>,
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
  for (const s of stops) radial.addColorStop(s.offset, numberToRgba(s.color, s.alpha))
  ctx.fillStyle = radial
  ctx.fillRect(0, 0, w, h)
  return Texture.from({ resource: canvas })
}

/**
 * Shape-aware entry point. Renderers that know their AABB call this so
 * the gradient texture is sized to match the painted path and the four
 * corners always land inside the gradient range.
 *
 * P12c: when a `container` is passed, gradient textures are acquired
 * through ResourceManager's procedural cache (ref-counted, LRU-bounded).
 * The container holds the most recent procedural key so a subsequent
 * call automatically releases the previous key when the fill changes.
 *
 * Backward-compatible: if `container` is omitted (or the ResourceManager
 * default isn't installed yet — tests), falls back to one-shot
 * `Texture.from(canvas)` allocation matching the pre-P12c behaviour.
 */
export function fillStyleToPixi(
  fillStyle: FillStyle | undefined,
  solidFallback: number,
  widthPx: number,
  heightPx: number,
  container?: Container,
  slotKey?: string,
): ResolvedFillInput {
  if (fillStyle === undefined) return { input: { color: solidFallback } }

  if (fillStyle.kind === 'linearGradient' || fillStyle.kind === 'radialGradient') {
    const stops = clampStops(fillStyle.stops)
    const key = gradientKey({ ...fillStyle, stops }, widthPx, heightPx)
    const texture = acquireOrPaint(
      container,
      key,
      () => {
        if (fillStyle.kind === 'linearGradient') {
          return paintLinearGradientTexture(stops, fillStyle.angleDeg, widthPx, heightPx)
        }
        return paintRadialGradientTexture(
          stops,
          fillStyle.centerX ?? 0.5,
          fillStyle.centerY ?? 0.5,
          widthPx,
          heightPx,
        )
      },
      slotKey,
    )
    return { input: { texture } }
  }
  return { input: { color: solidFallback } }
}

/**
 * Internal: acquire `key` from the procedural cache, releasing whatever
 * key the container previously held. When no container is supplied or
 * the ResourceManager isn't installed, falls back to a fresh paint.
 *
 * Net ref-count change is always +0 across the lifetime of the
 * container: every successful `acquireOrPaint` is balanced by either
 * the next `acquireOrPaint` (which releases the old key) or by
 * `releaseProceduralFill` on destroy.
 */
function acquireOrPaint(
  container: Container | undefined,
  key: string,
  factory: () => Texture,
  slotKey?: string,
): Texture {
  if (container === undefined) return factory()
  let rm: ReturnType<typeof getDefaultResourceManager>
  try {
    rm = getDefaultResourceManager()
  } catch {
    return factory()
  }
  const prev = getHeldProceduralKey(container, slotKey)
  if (prev !== undefined) {
    rm.releaseProcedural(prev)
  }
  const tex = rm.acquireProcedural(key, factory)
  setHeldProceduralKey(container, key, slotKey)
  return tex
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
