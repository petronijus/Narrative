/**
 * renderer/objectRenderers/imageRenderer.ts
 *
 * Object renderer for type 'image'.
 *
 * Keynote-style crop model (replaces the old `cropRect` source-pixel
 * frame). The image's visible window is the object's own
 * x/y/width/height. The actual sprite is drawn at `imageRect` (slide
 * coords) — when imageRect is larger than / offset from the object's
 * frame, only the part covered by the frame is visible. A Pixi mask
 * Graphics covering 0,0 → object.width × object.height clips the
 * sprite to the frame.
 *
 * Defaults: imageRect undefined ⇒ rendered as if equal to the object's
 * own x/y/width/height (sprite fills the frame, fit applied).
 */

import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { ImageObject, ImageMask, CornerRadius, NormalizedPathAnchor } from '@narrative/shared'
import { getDefaultImageUrlResolver } from '../imageUrl.js'
import { getDefaultResourceManager } from '../ResourceManager.js'
import { applyFit } from '../mediaFit.js'
import { setThumbnailReady } from '../thumbnailReady.js'
import { applyFilterEffects, destroyFilterEffects, patchFilterEffects } from '../filterEffects.js'
import { markRenderDirty } from '../RenderScheduler.js'

// ---------------------------------------------------------------------------
// Symbol tags for internal state stored on Container instances
// ---------------------------------------------------------------------------

const SPRITE_TAG = Symbol('imgSprite')
const PLACEHOLDER_TAG = Symbol('imgPlaceholder')
const MASK_TAG = Symbol('imgMask')
const SPRITE_WRAP_TAG = Symbol('imgSpriteWrap')
const ABORTED_TAG = Symbol('imgAborted')
const ACQUIRED_URL_TAG = Symbol('imgAcquiredUrl')
/** Last imageRect applied (for surgical patch diffs / preserve-across-asset-swap). */
const IMAGE_RECT_TAG = Symbol('imgImageRect')
/** Last imageRotation applied. Same role as IMAGE_RECT_TAG. */
const IMAGE_ROTATION_TAG = Symbol('imgImageRotation')
/** Last mask snapshot applied — used to skip mask redraws when geometry is unchanged. */
const MASK_SHAPE_TAG = Symbol('imgMaskShape')

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol property on Pixi Container is untyped
const asAny = (node: Container): any => node as any

function getSprite(node: Container): Sprite | undefined {
  return asAny(node)[SPRITE_TAG] as Sprite | undefined
}

function setSprite(node: Container, sprite: Sprite | undefined): void {
  asAny(node)[SPRITE_TAG] = sprite
}

function getPlaceholder(node: Container): Graphics | undefined {
  return asAny(node)[PLACEHOLDER_TAG] as Graphics | undefined
}

function setPlaceholder(node: Container, g: Graphics | undefined): void {
  asAny(node)[PLACEHOLDER_TAG] = g
}

function getMask(node: Container): Graphics | undefined {
  return asAny(node)[MASK_TAG] as Graphics | undefined
}

function setMask(node: Container, g: Graphics | undefined): void {
  asAny(node)[MASK_TAG] = g
}

function getSpriteWrap(node: Container): Container | undefined {
  return asAny(node)[SPRITE_WRAP_TAG] as Container | undefined
}

function setSpriteWrap(node: Container, c: Container | undefined): void {
  asAny(node)[SPRITE_WRAP_TAG] = c
}

function isAborted(node: Container): boolean {
  return (asAny(node)[ABORTED_TAG] as boolean | undefined) ?? false
}

function setAborted(node: Container): void {
  asAny(node)[ABORTED_TAG] = true
}

function getAcquiredUrl(node: Container): string | undefined {
  return asAny(node)[ACQUIRED_URL_TAG] as string | undefined
}

function setAcquiredUrl(node: Container, url: string | undefined): void {
  asAny(node)[ACQUIRED_URL_TAG] = url
}

