/**
 * renderer/objectRenderers/imageRenderer.ts
 *
 * Object renderer for type 'image'.
 *
 * Responsibilities:
 * - mount(): Creates Container + placeholder Graphics. Kicks off async URL resolve
 *   → texture acquire. On texture ready: creates Sprite with cover/contain fit.
 *   On error: shows error indicator Graphics.
 * - update(): Full object update — re-acquires texture if assetId/variant changed,
 *   recomputes fit if dimensions/fit changed, applies transform.
 * - applyPatch(): Surgical patch — handles async re-load for assetId/variant changes.
 * - destroy(): Releases acquired texture, sets aborted flag, destroys Container.
 *
 * Fit modes (within width × height bounding box):
 * - 'cover'  (default): scale = max(boxW/texW, boxH/texH). Masked to box size.
 * - 'contain': scale = min(boxW/texW, boxH/texH). Centered, no mask needed.
 *
 * Async safety:
 * - An `aborted` flag (Symbol-tagged on the Container) is set to true in destroy().
 * - Any in-flight URL resolve or texture acquire checks this flag and becomes a no-op.
 *
 * Thumbnail context:
 * - thumbnailMount renders a static gray placeholder — never loads textures.
 *   This avoids expensive raster loading in the offscreen thumbnail Pixi app.
 *   Full image thumbnails are deferred to M29.
 */

import { Container, Graphics, Sprite, type Texture } from 'pixi.js'
import type { ImageObject } from '@narrative/shared'
import { getDefaultImageUrlResolver } from '../imageUrl.js'
import { getDefaultResourceManager } from '../ResourceManager.js'
import { applyFit, applyCoverMask } from '../mediaFit.js'

// ---------------------------------------------------------------------------
// Symbol tags for internal state stored on Container instances
// ---------------------------------------------------------------------------

/** Currently displayed Sprite (may be null while loading). */
const SPRITE_TAG = Symbol('imgSprite')
/** Placeholder / error Graphics. */
const PLACEHOLDER_TAG = Symbol('imgPlaceholder')
/** Mask Graphics applied to sprite container in 'cover' mode. */
const MASK_TAG = Symbol('imgMask')
/** Inner container wrapping the Sprite (needed for cover masking). */
const SPRITE_WRAP_TAG = Symbol('imgSpriteWrap')
/** Abort flag — set to true on destroy() to cancel in-flight async work. */
const ABORTED_TAG = Symbol('imgAborted')
/** URL of the currently acquired texture (for release on update/destroy). */
const ACQUIRED_URL_TAG = Symbol('imgAcquiredUrl')

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
// Placeholder / error drawing
// ---------------------------------------------------------------------------

/** Draws a gray placeholder rectangle representing the loading state. */
function drawPlaceholder(g: Graphics, width: number, height: number): void {
  g.clear()
  g.rect(0, 0, width, height)
  g.fill({ color: 0xcccccc, alpha: 1 })
}

/** Draws a red error indicator rectangle with a small exclamation mark in Graphics. */
function drawErrorIndicator(g: Graphics, width: number, height: number): void {
  g.clear()
  // Background
  g.rect(0, 0, width, height)
  g.fill({ color: 0xffe0e0, alpha: 1 })
  // Red border
  g.rect(0, 0, width, height)
  g.stroke({ color: 0xcc0000, width: 2, alpha: 1 })
  // Central exclamation mark: vertical bar
  const cx = width / 2
  const cy = height / 2
  const barW = Math.max(2, width * 0.04)
  const barH = Math.max(8, height * 0.3)
  g.rect(cx - barW / 2, cy - barH / 2 - barH * 0.15, barW, barH)
  g.fill({ color: 0xcc0000, alpha: 1 })
  // Dot
  const dotR = Math.max(2, width * 0.04)
  g.circle(cx, cy + barH / 2 + dotR, dotR)
  g.fill({ color: 0xcc0000, alpha: 1 })
}

// ---------------------------------------------------------------------------
// Core async load logic
// ---------------------------------------------------------------------------

/**
 * Starts the async flow: resolve URL → acquire texture → apply to container.
 * Checks aborted flag at each await point to avoid work after destroy().
 */
