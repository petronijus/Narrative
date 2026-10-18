/**
 * renderer/thumbnailImages.ts — a rendered thumbnail as an object URL.
 *
 * Thumbnails used to be base64 PNG data URLs: the encode ran synchronously on
 * the main thread (`toDataURL` inside Pixi's `extract.base64`), a 100-slide
 * deck held ~100 strings of 20–60 kB in the JS heap and again in the DOM, and
 * every one went through React as a prop. Now the PNG is encoded
 * asynchronously (`toBlob` / `convertToBlob`, off the main thread in
 * Chromium) and the panel's `<img>` points at an object URL of the blob
 * (`img-src blob:` is in the production CSP, ADR 0007).
 *
 * The few places that need the picture as text — the deck preview kept in
 * localStorage and uploaded as JSON, the component master's preview — ask
 * `thumbnailDataUrl(url)`, which reads the blob registered here. (A `fetch`
 * of the `blob:` URL would be blocked by `connect-src`.)
 *
 * Every URL made here is revoked by whoever made it (the thumbnail store,
 * when no slide shows the picture any more and it has left its cache).
 */

const blobs = new Map<string, Blob>()

/** An object URL for `blob`, registered so its data URL can be read back. */
export function createThumbnailUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob)
  blobs.set(url, blob)
  return url
}

/** Revoke a URL made by createThumbnailUrl. */
export function revokeThumbnailUrl(url: string): void {
  if (!blobs.delete(url)) return
  URL.revokeObjectURL(url)
}

/** The blob behind a thumbnail URL (undefined once revoked, or for any other URL). */
export function thumbnailBlob(url: string): Blob | undefined {
  return blobs.get(url)
}

/**
 * A thumbnail as a data URL, for storage and uploads. A `data:` URL is
 * returned as it is; a revoked or unknown URL rejects.
 */
export function thumbnailDataUrl(url: string): Promise<string> {
  if (url.startsWith('data:')) return Promise.resolve(url)
  const blob = blobs.get(url)
  if (blob === undefined) return Promise.reject(new Error(`no thumbnail behind ${url}`))
  return blobToDataUrl(blob)
}

/** A blob as a data URL (FileReader: the encode is the browser's, off the main thread). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('the thumbnail could not be read'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('the thumbnail could not be read'))
    reader.readAsDataURL(blob)
  })
}
