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
import { useAuth } from './AuthContext.js'

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
  const { token } = useAuth()

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

        const items: PreloadItem[] = []

        // Walk all objects on all slides
        for (const slide of slides) {
          for (const obj of slide.objects) {
            if (obj.type === 'image') {
              const imgObj = obj as ImageObject
              if (imgObj.assetId !== '') {
                try {
                  const url = await api.getMediaUrl(imgObj.assetId, 'display')
                  items.push({ url, kind: 'image' })
                } catch {
                  // Failed to get URL — skip (will render broken on screen)
                }
              }
            } else if (obj.type === 'video') {
              const vidObj = obj as VideoObject
              if (vidObj.assetId !== '') {
                try {
                  const info = await api.getVideoInfo(vidObj.assetId)
                  if (info.posterUrl !== null) {
                    items.push({ url: info.posterUrl, kind: 'video-poster' })
                  }
                  if (info.hlsManifestUrl !== null && info.transcodeStatus === 'done') {
                    items.push({ url: info.hlsManifestUrl, kind: 'hls-manifest' })
                  }
                } catch {
                  // Failed to get video info — skip
                }
              }
            }
          }
        }

        setProgress({ total: items.length, completed: 0, errored: 0, isDone: items.length === 0 })

        if (items.length === 0) {
          setIsPreloading(false)
          runningRef.current = false
          return
        }

        // ---------- Fetch + cache each item ----------
        let completed = 0
        let errored = 0

        // Build auth headers for direct fetches (bypasses the api client — we need raw Blob)
        const fetchHeaders: Record<string, string> = {}
        if (token !== null) {
          fetchHeaders['Authorization'] = `Bearer ${token}`
        }

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

              // Fetch the resource
              if (item.kind === 'hls-manifest') {
                const res = await fetch(item.url, { headers: fetchHeaders })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                const text = await res.text()
                await cache.put(item.url, text, 'hls-manifest')
              } else {
                const res = await fetch(item.url, { headers: fetchHeaders })
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
    [api, token],
  )

  return { start, progress, isPreloading }
}
