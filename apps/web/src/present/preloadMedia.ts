/**
 * present/preloadMedia.ts — every picture and video of the deck fetched
 * before the presentation starts (docs/plans/performance.md → D, P1).
 *
 * Pictures — image objects, image backgrounds, image fills — are resolved
 * through the renderer's own URL resolver, all in one batched request (so the
 * slides mounted later find the signed URL cached and ask the API nothing).
 * Each picture is fetched once, in the variant every slide will draw it
 * from: the largest its uses need at the present canvas's density
 * (performance.md → L3; `picturesToFetch`) — the slide cache mounts with the
 * same choice. They are fetched the way Pixi's
 * texture loader fetches them (`fetch(url)`, the page's defaults), which
 * leaves each response in the HTTP cache for the loader: imgproxy's signed
 * URLs are immutable and served with a long max-age. Decoding happens when
 * the slide is prepared (renderer/presentSlides.ts: the ResourceManager
 * decodes and the warm-up uploads); a deck too big for the GPU budget has
 * the slides beyond its window fetched but not decoded until they come near.
 *
 * Videos are buffered on their first frame by the video pool
 * (renderer/presentVideos.ts).
 *
 * The IndexedDB copy the old preload wrote was never read, and could not be
 * used by the texture loader under the production CSP (its worker would
 * fetch a blob: URL, which `connect-src` does not allow): it is gone.
 */

import { imageVariantRank, type ImageVariant, type Slide } from '@narrative/shared'
import { deckPictures } from '../renderer/deckPictures.js'
import {
  cappedImageVariant,
  getDefaultImageUrlResolver,
  type ImageUrlResolver,
  type ResolvedImageAsset,
} from '../renderer/imageUrl.js'
import {
  imageObjectVariant,
  morphingSlides,
  pinnedVariant,
  scaledUpObjectIds,
} from '../renderer/imageVariant.js'
import { PresentVideoPool } from '../renderer/presentVideos.js'

export interface MediaPreloadProgress {
  total: number
  completed: number
  errored: number
}

/** What the preload fetched, and what the slides are to be drawn from. */
export interface MediaPreloadResult extends MediaPreloadProgress {
  /**
   * The variant each picture is drawn from on every slide of the deck: the
   * largest any of its uses needs at the canvas's density (an image object's
   * by its size, imageVariant.ts; a background or a fill `display`). The
   * slide cache mounts with it (PresentSlideCache.setVariantFloor), so a
   * picture is one texture however many slides show it, at whatever size.
   */
  variants: Map<string, ImageVariant>
}

/**
 * The (asset, variant) pairs to fetch for `slides` on a canvas of `density`:
 * one per picture — the largest variant its uses need, for the source either
 * way up, `display` where a build or a Magic Move draws it larger than at
 * rest — plus a variant an object pins (`thumb`, `original`). `sizes` are the
 * assets' source sizes. Nothing a prepared slide draws is left to fetch after
 * ready (ADR 0016).
 */