function getStoredImageRect(node: Container): ImageObject['imageRect'] {
  return asAny(node)[IMAGE_RECT_TAG] as ImageObject['imageRect']
}

function setStoredImageRect(node: Container, r: ImageObject['imageRect']): void {
  asAny(node)[IMAGE_RECT_TAG] = r
}

function isImageRectEqual(a: ImageObject['imageRect'], b: ImageObject['imageRect']): boolean {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function isMaskEqual(a: ImageMask | undefined, b: ImageMask | undefined): boolean {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  // Cheap deep equal — masks are tiny and only diffed on rare patches.
  return JSON.stringify(a) === JSON.stringify(b)
}

function getStoredImageRotation(node: Container): number | undefined {
  return asAny(node)[IMAGE_ROTATION_TAG] as number | undefined
}

function setStoredImageRotation(node: Container, r: number | undefined): void {
  asAny(node)[IMAGE_ROTATION_TAG] = r
}

function getStoredMask(node: Container): ImageMask | undefined {
  return asAny(node)[MASK_SHAPE_TAG] as ImageMask | undefined
}

function setStoredMask(node: Container, m: ImageMask | undefined): void {
  asAny(node)[MASK_SHAPE_TAG] = m
}

/**
 * Resolve the effective imageRect (slide coords) for a given object.
 * When imageRect is undefined the sprite occupies the object's own
 * frame — the fit ('cover' / 'contain') still applies inside that box.
 */
function effectiveImageRect(data: ImageObject): {
  x: number
  y: number
  width: number
  height: number
} {
  if (data.imageRect !== undefined) return data.imageRect
  return { x: data.x, y: data.y, width: data.width, height: data.height }
}

// ---------------------------------------------------------------------------
// Mask helper — clips visible pixels to the object's frame OR to a custom
// shape silhouette (shape-as-mask). The mask shape's bounding box always
// equals the image's frame (0..w × 0..h in object-local coords), so resizing
// the frame stretches the mask just like the original shape would have
// stretched if its width/height were resized.
// ---------------------------------------------------------------------------

function tracePolygonPath(g: Graphics, sides: number, w: number, h: number): void {
  // Same parameterisation as polygonRenderer: regular n-gon inscribed in
  // the AABB, top-pointing for triangles. Centre at (w/2, h/2), radius
  // computed from the half-extents per axis so the polygon snaps to the
  // bounding box.
  const cx = w / 2
  const cy = h / 2
  const rx = w / 2
  const ry = h / 2
  const n = Math.max(3, Math.min(12, Math.round(sides)))
  const points: number[] = []
  // Start at -90deg so the first vertex points up — matches polygonRenderer.
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
    points.push(cx + Math.cos(angle) * rx)
    points.push(cy + Math.sin(angle) * ry)
  }
  g.poly(points)
}

function traceRoundedRect(
  g: Graphics,
  w: number,
  h: number,
  cornerRadius: CornerRadius | undefined,
): void {
  if (cornerRadius === undefined || cornerRadius === 0) {
    g.rect(0, 0, w, h)
    return
  }
  if (typeof cornerRadius === 'number') {
    const r = Math.min(cornerRadius, w / 2, h / 2)
    g.roundRect(0, 0, w, h, r)
    return
  }
  // Per-corner radii — trace explicitly via arcTo segments.
  const tl = Math.max(0, Math.min(cornerRadius.tl, w / 2, h / 2))
  const tr = Math.max(0, Math.min(cornerRadius.tr, w / 2, h / 2))
  const br = Math.max(0, Math.min(cornerRadius.br, w / 2, h / 2))
  const bl = Math.max(0, Math.min(cornerRadius.bl, w / 2, h / 2))
  g.moveTo(tl, 0)
  g.lineTo(w - tr, 0)
  if (tr > 0) g.arcTo(w, 0, w, tr, tr)
  g.lineTo(w, h - br)
  if (br > 0) g.arcTo(w, h, w - br, h, br)
  g.lineTo(bl, h)
  if (bl > 0) g.arcTo(0, h, 0, h - bl, bl)
  g.lineTo(0, tl)
  if (tl > 0) g.arcTo(0, 0, tl, 0, tl)
}

