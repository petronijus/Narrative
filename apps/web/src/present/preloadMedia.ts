/**
 * present/preloadMedia.ts — every picture and video of the deck fetched
 * before the presentation starts (docs/plans/performance.md → D, P1).
 *
 * Pictures — image objects, image backgrounds, image fills — are resolved
 * through the renderer's own URL resolver (so the slides mounted later find
 * the signed URL cached and ask the API nothing) and fetched the way Pixi's
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

import type { Slide, SlideObject } from '@narrative/shared'
import { getDefaultImageUrlResolver, type ImageUrlResolver } from '../renderer/imageUrl.js'
import { PresentVideoPool } from '../renderer/presentVideos.js'

export interface MediaPreloadProgress {
  total: number
  completed: number
  errored: number
}

type Variant = NonNullable<Parameters<ImageUrlResolver>[0]['variant']>

/** Every picture the slides draw: (asset, variant) pairs, once each. */
export function picturesOf(slides: readonly Slide[]): Array<{ assetId: string; variant: Variant }> {
  const seen = new Set<string>()
  const out: Array<{ assetId: string; variant: Variant }> = []
  const add = (assetId: unknown, variant: Variant): void => {
    if (typeof assetId !== 'string' || assetId === '') return
    const key = `${assetId}:${variant}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ assetId, variant })
  }
  const visit = (o: SlideObject): void => {
    if (o.type === 'image') add(o.assetId, o.variant ?? 'display')
    const fill = (o as { fill?: unknown }).fill
    if (typeof fill === 'object' && fill !== null && (fill as { kind?: unknown }).kind === 'image')
      add((fill as { assetId?: unknown }).assetId, 'display')
  }
  for (const s of slides) {
    if (s.background?.kind === 'image') add(s.background.assetId, 'display')
    for (const o of s.objects) visit(o)
  }
  return out
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
    onProgress?: (p: MediaPreloadProgress) => void
    signal?: AbortSignal
  },
): Promise<MediaPreloadProgress> {
  const pictures = picturesOf(slides)
  const videos = PresentVideoPool.videosOf(slides)
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
  let resolver: ImageUrlResolver | null = null
  try {
    resolver = getDefaultImageUrlResolver()
  } catch {
    resolver = null
  }
  const aborted = (): boolean => opts.signal?.aborted === true
  const fetchPicture = async (p: { assetId: string; variant: Variant }): Promise<void> => {
    if (aborted()) return
    try {
      if (resolver === null) throw new Error('no image URL resolver installed')
      const url = await resolver(p)
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
  return { ...progress }
}
