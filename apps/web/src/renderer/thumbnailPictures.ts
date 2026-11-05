/**
 * renderer/thumbnailPictures.ts — the pictures (image objects, image
 * backgrounds, video posters) of the offscreen thumbnail renderer, decoded
 * and uploaded once per renderer instead of once per thumbnail
 * (performance.md → F10).
 *
 * The thumbnail renderer draws on a WebGL context of its own, so the editor's
 * ResourceManager cannot lend it textures; until F10 every thumbnail made its
 * own: an `Image` per picture, a decode, a `Texture.from` and an upload with
 * its mipmaps — a 100-slide deck of six photos fetched each photo ~28 times,
 * decoded and uploaded ~33 times, and an image background's texture was
 * never freed at all. Here a picture is loaded once, shared by every
 * thumbnail that draws it (refcounted), and kept for a while after the last
 * one let go (LRU, bounded by pixels): the next slide using the same photo
 * draws at once.
 *
 * The thumbnail renderer owns the cache and destroys it with its Pixi app
 * (the textures die with that context). Object renderers do not know about it:
 * they ask `currentThumbnailPictures()` while they are mounted for a
 * thumbnail (`withThumbnailPictures`, synchronous like the mount) and keep
 * what it returned for their asynchronous load and their destroy.
 */

import { Texture } from 'pixi.js'

export interface ThumbnailPictures {
  /**
   * The texture of the picture at `url`; every acquire is paired with one
   * `release(url)`, also when the promise rejects or the caller no longer
   * wants the texture.
   */
  acquire(url: string): Promise<Texture>
  release(url: string): void
  /** Free every texture (the renderer is gone). Later acquires reject. */
  destroy(): void
  /** Pictures held: in use and kept (unit tests, diagnostics). */
  readonly size: number
}

export interface ThumbnailPicturesOptions {
  /** Device pixels of pictures kept after no thumbnail draws them. */
  keepUnusedPx?: number
  /** Loads a picture (tests); default: decode an `<img>`, `Texture.from`. */
  load?: (url: string) => Promise<Texture>
}

/**
 * 8 Mpx of unused pictures (~43 MB of GPU memory with mipmaps): two dozen
 * `preview` variants (600 px on the long side), the photos a deck reuses.
 */
const KEEP_UNUSED_PX = 8_000_000

async function loadPicture(url: string): Promise<Texture> {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = url
  await img.decode()
  return Texture.from(img)
}

interface Entry {
  refs: number
  promise: Promise<Texture>
  /** Set once loaded. */
  texture: Texture | null
  /** Device pixels, once loaded. */
  px: number
}

export function createThumbnailPictures(opts: ThumbnailPicturesOptions = {}): ThumbnailPictures {
  const keepUnusedPx = opts.keepUnusedPx ?? KEEP_UNUSED_PX
  const load = opts.load ?? loadPicture
  const entries = new Map<string, Entry>()
  /** Loaded pictures nobody draws, oldest first. */
  const unused = new Set<string>()
  let unusedPx = 0
  let destroyed = false

  const free = (texture: Texture): void => {
    if (texture.destroyed) return
    try {
      texture.destroy(true)
    } catch {
      // The context may be gone already.
    }
  }

  const drop = (url: string): void => {
    const entry = entries.get(url)
    if (entry === undefined) return
    entries.delete(url)
    if (unused.delete(url)) unusedPx -= entry.px
    if (entry.texture !== null) free(entry.texture)
  }

  const trim = (): void => {
    for (const url of unused) {
      if (unusedPx <= keepUnusedPx) return
      drop(url)
    }
  }

  return {
    acquire(url) {
      if (destroyed) return Promise.reject(new Error('the thumbnail pictures are gone'))
      let entry = entries.get(url)
      if (entry === undefined) {
        const created: Entry = {
          refs: 0,
          promise: Promise.resolve(Texture.EMPTY),
          texture: null,
          px: 0,
        }
        created.promise = load(url).then(
          (texture) => {
            if (destroyed || entries.get(url) !== created) {
              free(texture)
              throw new Error('the thumbnail pictures are gone')
            }
            created.texture = texture
            created.px = Math.max(1, texture.source.pixelWidth * texture.source.pixelHeight)
            if (created.refs === 0) {
              unused.add(url)
              unusedPx += created.px
              trim()
            }
            return texture
          },
          (err: unknown) => {
            // Not kept: the next acquire tries again.
            if (entries.get(url) === created) entries.delete(url)
            throw err
          },
        )
        entries.set(url, created)
        entry = created
      } else if (unused.delete(url)) {
        unusedPx -= entry.px
      }
      entry.refs += 1
      return entry.promise
    },

    release(url) {
      const entry = entries.get(url)
      if (entry === undefined || entry.refs === 0) return
      entry.refs -= 1
      if (entry.refs > 0 || entry.texture === null) return
      unused.add(url)
      unusedPx += entry.px
      trim()
    },

    destroy() {
      if (destroyed) return
      destroyed = true
      for (const url of [...entries.keys()]) drop(url)
    },

    get size() {
      return entries.size
    },
  }
}

let current: ThumbnailPictures | null = null

/** Run a thumbnail mount with `pictures` as the pictures object renderers ask for. */
export function withThumbnailPictures<T>(pictures: ThumbnailPictures, mount: () => T): T {
  const previous = current
  current = pictures
  try {
    return mount()
  } finally {
    current = previous
  }
}

/** The thumbnail renderer's pictures while it mounts, null otherwise. */
export function currentThumbnailPictures(): ThumbnailPictures | null {
  return current
}
