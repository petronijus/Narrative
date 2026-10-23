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
      // Always go through acquireTexture so the ref-count we own pairs
      // with releaseImageFill on destroy. The previous "peek then async
      // acquire" fast path leaked one ref permanently if the slot
      // rotated between peek and the awaited acquire — the cleanup path
      // bailed without releasing the bumped count.
      const texture = await rm.acquireTexture(url, { priority: { node: container } })
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

/**
 * Multi-slot variant of `ensureImageFill`. The single-slot API above
 * keys one image fill per container — fine for shapes that have a
 * single fill, wrong for tables where each cell can carry its own
 * `ImageFillStyle`. The keyed API stores slots in a Map<slotKey, ...>
 * so a table container can hold one resolved texture per cell without
 * the slots clobbering each other.
 *
 * Callers are responsible for invoking `releaseImageFillKeyed` (or
 * `releaseAllImageFillsKeyed` on destroy) so the refcounts stay
 * balanced. Mixing the two APIs on the same container is safe; they
 * use disjoint storage tags.
 */
const SLOTS_TAG = Symbol('imageFillSlotsByKey')

function getSlotsMap(container: Container): Map<string, FillSlot> | undefined {
  return asAny(container)[SLOTS_TAG] as Map<string, FillSlot> | undefined
}

function ensureSlotsMap(container: Container): Map<string, FillSlot> {
  let map = getSlotsMap(container)
  if (map === undefined) {
    map = new Map()
    asAny(container)[SLOTS_TAG] = map
  }
  return map
}

export function ensureImageFillKeyed(
  container: Container,
  slotKey: string,
  fill: ImageFillStyle | undefined,
  onReady: () => void,
): Texture | null {
  const rm = getDefaultResourceManager()

  if (fill === undefined || fill.assetId === '') {
    releaseImageFillKeyed(container, slotKey)
    return null
  }

  const variant = 'display' as const
  const slots = getSlotsMap(container)
  const current = slots?.get(slotKey)

  // Same assetId in this slot — return whatever texture (or null) we
  // have. Refcount stays as-is.
  if (current !== undefined && current.assetId === fill.assetId) {
    if (current.texture !== undefined) return current.texture
    return null
  }

  // New / changed assetId — release the previous slot's texture ref.
  if (current !== undefined && current.url !== undefined) {
    rm.releaseTexture(current.url)
  }

  const slot: FillSlot = { assetId: fill.assetId, variant, loading: true }
  ensureSlotsMap(container).set(slotKey, slot)

  const resolver = getDefaultImageUrlResolver()
  void (async () => {
    try {
      const url = await resolver({ assetId: fill.assetId, variant })
      const active = getSlotsMap(container)?.get(slotKey)
      if (active !== slot) return
      const texture = await rm.acquireTexture(url, { priority: { node: container } })
      const stillActive = getSlotsMap(container)?.get(slotKey)
      if (stillActive !== slot) {
        rm.releaseTexture(url)
        return
      }
      slot.url = url
      slot.texture = texture
      slot.loading = false
      onReady()
    } catch {
      const stillActive = getSlotsMap(container)?.get(slotKey)
      if (stillActive === slot) slot.loading = false
    }
  })()

  return null
}

export function releaseImageFillKeyed(container: Container, slotKey: string): void {
  const slots = getSlotsMap(container)
  if (slots === undefined) return
  const slot = slots.get(slotKey)
  if (slot === undefined) return
  if (slot.url !== undefined) {
    getDefaultResourceManager().releaseTexture(slot.url)
  }
  slots.delete(slotKey)
  if (slots.size === 0) delete asAny(container)[SLOTS_TAG]
}

/**
 * Snapshot the slot keys currently allocated on this container. Used
 * by the table renderer to sweep abandoned slots after a row / column
 * delete without exposing the Symbol-tagged storage.
 */
export function getImageFillSlotKeys(container: Container): string[] {
  const slots = getSlotsMap(container)
  return slots === undefined ? [] : [...slots.keys()]
}

/** Release every keyed image-fill slot the container holds. */
export function releaseAllImageFillsKeyed(container: Container): void {
  const slots = getSlotsMap(container)
  if (slots === undefined) return
  const rm = getDefaultResourceManager()
  for (const slot of slots.values()) {
    if (slot.url !== undefined) rm.releaseTexture(slot.url)
  }
  delete asAny(container)[SLOTS_TAG]
}