function tracePathMask(
  g: Graphics,
  anchors: NormalizedPathAnchor[],
  w: number,
  h: number,
  closed: boolean,
): void {
  if (anchors.length === 0) return
  const toLocal = (n: { x: number; y: number }): { x: number; y: number } => ({
    x: n.x * w,
    y: n.y * h,
  })
  const first = anchors[0]
  if (first === undefined) return
  const f = toLocal(first)
  g.moveTo(f.x, f.y)
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1]!
    const curr = anchors[i]!
    const cpOut = prev.cpOut
    const cpIn = curr.cpIn
    const p = toLocal(curr)
    if (cpOut !== undefined && cpIn !== undefined) {
      const c1 = toLocal({ x: prev.x + cpOut.x, y: prev.y + cpOut.y })
      const c2 = toLocal({ x: curr.x + cpIn.x, y: curr.y + cpIn.y })
      g.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y)
    } else {
      g.lineTo(p.x, p.y)
    }
  }
  if (closed) {
    const prev = anchors[anchors.length - 1]!
    const curr = anchors[0]!
    const cpOut = prev.cpOut
    const cpIn = curr.cpIn
    const p = toLocal(curr)
    if (cpOut !== undefined && cpIn !== undefined) {
      const c1 = toLocal({ x: prev.x + cpOut.x, y: prev.y + cpOut.y })
      const c2 = toLocal({ x: curr.x + cpIn.x, y: curr.y + cpIn.y })
      g.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y)
    } else {
      g.lineTo(p.x, p.y)
    }
    g.closePath()
  }
}

function traceMaskPath(g: Graphics, mask: ImageMask, w: number, h: number): void {
  switch (mask.kind) {
    case 'rectangle':
      traceRoundedRect(g, w, h, mask.cornerRadius)
      return
    case 'ellipse':
      g.ellipse(w / 2, h / 2, w / 2, h / 2)
      return
    case 'triangle':
      tracePolygonPath(g, 3, w, h)
      return
    case 'polygon':
      tracePolygonPath(g, mask.sides, w, h)
      return
    case 'path':
      tracePathMask(g, mask.anchors, w, h, mask.closed)
      return
  }
}

function applyFrameMask(
  node: Container,
  w: number,
  h: number,
  shape: ImageMask | undefined,
): Graphics {
  let mask = getMask(node)
  if (mask === undefined || mask.destroyed) {
    mask = new Graphics()
    node.addChild(mask)
    setMask(node, mask)
  }
  mask.clear()
  if (shape === undefined) {
    mask.rect(0, 0, w, h)
  } else {
    traceMaskPath(mask, shape, w, h)
  }
  mask.fill({ color: 0xffffff, alpha: 1 })
  // Apply the mask to the sprite-wrap (so the placeholder is unmasked).
  const wrap = getSpriteWrap(node)
  if (wrap !== undefined) {
    wrap.mask = mask
  }
  setStoredMask(node, shape)
  return mask
}

// ---------------------------------------------------------------------------
// Transform helpers
// ---------------------------------------------------------------------------

function applyObjectTransform(container: Container, data: ImageObject): void {
  container.rotation = data.rotation
  container.alpha = data.opacity
  container.pivot.set(data.width / 2, data.height / 2)
  container.x = data.x + data.width / 2
  container.y = data.y + data.height / 2
}

// ---------------------------------------------------------------------------
// Sprite layout — positions + sizes the sprite according to imageRect.
// ---------------------------------------------------------------------------

/**
 * Position + scale the sprite so it visually occupies imageRect (in
 * slide coords) inside the object's container (which is positioned at
 * the object's x/y, with pivot at center). The container's local
 * origin is the object's top-left; we translate the sprite to
 * (imageRect.x - object.x, imageRect.y - object.y) and scale it so the
 * raw texture maps to imageRect.width × imageRect.height.
 *
 * Fit mode is honoured INSIDE the imageRect rectangle the same way it
 * was before — 'cover' fills the box (cropping internally), 'contain'
 * letterboxes.
 */
