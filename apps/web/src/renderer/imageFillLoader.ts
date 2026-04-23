/**
 * renderer/imageFillLoader.ts
 *
 * P5c: image fill support for shapes. A shape renderer calls
 * `ensureImageFill(container, fill, onReady)` during its draw routine.
 * The helper resolves the assetId → imgproxy URL → Pixi Texture chain,
 * ref-counts via ResourceManager, and tracks "currently acquired URL"
 * on the container via a Symbol tag so repeated redraws don't leak
 * refs.
 *
 * Synchronous path (fast): if the texture is already cached and matches
 * the requested assetId, it's returned immediately so the current
 * `drawX` call can paint the real image.
 *
 * Asynchronous path: on a cache miss the helper kicks off the resolve +
 * acquire chain. When the texture lands, it stores the URL on the
 * container and invokes `onReady()` — the renderer redraws itself with
 * the cached texture visible on the next tick.
 */

import type { Container, Texture } from 'pixi.js'
import { getDefaultImageUrlResolver } from './imageUrl.js'
import { getDefaultResourceManager } from './ResourceManager.js'
import type { ImageFillStyle } from '@narrative/shared'

interface FillSlot {
  assetId: string
  variant: 'display'
  url?: string
  texture?: Texture
  loading: boolean
}

const FILL_TAG = Symbol('imageFillSlot')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAny = (n: Container): any => n

function getSlot(container: Container): FillSlot | undefined {
  return asAny(container)[FILL_TAG] as FillSlot | undefined
}

function setSlot(container: Container, slot: FillSlot | undefined): void {
  if (slot === undefined) {
    delete asAny(container)[FILL_TAG]
  } else {
    asAny(container)[FILL_TAG] = slot
  }
}

/**
 * Resolve the image fill for the given shape container. Returns the
 * cached Texture when ready, null when a load is in flight (or the
 * fill isn't an image fill). Callers fall back to a solid colour while
 * null is returned.
 */
export function ensureImageFill(
  container: Container,
  fill: ImageFillStyle | undefined,
  onReady: () => void,
): Texture | null {
  const rm = getDefaultResourceManager()

  // Fill removed / switched to non-image — release any slot.
  if (fill === undefined) {
    releaseImageFill(container)
    return null
  }

  // Empty assetId is the "choose image…" placeholder the Inspector uses
  // before the first upload finishes. Bail so we don't fire bogus
  // GET /api/media//url requests that 404.
  if (fill.assetId === '') {
    releaseImageFill(container)
    return null
  }

  const variant = 'display' as const
  const current = getSlot(container)

  // Same assetId already handled — return cached texture (may be null
  // while the initial load is still in flight).
  if (current !== undefined && current.assetId === fill.assetId) {
    if (current.texture !== undefined) return current.texture
    return null
  }

  // New / changed assetId — release the previous slot's texture ref.
  if (current !== undefined) {
    if (current.url !== undefined) rm.releaseTexture(current.url)
  }

  const slot: FillSlot = { assetId: fill.assetId, variant, loading: true }
  setSlot(container, slot)

  const resolver = getDefaultImageUrlResolver()

  // Kick off the resolve → acquire chain.
  void (async () => {
    try {
      const url = await resolver({ assetId: fill.assetId, variant })
      // Bail if the slot has been replaced while we were waiting.
      const active = getSlot(container)
      if (active === undefined || active !== slot) {
        return
      }
      // Sync fast path: someone else may have loaded the same URL between
      // our resolver call and here. Check peek first.
      const cached = rm.peekTexture(url)
      if (cached !== null) {
        slot.texture = cached
        slot.url = url
        slot.loading = false
        // Bump refcount to own it.
        await rm.acquireTexture(url)
        onReady()
        return
      }
      const texture = await rm.acquireTexture(url)
      // Re-check slot identity — may have rotated during the await.
      const stillActive = getSlot(container)
      if (stillActive !== slot) {
        rm.releaseTexture(url)
        return
      }
      slot.url = url
      slot.texture = texture
      slot.loading = false
      onReady()
    } catch {
      // Silent fallback — the solid colour under the fill will stay
      // visible. A retry happens on the next fill-descriptor change.
      const stillActive = getSlot(container)
      if (stillActive === slot) {
        slot.loading = false
      }
    }
  })()

  return null
}

/** Release any image-fill texture this container has acquired. */
export function releaseImageFill(container: Container): void {
  const slot = getSlot(container)
  if (slot === undefined) return
  if (slot.url !== undefined) {
    getDefaultResourceManager().releaseTexture(slot.url)
  }
  setSlot(container, undefined)
}
