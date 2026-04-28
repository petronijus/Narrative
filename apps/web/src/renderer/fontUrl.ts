/**
 * renderer/fontUrl.ts
 *
 * P15: resolves a font asset id to its raw TTF/OTF URL plus the
 * server-parsed metadata (family, weight, style). Mirrors the
 * imageUrl resolver pattern — module-level default + in-memory
 * cache + Promise sharing for concurrent callers.
 *
 * Bootstrap (Canvas.tsx):
 *   setDefaultFontUrlResolver(createFontUrlResolver(apiUrl, () => token))
 */

export interface FontUrlInfo {
  url: string
  family: string
  weight: number
  style: 'normal' | 'italic'
  postscriptName: string
}

export interface ResolveFontUrlOpts {
  assetId: string
  getAuthToken?: () => string | null
}

export type FontUrlResolver = (opts: ResolveFontUrlOpts) => Promise<FontUrlInfo>

/**
 * Builds a FontUrlResolver bound to a given API base URL.
 */
export function createFontUrlResolver(
  apiBaseUrl: string,
  getAuthToken?: () => string | null,
): FontUrlResolver {
  // Promise cache so two TextObjects mounted in the same tick don't
  // each fire a request for the same asset.
  const cache = new Map<string, Promise<FontUrlInfo>>()

  return function resolveFontUrl(opts: ResolveFontUrlOpts): Promise<FontUrlInfo> {
    const cacheKey = opts.assetId
    const cached = cache.get(cacheKey)
    if (cached !== undefined) return cached

    const tokenGetter = opts.getAuthToken ?? getAuthToken

    const fetchPromise: Promise<FontUrlInfo> = (async () => {
      const url = `${apiBaseUrl}/api/media/${opts.assetId}/font-url`

      const headers: Record<string, string> = {}
      const token = tokenGetter?.()
      if (token != null && token !== '') {
        headers['Authorization'] = `Bearer ${token}`
      }

      const res = await fetch(url, { headers })

      if (!res.ok) {
        cache.delete(cacheKey)
        throw new Error(
          `[fontUrl] Failed to fetch font URL for ${opts.assetId}: HTTP ${res.status}`,
        )
      }

      const json = (await res.json()) as Partial<FontUrlInfo>

      if (
        typeof json.url !== 'string' ||
        typeof json.family !== 'string' ||
        typeof json.weight !== 'number' ||
        (json.style !== 'normal' && json.style !== 'italic') ||
        typeof json.postscriptName !== 'string'
      ) {
        cache.delete(cacheKey)
        throw new Error(`[fontUrl] Invalid response for ${opts.assetId}`)
      }

      return {
        url: json.url,
        family: json.family,
        weight: json.weight,
        style: json.style,
        postscriptName: json.postscriptName,
      }
    })()

    fetchPromise.catch(() => {
      cache.delete(cacheKey)
    })

    cache.set(cacheKey, fetchPromise)
    return fetchPromise
  }
}

// ---------------------------------------------------------------------------
// Module-level default resolver
// ---------------------------------------------------------------------------

let defaultResolver: FontUrlResolver | null = null

export function setDefaultFontUrlResolver(resolver: FontUrlResolver): void {
  defaultResolver = resolver
}

export function getDefaultFontUrlResolver(): FontUrlResolver {
  if (defaultResolver === null) {
    throw new Error(
      '[fontUrl] No default resolver installed — call setDefaultFontUrlResolver() first',
    )
  }
  return defaultResolver
}

/** @internal */
export function _resetDefaultFontUrlResolver(): void {
  defaultResolver = null
}