function layoutSprite(
  sprite: Sprite,
  texture: Texture,
  data: ImageObject,
  spriteWrap: Container,
): void {
  const ir = effectiveImageRect(data)
  const fit = data.fit ?? 'cover'
  // applyFit sets sprite.x/y/scale to fill / contain a `box`. We keep
  // that semantics inside the imageRect so existing behaviour for
  // non-cropped images is unchanged. The sprite is parented to
  // spriteWrap which we translate so applyFit's local (0,0) lands at
  // (ir.x - data.x, ir.y - data.y) inside the object container.
  applyFit(sprite, texture, { w: ir.width, h: ir.height }, fit)

  // Only enable centre-pivot positioning when rotation is non-zero —
  // setting a non-zero pivot on a Pixi Container with a mask appears to
  // break thumbnail render-to-texture in some cases (mask not applied or
  // sprite drops out of the rasterised frame). For the un-rotated case
  // (vast majority) keep the old simple top-left positioning so
  // thumbnails behave exactly like before P11r.
  const rot = data.imageRotation ?? 0
  if (rot !== 0) {
    spriteWrap.pivot.set(ir.width / 2, ir.height / 2)
    spriteWrap.x = ir.x - data.x + ir.width / 2
    spriteWrap.y = ir.y - data.y + ir.height / 2
  } else {
    spriteWrap.pivot.set(0, 0)
    spriteWrap.x = ir.x - data.x
    spriteWrap.y = ir.y - data.y
  }
  spriteWrap.rotation = rot
}

// ---------------------------------------------------------------------------
// Placeholder / error drawing
// ---------------------------------------------------------------------------

function drawPlaceholder(g: Graphics, width: number, height: number): void {
  g.clear()
  g.rect(0, 0, width, height)
  g.fill({ color: 0xcccccc, alpha: 1 })
}

function drawErrorIndicator(g: Graphics, width: number, height: number): void {
  g.clear()
  g.rect(0, 0, width, height)
  g.fill({ color: 0xffe0e0, alpha: 1 })
  g.rect(0, 0, width, height)
  g.stroke({ color: 0xcc0000, width: 2, alpha: 1 })
  const cx = width / 2
  const cy = height / 2
  const barW = Math.max(2, width * 0.04)
  const barH = Math.max(8, height * 0.3)
  g.rect(cx - barW / 2, cy - barH / 2 - barH * 0.15, barW, barH)
  g.fill({ color: 0xcc0000, alpha: 1 })
  const dotR = Math.max(2, width * 0.04)
  g.circle(cx, cy + barH / 2 + dotR, dotR)
  g.fill({ color: 0xcc0000, alpha: 1 })
}

// ---------------------------------------------------------------------------
// Core async load
// ---------------------------------------------------------------------------

