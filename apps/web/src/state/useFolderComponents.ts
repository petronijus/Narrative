/**
 * state/useFolderComponents.ts
 *
 * M16 P6 — Editor-side cache for the list of shared components in a folder.
 *
 * Why a hook:
 *   - The Toolbar's "+ Add component" button must know whether the folder
 *     contains any components (to decide whether to render at all). If we
 *     fetched on every Toolbar render, that's an HTTP round-trip per
 *     selection / undo / cursor move. The list rarely changes at editor-
 *     runtime — promotions go through the same client and can invalidate
 *     this cache directly.
 *
 * Behaviour:
 *   - Lazy initial fetch on first call (per folderId).
 *   - `invalidate()` re-fetches and re-broadcasts to all subscribers; the
 *     drawer calls this on open so freshly-promoted components show up
 *     without a page reload.
 *   - Caches are keyed by folderId; they live for the lifetime of the
 *     module (one per editor session).
 *
 * Not stored: the doc-bytes of each component master — that lives in
 * `componentDocCache.ts`. This hook is metadata only.
 */

import { useCallback, useEffect, useState } from 'react'
import { useApi, type ComponentSummary } from '../api/client.js'

interface CacheEntry {
  list: ComponentSummary[] | null
  loading: boolean
  error: Error | null
  /** Set of subscriber callbacks to call after every list update. */
  subscribers: Set<() => void>
  /** Tracks an in-flight fetch so concurrent callers share one request. */
  inflight: Promise<ComponentSummary[]> | null
}

const cache = new Map<string, CacheEntry>()

function getEntry(folderId: string): CacheEntry {
  let entry = cache.get(folderId)
  if (entry === undefined) {
    entry = { list: null, loading: false, error: null, subscribers: new Set(), inflight: null }
    cache.set(folderId, entry)
  }
  return entry
}

function notifySubscribers(entry: CacheEntry): void {
  for (const cb of [...entry.subscribers]) {
    try {
      cb()
    } catch {
      // Swallow — one buggy subscriber must not stop the rest from learning.
    }
  }
}

export interface UseFolderComponentsResult {
  components: ComponentSummary[] | null
  loading: boolean
  error: Error | null
  /** Force a re-fetch and broadcast. Returns the new list. */
  invalidate: () => Promise<ComponentSummary[]>
}

/**
 * Subscribes to the cached component list for a folder. Returns null while
 * the first fetch is in flight; subsequent renders see the cached list.
 *
 * Pass `eager: true` to start the fetch on first mount; otherwise the
 * caller must call `invalidate()` (e.g. on drawer-open) to populate.
 */
export function useFolderComponents(
  folderId: string | null,
  opts?: { eager?: boolean },
): UseFolderComponentsResult {
  const api = useApi()
  const [, forceRender] = useState(0)
  const eager = opts?.eager ?? false

  const entry = folderId !== null ? getEntry(folderId) : null

  // Subscribe to cache changes for this folderId. Re-render on every flip.
  useEffect(() => {
    if (entry === null) return
    const sub = () => forceRender((n) => n + 1)
    entry.subscribers.add(sub)
    return () => {
      entry.subscribers.delete(sub)
    }
  }, [entry])

  const fetchList = useCallback(async (): Promise<ComponentSummary[]> => {
    if (folderId === null || entry === null) return []
    if (entry.inflight !== null) return entry.inflight
    entry.loading = true
    entry.error = null
    notifySubscribers(entry)
    const promise = (async () => {
      try {
        const list = await api.listComponents(folderId)
        entry.list = list
        return list
      } catch (err) {
        entry.error = err instanceof Error ? err : new Error(String(err))
        return entry.list ?? []
      } finally {
        entry.loading = false
        entry.inflight = null
        notifySubscribers(entry)
      }
    })()
    entry.inflight = promise
    return promise
  }, [api, folderId, entry])

  // Eager initial fetch on first hook call for a folderId we haven't seen.
  useEffect(() => {
    if (!eager || entry === null) return
    if (entry.list === null && entry.inflight === null) {
      void fetchList()
    }
  }, [eager, entry, fetchList])

  return {
    components: entry?.list ?? null,
    loading: entry?.loading ?? false,
    error: entry?.error ?? null,
    invalidate: fetchList,
  }
}

/**
 * Invalidates the cache for a folder without subscribing — used by promote /
 * delete flows that mutate the component list out-of-band.
 */
export function invalidateFolderComponentsCache(folderId: string): void {
  const entry = cache.get(folderId)
  if (entry === undefined) return
  entry.list = null
  entry.error = null
  notifySubscribers(entry)
}

/** @internal */
export function __resetFolderComponentsCacheForTests(): void {
  cache.clear()
}
