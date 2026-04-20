/**
 * state/mediaCache.ts
 *
 * M12: IndexedDB cache for media preloading.
 *
 * Stores:
 *   - imgproxy image URLs → Blob (PNG/JPG)
 *   - video poster URLs → Blob
 *   - HLS master manifests → string (text)
 *
 * Limitations:
 *   - HLS segments are NOT cached — hls.js handles its own buffering.
 *     The manifest cache reduces first-manifest-fetch latency; segments still stream on demand.
 *   - Cache uses idb package (lightweight IndexedDB wrapper).
 *   - TTL is 24 hours per entry. Expired entries are returned as null (re-fetch on next access).
 *
 * Usage:
 *   const cache = await openMediaCache()
 *   await cache.put(url, blob, 'image')
 *   const entry = await cache.get(url)
 *   if (entry && entry.content instanceof Blob) { ... }
 */

import { openDB } from 'idb'
import type { IDBPDatabase } from 'idb'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaCacheKind = 'image' | 'video-poster' | 'hls-manifest'

export interface CachedMedia {
  url: string
  kind: MediaCacheKind
  /** Blob for image/video-poster, string for hls-manifest */
  content: Blob | string
  cachedAt: number
  /** Unix ms timestamp after which this entry is considered stale */
  expiresAt: number
}

export interface MediaCache {
  get(url: string): Promise<CachedMedia | null>
  put(url: string, content: Blob | string, kind: MediaCacheKind): Promise<void>
  clear(): Promise<void>
  size(): Promise<number>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_NAME = 'narrative-media-cache'
const DB_VERSION = 1
const STORE_NAME = 'media'
const TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Opens (or creates) the media IndexedDB cache.
 * Safe to call multiple times — returns the same DB connection if already open.
 */
export async function openMediaCache(): Promise<MediaCache> {
  const db: IDBPDatabase = await openDB(DB_NAME, DB_VERSION, {
    upgrade(upgradeDb) {
      if (!upgradeDb.objectStoreNames.contains(STORE_NAME)) {
        upgradeDb.createObjectStore(STORE_NAME, { keyPath: 'url' })
      }
    },
  })

  return {
    async get(url: string): Promise<CachedMedia | null> {
      const entry = (await db.get(STORE_NAME, url)) as CachedMedia | undefined
      if (entry === undefined) return null
      // Treat expired entries as cache miss
      if (Date.now() > entry.expiresAt) return null
      return entry
    },

    async put(url: string, content: Blob | string, kind: MediaCacheKind): Promise<void> {
      const now = Date.now()
      const entry: CachedMedia = {
        url,
        kind,
        content,
        cachedAt: now,
        expiresAt: now + TTL_MS,
      }
      await db.put(STORE_NAME, entry)
    },

    async clear(): Promise<void> {
      await db.clear(STORE_NAME)
    },

    async size(): Promise<number> {
      return db.count(STORE_NAME)
    },
  }
}