function startLoad(container: Container, data: ImageObject): void {
  const assetId = data.assetId
  const variant = data.variant ?? 'display'
  const box = { w: data.width, h: data.height }

  const resolver = getDefaultImageUrlResolver()
  const rm = getDefaultResourceManager()

  const prevUrl = getAcquiredUrl(container)
  if (prevUrl !== undefined) {
    rm.releaseTexture(prevUrl)
    setAcquiredUrl(container, undefined)
  }

  const placeholder = getPlaceholder(container)
  if (placeholder !== undefined) {
    drawPlaceholder(placeholder, box.w, box.h)
    if (!placeholder.parent) {
      container.addChild(placeholder)
    }
  }

  const oldWrap = getSpriteWrap(container)
  if (oldWrap !== undefined) {
    oldWrap.destroy({ children: true })
    setSpriteWrap(container, undefined)
    setSprite(container, undefined)
  }
  // Drop any stale mask too — we'll create a fresh one once the sprite is up.
  const oldMask = getMask(container)
  if (oldMask !== undefined && !oldMask.destroyed) {
    oldMask.destroy()
    setMask(container, undefined)
  }

  if (assetId === '') return

  void (async () => {
    let url: string
    try {
      url = await resolver({ assetId, variant })
    } catch {
      if (isAborted(container)) return
      const errG = getPlaceholder(container)
      if (errG !== undefined) {
        drawErrorIndicator(errG, box.w, box.h)
      }
      return
    }

    if (isAborted(container)) return

    let texture: Texture
    try {
      texture = await rm.acquireTexture(url)
    } catch {
      if (isAborted(container)) return
      const errG = getPlaceholder(container)
      if (errG !== undefined) {
        drawErrorIndicator(errG, box.w, box.h)
      }
      return
    }

    if (isAborted(container)) {
      rm.releaseTexture(url)
      return
    }

    setAcquiredUrl(container, url)

    const spriteWrap = new Container()
    const sprite = new Sprite(texture)
    setStoredImageRect(container, data.imageRect)
    setStoredImageRotation(container, data.imageRotation)

    layoutSprite(sprite, texture, data, spriteWrap)
    spriteWrap.addChild(sprite)

    container.addChild(spriteWrap)
    setSpriteWrap(container, spriteWrap)
    setSprite(container, sprite)

    // Frame mask — always clip to the object's frame so a larger /
    // offset imageRect doesn't bleed past it. For 'cover' fit with
    // imageRect undefined this matches the old applyCoverMask behaviour.
    // When data.mask is set, the rect is replaced by the shape silhouette.
    applyFrameMask(container, data.width, data.height, data.mask)

    const ph = getPlaceholder(container)
    if (ph !== undefined && !ph.destroyed) {
      ph.visible = false
    }

    // P12b: this async branch landed a sprite without going through any
    // SceneGraph mutation, so the auto-render-off scheduler doesn't know
    // a redraw is needed. Poke it so the new image actually shows up.
    markRenderDirty()
  })()
}

// ---------------------------------------------------------------------------
// Helpers used by update / applyPatch — re-layout the sprite without async.
// ---------------------------------------------------------------------------

function relayoutExistingSprite(node: Container, data: ImageObject): void {
  const sprite = getSprite(node)
  const wrap = getSpriteWrap(node)
  if (sprite === undefined || wrap === undefined || sprite.texture === undefined) return
  layoutSprite(sprite, sprite.texture, data, wrap)
  applyFrameMask(node, data.width, data.height, data.mask)
  setStoredImageRect(node, data.imageRect)
  setStoredImageRotation(node, data.imageRotation)
}

// ---------------------------------------------------------------------------
// Exported renderer
// ---------------------------------------------------------------------------

