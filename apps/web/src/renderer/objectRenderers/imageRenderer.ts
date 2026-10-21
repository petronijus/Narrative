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
 *
 * Size variant (performance.md → L3; renderer/imageVariant.ts): the picture
 * is drawn from the smallest imgproxy variant that has a texel for every
 * pixel of the canvas it covers — `medium` (1280 px) or `display` (2560) —
 * chosen once its source size is known (the resolver's batched answer), at
 * the density of the canvas that mounted it (pixelDensityContext.ts). A
 * larger variant of the same picture already on the GPU is taken instead of
 * loading a second texture. When the picture grows on the canvas (a resize,
 * a zoom: `setPixelDensity`) past what its texture holds, the larger variant
 * is loaded beside it and swapped in at the same drawn size — no placeholder,
 * no frame without the picture; it never goes back down while mounted.
 */

import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import { polygonSides, regularPolygonVertices, triangleVertices } from '@narrative/shared'
import type {
  ImageObject,
  ImageMask,
  CornerRadius,
  NormalizedPathAnchor,
  ShapePoint,
} from '@narrative/shared'
import { SCREEN_IMAGE_VARIANTS, imageVariantRank, type ImageVariant } from '@narrative/shared'
import { getDefaultImageUrlResolver } from '../imageUrl.js'
import { getDefaultResourceManager } from '../ResourceManager.js'
import { imageObjectVariant, pinnedVariant, type SourceSize } from '../imageVariant.js'
import {
  mountingPixelDensity,
  mountingVariantFloor,
  type VariantFloor,
} from '../pixelDensityContext.js'
import { trackRenderWork } from '../renderWork.js'
import { applyFit } from '../mediaFit.js'
import { setThumbnailReady } from '../thumbnailReady.js'
import { applyFilterEffects, destroyFilterEffects, patchFilterEffects } from '../filterEffects.js'
import { markRenderDirty } from '../RenderScheduler.js'
import { applyFlip } from './applyFlip.js'

// ---------------------------------------------------------------------------
// Symbol tags for internal state stored on Container instances
// ---------------------------------------------------------------------------

const SPRITE_TAG = Symbol('imgSprite')
const PLACEHOLDER_TAG = Symbol('imgPlaceholder')
const MASK_TAG = Symbol('imgMask')
const SPRITE_WRAP_TAG = Symbol('imgSpriteWrap')
const ABORTED_TAG = Symbol('imgAborted')
const ACQUIRED_URL_TAG = Symbol('imgAcquiredUrl')
/**
 * Monotonic load-generation counter. Bumped at the start of every
 * `startLoad` so a still-in-flight async load from a prior asset can
 * detect that it has been superseded (rapid asset swap) and bail
 * before clobbering tags / leaking its texture. See `isStale`.
 */
const LOAD_GEN_TAG = Symbol('imgLoadGen')
/** Last imageRect applied (for surgical patch diffs / preserve-across-asset-swap). */
const IMAGE_RECT_TAG = Symbol('imgImageRect')
/** Last imageRotation applied. Same role as IMAGE_RECT_TAG. */
const IMAGE_ROTATION_TAG = Symbol('imgImageRotation')
/** Last mask snapshot applied — used to skip mask redraws when geometry is unchanged. */
const MASK_SHAPE_TAG = Symbol('imgMaskShape')
/**
 * Texture created by `thumbnailMount` via `Texture.from(img)`. Thumbnails
 * bypass the shared ResourceManager (their textures live on the offscreen
 * thumbnail Canvas's WebGL context), so nothing else owns or releases this
 * texture. `Sprite.destroy()` does NOT free textures by default — without
 * this tag every thumbnail re-render would orphan a GPU texture + its source.
 */
const THUMB_TEXTURE_TAG = Symbol('imgThumbTexture')
/** The density of the canvas the node is drawn on (device px per slide unit), null when unknown. */
const DENSITY_TAG = Symbol('imgDensity')
/** The mounting scene's variant floor (pixelDensityContext.ts), null for none. */
const FLOOR_TAG = Symbol('imgFloor')
/** The source's pixel size, once resolved (and corrected by the loaded texture's aspect). */
const SOURCE_TAG = Symbol('imgSource')
/** The variant the sprite's texture is of. */
const VARIANT_TAG = Symbol('imgVariant')
/** The variant an upgrade is loading, if one is. */
const UPGRADE_TAG = Symbol('imgUpgrade')
/** The object as last mounted / updated / patched: what a variant choice reads. */
const DATA_TAG = Symbol('imgData')

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

function getThumbTexture(node: Container): Texture | undefined {
  return asAny(node)[THUMB_TEXTURE_TAG] as Texture | undefined
}

function setThumbTexture(node: Container, texture: Texture | undefined): void {
  asAny(node)[THUMB_TEXTURE_TAG] = texture
}

/** An upgrade in flight (ensureVariant); its identity tells it from a later one. */
interface Upgrade {
  variant: ImageVariant
}

interface VariantState {
  density: number | null
  floor: VariantFloor | null
  source: SourceSize | null
  loaded: ImageVariant | null
  upgrading: Upgrade | null
  data: ImageObject | null
}

function variantState(node: Container): VariantState {
  const a = asAny(node)
  return {
    density: (a[DENSITY_TAG] as number | null | undefined) ?? null,
    floor: (a[FLOOR_TAG] as VariantFloor | null | undefined) ?? null,
    source: (a[SOURCE_TAG] as SourceSize | null | undefined) ?? null,
    loaded: (a[VARIANT_TAG] as ImageVariant | null | undefined) ?? null,
    upgrading: (a[UPGRADE_TAG] as Upgrade | null | undefined) ?? null,
    data: (a[DATA_TAG] as ImageObject | null | undefined) ?? null,
  }
}

function setVariantState(node: Container, patch: Partial<VariantState>): void {
  const a = asAny(node)
  if ('density' in patch) a[DENSITY_TAG] = patch.density
  if ('floor' in patch) a[FLOOR_TAG] = patch.floor
  if ('source' in patch) a[SOURCE_TAG] = patch.source
  if ('loaded' in patch) a[VARIANT_TAG] = patch.loaded
  if ('upgrading' in patch) a[UPGRADE_TAG] = patch.upgrading
  if ('data' in patch) a[DATA_TAG] = patch.data
}

/** Bump the load generation and return the new (captured) value. */
function bumpLoadGen(node: Container): number {
  const next = ((asAny(node)[LOAD_GEN_TAG] as number | undefined) ?? 0) + 1
  asAny(node)[LOAD_GEN_TAG] = next
  return next
}

/**
 * A load is stale when the node has been destroyed (aborted) or a newer
 * `startLoad` has bumped the generation past the one this closure
 * captured. Either way the in-flight async work must abort without
 * mutating container tags.
 */
function isStale(node: Container, myGen: number): boolean {
  return isAborted(node) || (asAny(node)[LOAD_GEN_TAG] as number | undefined) !== myGen
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

function tracePoints(g: Graphics, points: readonly ShapePoint[]): void {
  // The same outlines the triangle / polygon renderers draw
  // (@narrative/shared shapeGeometry), so a mask is the shape's silhouette.
  g.poly(points.flatMap((p) => [p.x, p.y]))
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
      tracePoints(g, triangleVertices(w, h))
      return
    case 'polygon':
      tracePoints(g, regularPolygonVertices(polygonSides(mask.sides), w, h))
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
  applyFlip(container, data)
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
  applyFit(sprite, texture, { w: ir.width, h: ir.height }, fit, data.focus)

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
  const box = { w: data.width, h: data.height }
  setVariantState(container, { data, source: null, loaded: null, upgrading: null })

  // Invalidate any load still in flight from a previous asset. The older
  // closure will observe the bumped generation after its next await and
  // bail (releasing its texture) instead of clobbering our tags or
  // orphaning a sprite wrap. Captured here so this load can self-check.
  const myGen = bumpLoadGen(container)

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
    let variant: ImageVariant
    try {
      // The source's size first (the batched answer that also resolves the
      // screen variants' URLs), then the variant for this canvas.
      const resolved = await resolver.asset(assetId)
      if (isStale(container, myGen)) return
      setVariantState(container, {
        source: { width: resolved.width, height: resolved.height },
      })
      // The node's whole object: an applyPatch reload hands startLoad a
      // synthetic one (its fit unknown) and restores the merged object.
      variant = chooseVariant(container, variantState(container).data ?? data)
      url = await resolver({ assetId, variant })
    } catch {
      if (isStale(container, myGen)) return
      const errG = getPlaceholder(container)
      if (errG !== undefined) {
        drawErrorIndicator(errG, box.w, box.h)
      }
      return
    }

    if (isStale(container, myGen)) return

    let texture: Texture
    try {
      texture = await rm.acquireTexture(url)
    } catch {
      if (isStale(container, myGen)) return
      const errG = getPlaceholder(container)
      if (errG !== undefined) {
        drawErrorIndicator(errG, box.w, box.h)
      }
      return
    }

    // Superseded by a newer load (or destroyed) while acquiring — release
    // the ref we just took and bail before touching any container tag.
    if (isStale(container, myGen)) {
      rm.releaseTexture(url)
      return
    }

    setAcquiredUrl(container, url)
    setVariantState(container, { loaded: variant })
    correctSourceAspect(container, texture)

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

    // The canvas's density, the object's size or the source's true aspect
    // may have moved on while it loaded.
    ensureVariant(container)
  })()
}

