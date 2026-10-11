/**
 * renderer/imageUrl.ts
 *
 * Signed imgproxy URL resolver for ImageObject rendering.
 *
 * Design:
 * - Framework-agnostic (no React, no Vite env reads). Pure TS.
 * - In-memory cache keyed by `${assetId}:${variant}`. Entries are Promises
 *   so concurrent callers for the same key share one in-flight fetch.
 * - On fetch error the cache entry is removed so the next call retries.
 * - A module-level default resolver is installed at app bootstrap time via
 *   setDefaultImageUrlResolver(). Renderer code calls getDefaultImageUrlResolver().
 *
 * Bootstrap (Canvas.tsx / App.tsx):
 *   setDefaultImageUrlResolver(createImageUrlResolver(API_BASE))
 *
 * Auth: this module fetches `${api}/media/:id/url` with `credentials: 'include'`,
 * so the narrative_session cookie travels automatically on same-origin (prod)
 * and same-site cross-origin (dev). No Bearer token needed any more.
 */

import { withShareToken } from '../lib/shareToken.js'
import { trackRenderWork } from './renderWork.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolveImageUrlOpts {
  assetId: string
  /** Defaults to 'display'. */
  variant?: 'thumb' | 'preview' | 'display' | 'original'
}

/**
 * Returns a signed imgproxy URL for the given assetId + variant.
 * Cached per (assetId, variant) key for the lifetime of the resolver instance.
 */
export type ImageUrlResolver = (opts: ResolveImageUrlOpts) => Promise<string>

type Variant = NonNullable<ResolveImageUrlOpts['variant']>
const VARIANT_SIZE: Record<Variant, number> = { thumb: 0, preview: 1, display: 2, original: 3 }

let variantCap: Variant | null = null

/**
 * Serve no image larger than `cap` until reset (null): the render page sets
 * 'preview' (600 px) while it draws a contact sheet, whose tiles are at most
 * ~700 px wide — loading, decoding and keeping 2560-px pictures for them is
 * what made a sheet of a photo-heavy deck slow and memory-hungry on the
 * render worker. Pictures already loaded stay as they are.
 */
export function setImageVariantCap(cap: Variant | null): void {
  variantCap = cap
}

function capped(variant: Variant): Variant {
  return variantCap !== null && VARIANT_SIZE[variant] > VARIANT_SIZE[variantCap]
    ? variantCap
    : variant
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds an ImageUrlResolver bound to a given API base URL.
 *
 * @param apiBaseUrl  Base URL without trailing slash, e.g. 'https://api.example.com'.
 *                    Pass '' to use relative paths (same-origin).
 */
export function createImageUrlResolver(apiBaseUrl: string): ImageUrlResolver {
  // Cache: key → Promise<url>
  // Promise caching means concurrent callers for same key share one in-flight fetch.
  const cache = new Map<string, Promise<string>>()

  return function resolveImageUrl(opts: ResolveImageUrlOpts): Promise<string> {
    const variant = capped(opts.variant ?? 'display')
    const cacheKey = `${opts.assetId}:${variant}`

    const cached = cache.get(cacheKey)
    if (cached !== undefined) {
      return cached
    }

    // Counted until it settles, so the render page waits for it (renderWork.ts).
    const fetchPromise: Promise<string> = trackRenderWork(
      (async () => {
        // A share-link visit (or the render page) has no session: its token authorises.
        const url = withShareToken(`${apiBaseUrl}/api/media/${opts.assetId}/url?variant=${variant}`)
        const res = await fetch(url, { credentials: 'include' })

        if (!res.ok) {
          // Remove from cache to allow retry.
          cache.delete(cacheKey)
          throw new Error(
            `[imageUrl] Failed to fetch signed URL for ${opts.assetId}/${variant}: HTTP ${res.status}`,
          )
        }

        const json = (await res.json()) as { url?: string }

        if (typeof json.url !== 'string') {
          cache.delete(cacheKey)
          throw new Error(
            `[imageUrl] Invalid response for ${opts.assetId}/${variant}: missing 'url' field`,
          )
        }

        return json.url
      })(),
    )

    // On rejection remove cache entry so caller can retry.
    fetchPromise.catch(() => {
      cache.delete(cacheKey)
    })

    cache.set(cacheKey, fetchPromise)
    return fetchPromise
  }
}

// ---------------------------------------------------------------------------
// Module-level default resolver (installed at app bootstrap)
// ---------------------------------------------------------------------------

let defaultResolver: ImageUrlResolver | null = null

/**
 * Install the default ImageUrlResolver.
 * Must be called before any imageRenderer is mounted.
 * Typically called in Canvas.tsx / App.tsx useEffect on mount.
 */
export function setDefaultImageUrlResolver(resolver: ImageUrlResolver): void {
  defaultResolver = resolver
}

/**
 * Returns the installed default resolver.
 * Throws if setDefaultImageUrlResolver() was not called yet.
 */
export function getDefaultImageUrlResolver(): ImageUrlResolver {
  if (defaultResolver === null) {
    throw new Error(
      '[imageUrl] No default resolver installed — call setDefaultImageUrlResolver() first',
    )
  }
  return defaultResolver
}

/**
 * Reset the default resolver (for testing).
 * @internal
 */
export function _resetDefaultImageUrlResolver(): void {
  defaultResolver = null
}