export const imageRenderer = {
  type: 'image' as const,

  mount(data: ImageObject): Container {
    const container = new Container()

    const placeholder = new Graphics()
    drawPlaceholder(placeholder, data.width, data.height)
    container.addChild(placeholder)
    setPlaceholder(container, placeholder)

    applyObjectTransform(container, data)
    applyFilterEffects(container, data.shadow, data.blur)

    startLoad(container, data)

    return container
  },

  update(node: Container, prev: ImageObject, next: ImageObject): void {
    applyObjectTransform(node, next)

    const ph = getPlaceholder(node)
    if (ph !== undefined && !ph.destroyed) {
      drawPlaceholder(ph, next.width, next.height)
      // Only show placeholder if there's no sprite yet.
      ph.visible = getSprite(node) === undefined
    }

    const assetChanged = prev.assetId !== next.assetId || prev.variant !== next.variant

    if (assetChanged) {
      startLoad(node, next)
      applyFilterEffects(node, next.shadow, next.blur)
      return
    }

    // Anything geometry-ish: re-layout the existing sprite and refresh the mask.
    const fitChanged = prev.fit !== next.fit
    const sizeChanged = prev.width !== next.width || prev.height !== next.height
    const posChanged = prev.x !== next.x || prev.y !== next.y
    const imageRectChanged = !isImageRectEqual(prev.imageRect, next.imageRect)
    const imageRotationChanged = (prev.imageRotation ?? 0) !== (next.imageRotation ?? 0)
    const maskChanged = !isMaskEqual(prev.mask, next.mask)

    if (
      fitChanged ||
      sizeChanged ||
      posChanged ||
      imageRectChanged ||
      imageRotationChanged ||
      maskChanged
    ) {
      relayoutExistingSprite(node, next)
    }

    applyFilterEffects(node, next.shadow, next.blur)
  },

  applyPatch(node: Container, patch: Partial<ImageObject>): void {
    if (patch.x !== undefined) {
      node.x = patch.x + node.pivot.x
    }
    if (patch.y !== undefined) {
      node.y = patch.y + node.pivot.y
    }
    if (patch.rotation !== undefined) {
      node.rotation = patch.rotation
    }
    if (patch.opacity !== undefined) {
      node.alpha = patch.opacity
    }

    const sizeChanged = patch.width !== undefined || patch.height !== undefined
    const fitChanged = patch.fit !== undefined
    const imageRectChanged = 'imageRect' in patch
    const imageRotationChanged = 'imageRotation' in patch
    const maskChanged = 'mask' in patch
    const posChanged = patch.x !== undefined || patch.y !== undefined

    if (sizeChanged) {
      const currentPivotX = node.pivot.x
      const currentPivotY = node.pivot.y
      const dataX = node.x - currentPivotX
      const dataY = node.y - currentPivotY
      const currentW = currentPivotX * 2
      const currentH = currentPivotY * 2

      const newW = patch.width ?? currentW
      const newH = patch.height ?? currentH

      node.pivot.set(newW / 2, newH / 2)
      node.x = dataX + newW / 2
      node.y = dataY + newH / 2

      const ph = getPlaceholder(node)
      if (ph !== undefined && !ph.destroyed) {
        drawPlaceholder(ph, newW, newH)
      }
    }

    if (
      sizeChanged ||
      fitChanged ||
      imageRectChanged ||
      imageRotationChanged ||
      maskChanged ||
      posChanged
    ) {
      // Reconstruct effective ImageObject state from node + patch.
      const currentW = node.pivot.x * 2
      const currentH = node.pivot.y * 2
      const dataX = node.x - node.pivot.x
      const dataY = node.y - node.pivot.y

      // Resolve current imageRect / imageRotation / mask: patch wins, otherwise stored.
      const currentImageRect = imageRectChanged ? patch.imageRect : getStoredImageRect(node)
      const currentImageRotation = imageRotationChanged
        ? patch.imageRotation
        : getStoredImageRotation(node)
      const currentMask = maskChanged ? patch.mask : getStoredMask(node)

      // Infer current fit. We can't read fit from the node directly
      // (no symbol stored) — use patch.fit if given, otherwise infer
      // from mask presence. With Keynote-style crop we ALWAYS keep a
      // frame mask, so this defaults to 'cover'.
      const fit: 'cover' | 'contain' = patch.fit ?? 'cover'

      const synthetic: ImageObject = {
        id: '',
        type: 'image',
        x: dataX,
        y: dataY,
        width: currentW,
        height: currentH,
        rotation: node.rotation,
        opacity: node.alpha,
        assetId: '',
        fit,
        ...(currentImageRect !== undefined ? { imageRect: currentImageRect } : {}),
        ...(currentImageRotation !== undefined ? { imageRotation: currentImageRotation } : {}),
        ...(currentMask !== undefined ? { mask: currentMask } : {}),
      }

      relayoutExistingSprite(node, synthetic)
    }

    const assetChanged = patch.assetId !== undefined || patch.variant !== undefined
    if (assetChanged) {
      const currentW = node.pivot.x * 2
      const currentH = node.pivot.y * 2
      const dataX = node.x - node.pivot.x
      const dataY = node.y - node.pivot.y

      const newAssetId = patch.assetId
      if (newAssetId === undefined) return

      // Preserve the imageRect + imageRotation + mask across an asset
      // re-load unless the patch explicitly clears them.
      const imageRectForReload = 'imageRect' in patch ? patch.imageRect : getStoredImageRect(node)
      const imageRotationForReload =
        'imageRotation' in patch ? patch.imageRotation : getStoredImageRotation(node)
      const maskForReload = 'mask' in patch ? patch.mask : getStoredMask(node)
      const synthetic: ImageObject = {
        id: '',
        type: 'image',
        x: dataX,
        y: dataY,
        width: currentW,
        height: currentH,
        rotation: node.rotation,
        opacity: node.alpha,
        assetId: newAssetId,
        ...(patch.variant !== undefined ? { variant: patch.variant } : {}),
        fit: patch.fit ?? 'cover',
        ...(imageRectForReload !== undefined ? { imageRect: imageRectForReload } : {}),
        ...(imageRotationForReload !== undefined ? { imageRotation: imageRotationForReload } : {}),
        ...(maskForReload !== undefined ? { mask: maskForReload } : {}),
      }

      const ph = getPlaceholder(node)
      if (ph !== undefined && !ph.destroyed) {
        drawPlaceholder(ph, currentW, currentH)
        ph.visible = true
      }

      startLoad(node, synthetic)
    }

    if ('shadow' in patch || 'blur' in patch) {
      patchFilterEffects(node, 'shadow' in patch, patch.shadow, 'blur' in patch, patch.blur)
    }
  },

  destroy(node: Container): void {
    setAborted(node)

    const url = getAcquiredUrl(node)
    if (url !== undefined) {
      try {
        getDefaultResourceManager().releaseTexture(url)
      } catch {
        // RM may be torn down already.
      }
      setAcquiredUrl(node, undefined)
    }

    destroyFilterEffects(node)
    node.destroy({ children: true })
  },

  thumbnailMount(data: ImageObject): Container {
    const container = new Container()
    const placeholder = new Graphics()
    drawPlaceholder(placeholder, data.width, data.height)
    container.addChild(placeholder)
    setPlaceholder(container, placeholder)

    container.rotation = data.rotation
    container.alpha = data.opacity
    container.pivot.set(data.width / 2, data.height / 2)
    container.x = data.x + data.width / 2
    container.y = data.y + data.height / 2

    const { assetId } = data
    if (assetId === '') return container

    const fit = data.fit ?? 'cover'
    const resolver = getDefaultImageUrlResolver()

    const ready = (async () => {
      let url: string
      try {
        url = await resolver({ assetId, variant: 'thumb' })
      } catch {
        return
      }
      if (isAborted(container)) return

      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = url
      try {
        await img.decode()
      } catch {
        return
      }
      if (isAborted(container)) return

      const texture = Texture.from(img)
      const spriteWrap = new Container()
      const sprite = new Sprite(texture)
      // Reuse the same imageRect-aware layout so cropped thumbnails
      // mirror the editor view.
      layoutSprite(sprite, texture, data, spriteWrap)
      spriteWrap.addChild(sprite)

      container.addChild(spriteWrap)
      setSpriteWrap(container, spriteWrap)
      setSprite(container, sprite)

      // Frame mask — clip sprite to the object's frame (or shape mask).
      applyFrameMask(container, data.width, data.height, data.mask)

      // applyCoverMask is no longer needed — applyFrameMask handles it
      // generically. The fit-related behaviour for the un-cropped case
      // (imageRect undefined, fit='cover') is preserved because
      // layoutSprite still runs applyFit inside imageRect = full frame.
      void fit

      const ph = getPlaceholder(container)
      if (ph !== undefined && !ph.destroyed) {
        ph.visible = false
      }
    })()

    setThumbnailReady(container, ready)
    return container
  },
}