export function picturesToFetch(
  slides: readonly Slide[],
  density: number | null,
  sizes: ReadonlyMap<string, ResolvedImageAsset>,
): {
  fetch: Array<{ assetId: string; variant: ImageVariant }>
  variants: Map<string, ImageVariant>
} {
  const variants = new Map<string, ImageVariant>()
  const pinned = new Set<string>()
  const pins: Array<{ assetId: string; variant: ImageVariant }> = []
  const raise = (assetId: string, variant: ImageVariant): void => {
    const now = variants.get(assetId)
    if (now === undefined || imageVariantRank(variant) > imageVariantRank(now))
      variants.set(assetId, variant)
  }
  // Magic Move morphs pictures between the slides it joins, in the order
  // they are presented (skipped slides are passed over).
  const presented = slides.filter((sl) => sl.skipped !== true)
  const morphing = new Set([...morphingSlides(presented)].map((i) => presented[i]!))
  for (const slide of slides) {
    const scaledUp = scaledUpObjectIds(slide)
    const atRestOnly = !morphing.has(slide)
    for (const p of deckPictures([slide])) {
      if (p.kind !== 'object') {
        raise(p.assetId, 'display')
        continue
      }
      const pin = pinnedVariant(p.object)
      if (pin !== null) {
        if (!pinned.has(`${p.assetId}:${pin}`)) {
          pinned.add(`${p.assetId}:${pin}`)
          pins.push({ assetId: p.assetId, variant: pin })
        }
        continue
      }
      if (!atRestOnly || scaledUp.has(p.object.id)) {
        // Drawn larger than at rest for a while: display, as before L3.
        raise(p.assetId, 'display')
        continue
      }
      // The asset row's size is the file's; an EXIF-turned photo is served
      // turned, and the renderer corrects to the texture's aspect after the
      // load — sized here for both, so it never wants more than was fetched.
      const size = sizes.get(p.assetId) ?? null
      raise(p.assetId, imageObjectVariant(p.object, size, density))
      if (size !== null)
        raise(
          p.assetId,
          imageObjectVariant(p.object, { width: size.height, height: size.width }, density),
        )
    }
  }
  const fetch = [...variants].map(([assetId, variant]) => ({ assetId, variant }))
  for (const pin of pins)
    if (!fetch.some((f) => f.assetId === pin.assetId && f.variant === pin.variant)) fetch.push(pin)
  return { fetch, variants }
}

/** Run `tasks` at most `limit` at a time. */
async function inParallel(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < tasks.length) await tasks[next++]!()
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, lane))
}

/**
 * Fetch every picture of `slides` and buffer every video in `videos`;
 * resolves when all are done (a failure counts as done: its object shows
 * its error mark, as in the editor). `onProgress` after each item.
 */
export async function preloadDeckMedia(
  slides: readonly Slide[],
  opts: {
    videos: PresentVideoPool
    /** The present canvas's device pixels per slide unit (SceneGraph.getPixelDensity). */
    density: number | null
    onProgress?: (p: MediaPreloadProgress) => void
    signal?: AbortSignal
  },
): Promise<MediaPreloadResult> {
  const videos = PresentVideoPool.videosOf(slides)
  let resolver: ImageUrlResolver | null = null
  try {
    resolver = getDefaultImageUrlResolver()
  } catch {
    resolver = null
  }
  const aborted = (): boolean => opts.signal?.aborted === true

  // The pictures' URLs and sizes, in one batched request (a hundred a request).
  const ids = [...new Set(deckPictures(slides).map((p) => p.assetId))]
  const sizes = new Map<string, ResolvedImageAsset>()
  if (resolver !== null) {
    await resolver.prefetch(ids)
    await Promise.all(
      ids.map((id) =>
        resolver!.asset(id).then(
          (a) => void sizes.set(id, a),
          () => undefined,
        ),
      ),
    )
  }
  const { fetch: pictures, variants } = picturesToFetch(slides, opts.density, sizes)

  const progress: MediaPreloadProgress = {
    total: pictures.length + videos.length,
    completed: 0,
    errored: 0,
  }
  opts.onProgress?.({ ...progress })
  const report = (ok: boolean): void => {
    if (ok) progress.completed++
    else progress.errored++
    opts.onProgress?.({ ...progress })
  }
  const fetchPicture = async (p: { assetId: string; variant: ImageVariant }): Promise<void> => {
    if (aborted()) return
    try {
      if (resolver === null) throw new Error('no image URL resolver installed')
      const url = await resolver({ assetId: p.assetId, variant: cappedImageVariant(p.variant) })
      const res = await fetch(url, opts.signal !== undefined ? { signal: opts.signal } : {})
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await res.arrayBuffer()
      report(true)
    } catch (err) {
      if (aborted()) return
      console.warn('[preloadMedia] could not fetch a picture', p.assetId, err)
      report(false)
    }
  }
  let videosDone = 0
  await Promise.all([
    inParallel(
      pictures.map((p) => () => fetchPicture(p)),
      6,
    ),
    opts.videos.prepare(videos, (done) => {
      while (videosDone < done) {
        videosDone++
        report(true)
      }
    }),
  ])
  return { ...progress, variants }
}
