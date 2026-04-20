/**
 * renderer/videoInfo.ts
 *
 * Video info resolver — fetches /api/media/:assetId/video-info and caches results.
 *
 * Cache strategy:
 * - 'done' and 'failed' statuses are cached indefinitely (terminal states).
 * - 'pending' and 'processing' statuses are cached for VIDEO_INFO_PENDING_TTL_MS (5s).
 *   After that, the next call re-fetches so the renderer can poll until transcode completes.
 *
 * Trade-off: polling inside the renderer is simple but not architecturally ideal.
 * A cleaner solution would be for editor-ui to push a Yjs update when the transcode
 * completes, triggering a re-render without the renderer needing to poll. Deferred to a
 * follow-up milestone (Yjs-driven refresh).
 *
 * Bootstrap (Canvas.tsx):
 *   setDefaultVideoInfoResolver(createVideoInfoResolver(import.meta.env.VITE_API_URL, () => token))
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoInfoResult {
  assetId: string
  transcodeStatus: 'pending' | 'processing' | 'done' | 'failed'
  durationSec: number | null
  width: number | null
  height: number | null
  posterUrl: string | null
  thumbnailUrl: string | null
  hlsManifestUrl: string | null
  transcodeError: string | null
}

export type VideoInfoResolver = (opts: { assetId: string }) => Promise<VideoInfoResult>

// ---------------------------------------------------------------------------
// TTL for non-terminal states
// ---------------------------------------------------------------------------

/** How long (ms) to cache pending/processing responses before allowing a re-fetch. */
const VIDEO_INFO_PENDING_TTL_MS = 5_000

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds a VideoInfoResolver bound to a given API base URL.
 *
 * @param apiBaseUrl  Base URL without trailing slash. Pass '' for same-origin.
 * @param getAuthToken  Optional getter for the current JWT access token.
 */
export function createVideoInfoResolver(
  apiBaseUrl: string,
  getAuthToken?: () => string | null,
): VideoInfoResolver {
  interface CacheEntry {
    promise: Promise<VideoInfoResult>
    /** Timestamp (Date.now()) when this entry was created. Undefined = permanent (done/failed). */
    expiresAt: number | undefined
  }

  const cache = new Map<string, CacheEntry>()

  return function resolveVideoInfo(opts: { assetId: string }): Promise<VideoInfoResult> {
    const cacheKey = opts.assetId
    const existing = cache.get(cacheKey)

    if (existing !== undefined) {
      // For permanent entries (done/failed) always return cached result.
      if (existing.expiresAt === undefined) {
        return existing.promise
      }
      // For TTL entries (pending/processing) return while still fresh.
      if (Date.now() < existing.expiresAt) {
        return existing.promise
      }
      // Stale — remove and re-fetch.
      cache.delete(cacheKey)
    }

    const fetchPromise: Promise<VideoInfoResult> = (async () => {
      const url = `${apiBaseUrl}/api/media/${opts.assetId}/video-info`

      const headers: Record<string, string> = {}
      const token = getAuthToken?.()
      if (token != null && token !== '') {
        headers['Authorization'] = `Bearer ${token}`
      }

      const res = await fetch(url, { headers })

      if (!res.ok) {
        cache.delete(cacheKey)
        throw new Error(
          `[videoInfo] Failed to fetch video info for ${opts.assetId}: HTTP ${res.status}`,
        )
      }

      const json = (await res.json()) as Partial<VideoInfoResult>

      if (typeof json.assetId !== 'string' || typeof json.transcodeStatus !== 'string') {
        cache.delete(cacheKey)
        throw new Error(`[videoInfo] Invalid response for ${opts.assetId}: missing required fields`)
      }

      const result: VideoInfoResult = {
        assetId: json.assetId,
        transcodeStatus: json.transcodeStatus as VideoInfoResult['transcodeStatus'],
        durationSec: json.durationSec ?? null,
        width: json.width ?? null,
        height: json.height ?? null,
        posterUrl: json.posterUrl ?? null,
        thumbnailUrl: json.thumbnailUrl ?? null,
        hlsManifestUrl: json.hlsManifestUrl ?? null,
        transcodeError: json.transcodeError ?? null,
      }

      // Upgrade cache entry to permanent for terminal states.
      const status = result.transcodeStatus
      if (status === 'done' || status === 'failed') {
        // Replace TTL entry with permanent entry now that we have the result.
        cache.set(cacheKey, { promise: Promise.resolve(result), expiresAt: undefined })
      }

      return result
    })()

    // On rejection clear cache so caller can retry.
    fetchPromise.catch(() => {
      cache.delete(cacheKey)
    })

    // Store with TTL — will be promoted to permanent after resolve if done/failed.
    cache.set(cacheKey, {
      promise: fetchPromise,
      expiresAt: Date.now() + VIDEO_INFO_PENDING_TTL_MS,
    })
    return fetchPromise
  }
}

// ---------------------------------------------------------------------------
// Module-level default resolver (installed at app bootstrap)
// ---------------------------------------------------------------------------

let defaultResolver: VideoInfoResolver | null = null

/**
 * Install the default VideoInfoResolver.
 * Must be called before any videoRenderer is mounted.
 * Typically called in Canvas.tsx alongside setDefaultImageUrlResolver.
 */
export function setDefaultVideoInfoResolver(resolver: VideoInfoResolver): void {
  defaultResolver = resolver
}

/**
 * Returns the installed default resolver.
 * Throws if setDefaultVideoInfoResolver() was not called yet.
 */
export function getDefaultVideoInfoResolver(): VideoInfoResolver {
  if (defaultResolver === null) {
    throw new Error(
      '[videoInfo] No default resolver installed — call setDefaultVideoInfoResolver() first',
    )
  }
  return defaultResolver
}

/**
 * Reset the default resolver (for testing).
 * @internal
 */
export function _resetDefaultVideoInfoResolver(): void {
  defaultResolver = null
}
