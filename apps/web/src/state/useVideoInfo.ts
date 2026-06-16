/**
 * state/useVideoInfo.ts
 *
 * M12: React hook for fetching and polling video transcode status.
 *
 * Polls every 2 s while transcodeStatus is 'pending' or 'processing'.
 * Stops polling automatically on 'done' or 'failed' (terminal states).
 * Returns null until the first result is received.
 *
 * Stable: polling restarts only when assetId changes.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { VideoInfoResponse } from '../api/client.js'
import { useApi } from '../api/client.js'

const POLL_INTERVAL_MS = 2_000

const TERMINAL_STATUSES = new Set<VideoInfoResponse['transcodeStatus']>(['done', 'failed'])

export interface UseVideoInfoResult {
  info: VideoInfoResponse | null
  isLoading: boolean
  error: Error | null
  /**
   * MEDIA-1: force a re-fetch of video-info, yielding a freshly-presigned
   * `playbackUrl`. Call this when the <video> element 403s / stalls because
   * its short-TTL playback URL expired during a long session. Resolves to the
   * new info (or null if the asset is unset / the fetch failed).
   */
  refresh: () => Promise<VideoInfoResponse | null>
}

export function useVideoInfo(assetId: string | null): UseVideoInfoResult {
  const api = useApi()

  const [info, setInfo] = useState<VideoInfoResponse | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [error, setError] = useState<Error | null>(null)

  // Ref to track the latest assetId inside async callbacks — avoids stale closure issues.
  const assetIdRef = useRef<string | null>(assetId)
  assetIdRef.current = assetId

  // MEDIA-1: imperative refresh. Bypasses the resolver cache so the new
  // response carries a freshly-signed playbackUrl, and pushes it into state
  // so the <video src> effect re-runs with the new URL.
  const refresh = useCallback(async (): Promise<VideoInfoResponse | null> => {
    const id = assetIdRef.current
    if (id === null || id === '') return null
    try {
      // api.getVideoInfo always does a live GET (no client-side cache), so
      // the response already carries a freshly-signed playbackUrl.
      const result = await api.getVideoInfo(id)
      // Ignore a stale result if the asset changed mid-flight.
      if (assetIdRef.current !== id) return null
      setInfo(result)
      setError(null)
      return result
    } catch (err) {
      if (assetIdRef.current !== id) return null
      setError(err instanceof Error ? err : new Error(String(err)))
      return null
    }
  }, [api])

  useEffect(() => {
    if (assetId === null) {
      setInfo(null)
      setIsLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    let timerId: ReturnType<typeof setTimeout> | null = null

    async function fetchOnce(): Promise<void> {
      if (cancelled) return
      if (assetIdRef.current === null) return

      try {
        const result = await api.getVideoInfo(assetIdRef.current)
        if (cancelled) return

        setInfo(result)
        setIsLoading(false)
        setError(null)

        if (!TERMINAL_STATUSES.has(result.transcodeStatus)) {
          // Non-terminal — schedule next poll
          timerId = setTimeout(() => {
            void fetchOnce()
          }, POLL_INTERVAL_MS)
        }
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setIsLoading(false)
      }
    }

    setIsLoading(true)
    setInfo(null)
    setError(null)

    void fetchOnce()

    return () => {
      cancelled = true
      if (timerId !== null) {
        clearTimeout(timerId)
      }
    }
  }, [assetId]) // eslint-disable-line react-hooks/exhaustive-deps -- api reference is stable per token

  return { info, isLoading, error, refresh }
}