// ---------------------------------------------------------------------------
// Size variant: the choice, and the upgrade when the picture outgrows it
// ---------------------------------------------------------------------------

/**
 * The variant `data` is drawn from on the node's canvas: the smallest that
 * suffices (imageVariant.ts), raised to the scene's floor, and raised again to
 * a larger screen variant of the same picture the GPU already holds — one
 * texture serves both. The render page's cap applies in the resolver.
 */
function chooseVariant(container: Container, data: ImageObject): ImageVariant {
  const state = variantState(container)
  let variant = imageObjectVariant(data, state.source, state.density)
  if (pinnedVariant(data) !== null) return variant
  const floor = state.floor?.(data)
  if (floor !== undefined && imageVariantRank(floor) > imageVariantRank(variant)) variant = floor
  const resolver = getDefaultImageUrlResolver()
  const rm = getDefaultResourceManager()
  for (const larger of SCREEN_IMAGE_VARIANTS) {
    if (imageVariantRank(larger) <= imageVariantRank(variant)) continue
    const url = resolver.peek(data.assetId, larger)
    if (url !== undefined && rm.hasTexture(url)) return larger
  }
  return variant
}

/**
 * The asset row's width and height are the file's; a photo whose EXIF turns
 * it is served turned (imgproxy rotates it), so the texture's aspect is the
 * truth. The long side is the same either way.
 */
