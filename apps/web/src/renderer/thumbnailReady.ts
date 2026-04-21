/**
 * renderer/thumbnailReady.ts
 *
 * Shared Symbol + helpers letting `thumbnailMount()` expose an "I'm done
 * loading" promise on the Container it returns.
 *
 * Why this exists:
 *   `thumbnails.ts` renders a single synchronous Pixi frame and immediately
 *   destroys the container. If `thumbnailMount` started an async texture
 *   load (image/video poster raster), the render would capture only the
 *   grey placeholder. By attaching a ready-promise we let the thumbnail
 *   renderer await any pending async work before the snapshot frame.
 */

import type { Container } from 'pixi.js'

const READY_TAG = Symbol('thumbnailReady')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol-keyed metadata on Pixi Container is untyped.
const asAny = (c: Container): any => c

/** Attach a promise that resolves once the container's async content is painted. */
export function setThumbnailReady(container: Container, promise: Promise<void>): void {
  asAny(container)[READY_TAG] = promise
}

/** Returns the ready-promise attached by thumbnailMount, if any. */
export function getThumbnailReady(container: Container): Promise<void> | undefined {
  return asAny(container)[READY_TAG] as Promise<void> | undefined
}
