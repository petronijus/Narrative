/**
 * shared/imageVariants.ts — the size variants imgproxy serves of a picture
 * (apps/server/src/media/imgproxyUrl.ts signs them) and how a screen picks
 * one (docs/plans/performance.md → L3).
 *
 *   thumb    400 × 225, cover-cropped   deck-grid and component tiles
 *   preview  fits 600 × 600             slide-panel thumbnails
 *   medium   fits 1280 × 1280           a picture drawn at ≤ 1280 device px
 *   display  fits 2560 × 2560           larger, HiDPI, zoomed in
 *   original as uploaded
 *
 * Every `fit` is a ceiling, never a target: imgproxy does not enlarge, so a
 * source smaller than a cap is served at its own size and `medium` and
 * `display` of a picture up to 1280 px are the same pixels.
 *
 * The batched URL route (`GET /api/media/urls`) answers a page's whole set of
 * pictures in one request; its limits and its answer are here so the server
 * and the web client read the same ones.
 */

export const IMAGE_VARIANTS = ['thumb', 'preview', 'medium', 'display', 'original'] as const
export type ImageVariant = (typeof IMAGE_VARIANTS)[number]

export function isImageVariant(v: string): v is ImageVariant {
  return (IMAGE_VARIANTS as readonly string[]).includes(v)
}

/** The long-side cap of each aspect-preserving variant, px. */
export const IMAGE_VARIANT_LONG_SIDE = { preview: 600, medium: 1280, display: 2560 } as const

/** The variants a canvas draws a picture from, smallest first. */
export const SCREEN_IMAGE_VARIANTS = ['medium', 'display'] as const
export type ScreenImageVariant = (typeof SCREEN_IMAGE_VARIANTS)[number]

/**
 * Order of the variants by the pixels they hold (thumb < preview < medium <
 * display < original): an upgrade only ever goes up this list.
 */
export function imageVariantRank(v: ImageVariant): number {
  return IMAGE_VARIANTS.indexOf(v)
}

/**
 * The screen variant a picture is drawn from: the smallest that still has a
 * texel for every device pixel it covers, so the GPU never enlarges it —
 * `drawnLongSide` is the picture's long side on the canvas, in slide units,
 * and `density` the canvas's device pixels per slide unit. When even
 * `display` falls short (a big picture zoomed far in) it is `display`, the
 * most there is. A source whose size is unknown gets `display`, as before
 * there was a choice; a source of at most 1280 px gets `medium` (the same
 * pixels as `display`, one URL for both).
 */
export function screenImageVariant(args: {
  drawnLongSide: number
  density: number
  /** The source's long side, px; null or 0 when unknown. */
  sourceLongSide: number | null
}): ScreenImageVariant {
  const source = args.sourceLongSide
  if (source === null || !(source > 0)) return 'display'
  if (source <= IMAGE_VARIANT_LONG_SIDE.medium) return 'medium'
  const needed = args.drawnLongSide * args.density
  // A float hair below the cap still fits: 1280 px drawn at 1280.0000001.
  return IMAGE_VARIANT_LONG_SIDE.medium + 1e-6 >= needed ? 'medium' : 'display'
}

/** At most this many assets per `GET /api/media/urls`. */
export const MEDIA_URLS_MAX_IDS = 100

/** One asset of a `GET /api/media/urls` answer. */
export interface MediaUrlsAsset {
  /** A signed URL of each variant asked for. */
  urls: Partial<Record<ImageVariant, string>>
  /** The source's pixel size; null when it was never probed. */
  width: number | null
  height: number | null
}

/** The answer of `GET /api/media/urls?ids=…&variants=…`. */
export interface MediaUrlsResponse {
  assets: Record<string, MediaUrlsAsset>
  /** Ids asked for that the caller cannot have: unknown, or not theirs to read (the two are not told apart). */
  unavailable: string[]
}