function correctSourceAspect(container: Container, texture: Texture): void {
  const { source } = variantState(container)
  const tw = texture.width
  const th = texture.height
  if (source === null || source.width === null || source.height === null || !(tw > 0 && th > 0))
    return
  const long = Math.max(source.width, source.height)
  const portraitSource = source.height > source.width
  const portraitTexture = th > tw
  if (portraitSource === portraitTexture) return
  const k = long / Math.max(tw, th)
  setVariantState(container, { source: { width: tw * k, height: th * k } })
}

/**
 * Load a larger variant when the picture now covers more pixels than its
 * texture holds (a resize, a zoom, the source's turned aspect), and swap it
 * in at the same drawn size once it is decoded. Never a smaller one.
 */
function ensureVariant(container: Container): void {
  const state = variantState(container)
  const data = state.data
  if (data === null || data.assetId === '' || state.loaded === null) return
  if (isAborted(container) || pinnedVariant(data) !== null) return
  const wanted = chooseVariant(container, data)
  if (imageVariantRank(wanted) <= imageVariantRank(state.loaded)) return
  if (
    state.upgrading !== null &&
    imageVariantRank(state.upgrading.variant) >= imageVariantRank(wanted)
  )
    return
  const myGen = asAny(container)[LOAD_GEN_TAG] as number
  // This upgrade's own token: a later one replaces it, and only the upgrade
  // holding it clears it again.
  const token: Upgrade = { variant: wanted }
  setVariantState(container, { upgrading: token })
  const resolver = getDefaultImageUrlResolver()
  const rm = getDefaultResourceManager()
  // Counted until the swap, so the render page and present mode's
  // preparation wait for the picture they will show (renderWork.ts).
  void trackRenderWork(
    (async () => {
      const url = await resolver({ assetId: data.assetId, variant: wanted })
      if (isStale(container, myGen)) return
      if (url === getAcquiredUrl(container)) {
        // The render page's cap: the same texture.
        if (imageVariantRank(wanted) > imageVariantRank(variantState(container).loaded ?? 'thumb'))
          setVariantState(container, { loaded: wanted })
        return
      }
      const texture = await rm.acquireTexture(url)
      const sprite = getSprite(container)
      // Read again after the await: another upgrade, a new asset or the
      // node's destruction may have come in between.
      const current = getAcquiredUrl(container)
      const loaded = variantState(container).loaded
      if (
        isStale(container, myGen) ||
        sprite === undefined ||
        sprite.destroyed ||
        url === current ||
        (loaded !== null && imageVariantRank(loaded) >= imageVariantRank(wanted))
      ) {
        // Nothing to swap: the reference this upgrade took goes back.
        rm.releaseTexture(url)
        return
      }
      const drawnW = sprite.width
      const drawnH = sprite.height
      sprite.texture = texture
      sprite.width = drawnW
      sprite.height = drawnH
      setAcquiredUrl(container, url)
      setVariantState(container, { loaded: wanted })
      if (current !== undefined) rm.releaseTexture(current)
      markRenderDirty()
    })()
      .catch((err: unknown) => {
        // The picture stays as it is, sharp enough until the next try.
        console.warn('[imageRenderer] could not load a larger variant', data.assetId, err)
      })
      .finally(() => {
        if (variantState(container).upgrading === token)
          setVariantState(container, { upgrading: null })
      }),
  )
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
    setVariantState(container, {
      density: mountingPixelDensity(),
      floor: mountingVariantFloor(),
    })

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
    const fitChanged = prev.fit !== next.fit || prev.focus !== next.focus
    const sizeChanged = prev.width !== next.width || prev.height !== next.height
    const posChanged = prev.x !== next.x || prev.y !== next.y
    const imageRectChanged = !isImageRectEqual(prev.imageRect, next.imageRect)
    const imageRotationChanged = (prev.imageRotation ?? 0) !== (next.imageRotation ?? 0)
    const maskChanged = !isMaskEqual(prev.mask, next.mask)

    setVariantState(node, { data: next })
    if (
      fitChanged ||
      sizeChanged ||
      posChanged ||
      imageRectChanged ||
      imageRotationChanged ||
      maskChanged
    ) {
      relayoutExistingSprite(node, next)
      ensureVariant(node)
    }

    applyFilterEffects(node, next.shadow, next.blur)
  },

  /**
   * The canvas's density or the scene's floor changed (SceneGraph
   * setPixelDensity / setVariantFloor): a picture that now needs more loads it.
   */
  setCanvasDensity(node: Container, density: number | null, floor: VariantFloor | null): void {
    setVariantState(node, { density, floor })
    ensureVariant(node)
  },

  applyPatch(node: Container, patch: Partial<ImageObject>): void {
    const stored = variantState(node).data
    if (stored !== null) setVariantState(node, { data: { ...stored, ...patch } })
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
      ensureVariant(node)
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

      const merged = variantState(node).data
      startLoad(node, synthetic)
      // The variant choice reads the whole object (its fit, its imageRect).
      if (merged !== null) setVariantState(node, { data: merged })
    }

    if ('shadow' in patch || 'blur' in patch) {
      patchFilterEffects(node, 'shadow' in patch, patch.shadow, 'blur' in patch, patch.blur)
    }
  },

  /**
   * No colour of its own goes through `resolveColour` — the pixels come from
   * the asset, the placeholder is a fixed grey. The shadow, the one token
   * colour ImageObject can hold, is repainted by filterEffects (index.ts).
   */
  repaintColours(_node: Container, _data: ImageObject): void {},

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

    // Thumbnail-owned texture (Texture.from(img)) — not tracked by the
    // ResourceManager, so free it and its GPU source here. Destroy the
    // sprite first (texture:false default), then the texture, so we don't
    // double-free.
    const thumbTexture = getThumbTexture(node)
    node.destroy({ children: true })
    if (thumbTexture !== undefined && !thumbTexture.destroyed) {
      try {
        thumbTexture.destroy(true)
      } catch {
        // Source may already be gone if the thumbnail context was torn down.
      }
      setThumbTexture(node, undefined)
    }
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
    applyFlip(container, data)

    const { assetId } = data
    if (assetId === '') return container

    const fit = data.fit ?? 'cover'
    const resolver = getDefaultImageUrlResolver()

    const ready = (async () => {
      // The slide-panel thumbnail PNG is rendered at 200×113 px. Each
      // image object inside that frame occupies a tiny region (typically
      // 50-200 px). Source textures larger than 600 px on the long side
      // are wasted GPU pixels.
      //
      // The 'thumb' imgproxy variant would be the right SIZE (400 wide)
      // but its directive is `rs:fill:400:225:0/g:ce` — a center-crop
      // to fixed 16:9. That mutates the aspect of any non-16:9 source
      // image, producing a thumbnail that shows different content than
      // the editor (which uses the aspect-preserving 'display' variant).
      // The bug shows up on every cropped image (`imageRect` set) and
      // on every uncropped image whose own aspect ≠ 16:9.
      //
      // 'preview' is purpose-built for this code path:
      // `rs:fit:600:600:0` — fits within 600×600 while preserving
      // aspect. 600 covers the 200-px PNG output even at 2-3× DPR and
      // moderate user-resize of the slide panel, while staying bandwidth-
      // comparable to 'thumb' (a small AVIF per image vs 'display''s
      // full 2560-px-cap render).
      let url: string
      try {
        url = await resolver({ assetId, variant: 'preview' })
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
      // This texture is owned solely by the thumbnail — tag it so destroy()
      // can free it (Sprite.destroy doesn't release textures by default).
      setThumbTexture(container, texture)
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
