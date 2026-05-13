/**
 * state/useMediaPreload.ts
 *
 * M12: Hook for preloading all media in a deck before present mode.
 *
 * Flow:
 *   1. Walk all slides' objects. Extract:
 *      - ImageObject: fetch display URL via /api/media/:id/url?variant=display
 *      - VideoObject: fetch /video-info → poster URL + HLS manifest URL
 *   2. For each URL:
 *      - Check IndexedDB cache — if found and not expired, skip
 *      - Fetch URL, store in IndexedDB
 *      - Update progress counter
 *   3. Resolves when all done (errors are non-fatal — increment errored counter).
 *
 * Fail-safe: if preload takes >30 s, present mode should proceed without waiting
 * (implemented by the caller — PresentLayout has its own timeout).
 *
 * Limitations:
 *   - HLS segments are NOT cached — only the master manifest text.
 *     hls.js handles its own segment buffering.
 */

import { useState, useCallback, useRef } from 'react'
import type { Slide } from '@narrative/shared'
import type { ImageObject, VideoObject } from '@narrative/shared'
import { openMediaCache } from './mediaCache.js'
import type { MediaCacheKind } from './mediaCache.js'
import { useApi } from '../api/client.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreloadProgress {
  total: number
  completed: number
  errored: number
  isDone: boolean
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMediaPreload(): {
  start: (slides: Slide[]) => Promise<void>
  progress: PreloadProgress
  isPreloading: boolean
} {
  const api = useApi()

  const [isPreloading, setIsPreloading] = useState(false)
  const [progress, setProgress] = useState<PreloadProgress>({
    total: 0,
    completed: 0,
    errored: 0,
    isDone: false,
  })

  // Guard against concurrent start() calls
  const runningRef = useRef(false)

  const start = useCallback(
    async (slides: Slide[]): Promise<void> => {
      if (runningRef.current) return
      runningRef.current = true
      setIsPreloading(true)
      setProgress({ total: 0, completed: 0, errored: 0, isDone: false })

      try {
        const cache = await openMediaCache()

        // ---------- Collect URLs to preload ----------
        interface PreloadItem {
          url: string
          kind: MediaCacheKind
        }

        // P12d: resolve all media URLs in parallel. The previous serial
        // `await` per object meant a deck with N media assets paid N×
        // round-trip latency before the preload could start fetching
        // bytes. With Promise.all the wait collapses to ~max-RTT.
        const resolvers: Array<Promise<PreloadItem[]>> = []
        for (const slide of slides) {
          for (const obj of slide.objects) {
            if (obj.type === 'image') {
              const imgObj = obj as ImageObject
              if (imgObj.assetId !== '') {
                resolvers.push(
                  api
                    .getMediaUrl(imgObj.assetId, 'display')
                    .then((url): PreloadItem[] => [{ url, kind: 'image' }])
                    .catch((): PreloadItem[] => []),
                )
              }
            } else if (obj.type === 'video') {
              const vidObj = obj as VideoObject
              if (vidObj.assetId !== '') {
                resolvers.push(
                  api
                    .getVideoInfo(vidObj.assetId)
                    .then((info): PreloadItem[] => {
                      const out: PreloadItem[] = []
                      if (info.posterUrl !== null) {
                        out.push({ url: info.posterUrl, kind: 'video-poster' })
                      }
                      if (info.hlsManifestUrl !== null && info.transcodeStatus === 'done') {
                        out.push({ url: info.hlsManifestUrl, kind: 'hls-manifest' })
                      }
                      return out
                    })
                    .catch((): PreloadItem[] => []),
                )
              }
            }
          }
        }

        const items: PreloadItem[] = (await Promise.all(resolvers)).flat()

        setProgress({ total: items.length, completed: 0, errored: 0, isDone: items.length === 0 })

        if (items.length === 0) {
          setIsPreloading(false)
          runningRef.current = false
          return
        }

        // ---------- Fetch + cache each item ----------
        let completed = 0
        let errored = 0

        await Promise.all(
          items.map(async (item) => {
            try {
              // Check cache first
              const cached = await cache.get(item.url)
              if (cached !== null) {
                completed++
                setProgress((prev) => ({
                  ...prev,
                  completed,
                  isDone: completed + errored >= items.length,
                }))
                return
              }

              // Fetch the resource. `credentials: 'include'` carries the
              // narrative_session cookie when the URL is on our origin (or
              // same-site in dev). For MinIO presigned URLs the credentials
              // header is ignored — the URL signature is the auth.
              if (item.kind === 'hls-manifest') {
                const res = await fetch(item.url, { credentials: 'include' })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                const text = await res.text()
                await cache.put(item.url, text, 'hls-manifest')
              } else {
                const res = await fetch(item.url, { credentials: 'include' })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                const blob = await res.blob()
                await cache.put(item.url, blob, item.kind)
              }

              completed++
            } catch (err) {
              // Non-fatal — log and increment errored
              console.warn('[useMediaPreload] failed to preload', item.url, err)
              errored++
            } finally {
              setProgress({
                total: items.length,
                completed,
                errored,
                isDone: completed + errored >= items.length,
              })
            }
          }),
        )
      } catch (err) {
        console.error('[useMediaPreload] preload failed', err)
      } finally {
        setIsPreloading(false)
        runningRef.current = false
      }
    },
    [api],
  )

  return { start, progress, isPreloading }
}