function startLoad(container: Container, data: ImageObject): void {
  const assetId = data.assetId
  const variant = data.variant ?? 'display'
  const fit = data.fit ?? 'cover'
  const box = { w: data.width, h: data.height }

  const resolver = getDefaultImageUrlResolver()
  const rm = getDefaultResourceManager()

  // Release any previously acquired texture before starting a new load.
  const prevUrl = getAcquiredUrl(container)
  if (prevUrl !== undefined) {
    rm.releaseTexture(prevUrl)
    setAcquiredUrl(container, undefined)
  }

  // Restore / reset placeholder (hide error state from previous failed load).
  const placeholder = getPlaceholder(container)
  if (placeholder !== undefined) {
    drawPlaceholder(placeholder, box.w, box.h)
    if (!placeholder.parent) {
      container.addChild(placeholder)
    }
  }

  // Remove any existing sprite wrap so we start clean.
  const oldWrap = getSpriteWrap(container)
  if (oldWrap !== undefined) {
    oldWrap.destroy({ children: true })
    setSpriteWrap(container, undefined)
    setSprite(container, undefined)
    setMask(container, undefined)
  }

  // Empty assetId — remain in placeholder state (broken object, upload pending).
  if (assetId === '') return

  void (async () => {
    let url: string
    try {
      url = await resolver({ assetId, variant })
    } catch {
      if (isAborted(container)) return
      // Show error indicator.
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
      // We acquired a texture we'll never use — release it immediately.
      rm.releaseTexture(url)
      return
    }

    setAcquiredUrl(container, url)

    // Build sprite wrap + sprite.
    const spriteWrap = new Container()
    const sprite = new Sprite(texture)

    applyFit(sprite, texture, box, fit)
    spriteWrap.addChild(sprite)

    if (fit === 'cover') {
      const mask = applyCoverMask(spriteWrap, undefined, box)
      setMask(container, mask)
    }

    container.addChild(spriteWrap)
    setSpriteWrap(container, spriteWrap)
    setSprite(container, sprite)

    // Hide placeholder now that the sprite is ready.
    const ph = getPlaceholder(container)
    if (ph !== undefined && !ph.destroyed) {
      ph.visible = false
    }
  })()
}

// ---------------------------------------------------------------------------
// Exported renderer
// ---------------------------------------------------------------------------

export const imageRenderer = {
  type: 'image' as const,

  /**
   * Creates a Container with a gray placeholder Graphics and kicks off async load.
   */
  mount(data: ImageObject): Container {
    const container = new Container()

    // Placeholder visible while loading.
    const placeholder = new Graphics()
    drawPlaceholder(placeholder, data.width, data.height)
    container.addChild(placeholder)
    setPlaceholder(container, placeholder)

    applyObjectTransform(container, data)

    // Kick off async load.
    startLoad(container, data)

    return container
  },

  /**
   * Full update — rebuilds everything from new data.
   * Async re-load triggered if assetId or variant changed.
   */
  update(node: Container, prev: ImageObject, next: ImageObject): void {
    applyObjectTransform(node, next)

    const box = { w: next.width, h: next.height }

    // Resize placeholder.
    const ph = getPlaceholder(node)
    if (ph !== undefined && !ph.destroyed) {
      drawPlaceholder(ph, box.w, box.h)
      ph.visible = true
    }

    const assetChanged = prev.assetId !== next.assetId || prev.variant !== next.variant
    const fitChanged = prev.fit !== next.fit
    const sizeChanged = prev.width !== next.width || prev.height !== next.height

    if (assetChanged) {
      // Full re-load: startLoad handles old texture release.
      startLoad(node, next)
      return
    }

    // If only size or fit changed, update sprite in place.
    if (fitChanged || sizeChanged) {
      const sprite = getSprite(node)
      if (sprite !== undefined && sprite.texture !== undefined) {
        const fit = next.fit ?? 'cover'
        applyFit(sprite, sprite.texture, box, fit)

        const spriteWrap = getSpriteWrap(node)
        if (spriteWrap !== undefined) {
          if (fit === 'cover') {
            const existingMask = getMask(node)
            const newMask = applyCoverMask(spriteWrap, existingMask, box)
            setMask(node, newMask)
          } else {
            // Remove cover mask if switching to contain.
            const existingMask = getMask(node)
            if (existingMask !== undefined) {
              spriteWrap.mask = null
              existingMask.destroy()
              setMask(node, undefined)
            }
          }
        }
      }
    }
  },

  /**
   * Surgical patch update — updates only touched fields.
   *
   * Cases:
   * - x | y | rotation | opacity → container transform only
   * - width | height | fit → recompute fit + mask on existing sprite
   * - assetId | variant → async re-load
   */
  applyPatch(node: Container, patch: Partial<ImageObject>): void {
    // Transform fields.
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

    // Geometry / fit fields.
    const sizeChanged = patch.width !== undefined || patch.height !== undefined
    const fitChanged = patch.fit !== undefined

    if (sizeChanged) {
      // Recalculate pivot and position.
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

      // Resize placeholder.
      const ph = getPlaceholder(node)
      if (ph !== undefined && !ph.destroyed) {
        drawPlaceholder(ph, newW, newH)
      }
    }

    if (sizeChanged || fitChanged) {
      const sprite = getSprite(node)
      if (sprite !== undefined && sprite.texture !== undefined) {
        // Reconstruct current box dimensions from pivot.
        const currentW = node.pivot.x * 2
        const currentH = node.pivot.y * 2
        const box = { w: currentW, h: currentH }

        // Determine current fit — can't read from node, use patch.fit or infer from mask presence.
        // We resolve: if patch.fit is given, use it; else keep existing behaviour (mask = cover).
        let fit: 'cover' | 'contain'
        if (patch.fit !== undefined) {
          fit = patch.fit
        } else {
          // Infer from whether a mask exists.
          fit = getMask(node) !== undefined ? 'cover' : 'contain'
        }

        applyFit(sprite, sprite.texture, box, fit)

        const spriteWrap = getSpriteWrap(node)
        if (spriteWrap !== undefined) {
          if (fit === 'cover') {
            const existingMask = getMask(node)
            const newMask = applyCoverMask(spriteWrap, existingMask, box)
            setMask(node, newMask)
          } else {
            const existingMask = getMask(node)
            if (existingMask !== undefined) {
              spriteWrap.mask = null
              existingMask.destroy()
              setMask(node, undefined)
            }
          }
        }
      }
    }

    // Asset change → full async re-load.
    const assetChanged = patch.assetId !== undefined || patch.variant !== undefined
    if (assetChanged) {
      // Build a synthetic full ImageObject from node state + patch.
      const currentW = node.pivot.x * 2
      const currentH = node.pivot.y * 2
      const dataX = node.x - node.pivot.x
      const dataY = node.y - node.pivot.y

      // We need assetId and variant to load. Read cached URL to infer assetId?
      // We can't easily recover the original assetId from the node, so we require
      // the caller to pass a full-enough patch. The startLoad function uses
      // patch.assetId if present, otherwise keeps previous — but we don't track
      // previous assetId on the node. Solution: store assetId on node.
      //
      // However, the full assetId must be in the patch when assetChanged is true
      // (state-sync always sends the new value in the patch). If it's missing,
      // we can't do anything useful.
      const newAssetId = patch.assetId
      if (newAssetId === undefined) {
        // variant changed but assetId not in patch — we need the full object.
        // Fallback: no-op. (Shouldn't happen in practice — state-sync sends full object on type changes.)
        return
      }

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
        fit: patch.fit ?? (getMask(node) !== undefined ? 'cover' : 'contain'),
      }

      // Show placeholder again while re-loading.
      const ph = getPlaceholder(node)
      if (ph !== undefined && !ph.destroyed) {
        drawPlaceholder(ph, currentW, currentH)
        ph.visible = true
      }

      startLoad(node, synthetic)
    }
  },

  /**
   * Releases acquired texture, aborts in-flight async work, destroys Container.
   */
  destroy(node: Container): void {
    setAborted(node)

    const url = getAcquiredUrl(node)
    if (url !== undefined) {
      try {
        getDefaultResourceManager().releaseTexture(url)
      } catch {
        // Renderer may be destroyed before ResourceManager is installed in tests — safe to ignore.
      }
      setAcquiredUrl(node, undefined)
    }

    node.destroy({ children: true })
  },

  /**
   * Thumbnail variant of mount — renders a static gray placeholder.
   * Does NOT load the texture (expensive raster load in offscreen app avoided).
   * Full image thumbnails deferred to M29.
   */
  thumbnailMount(data: ImageObject): Container {
    const container = new Container()
    const placeholder = new Graphics()
    drawPlaceholder(placeholder, data.width, data.height)
    container.addChild(placeholder)

    // Apply transform (same as mount).
    container.rotation = data.rotation
    container.alpha = data.opacity
    container.pivot.set(data.width / 2, data.height / 2)
    container.x = data.x + data.width / 2
    container.y = data.y + data.height / 2

    return container
  },
}
