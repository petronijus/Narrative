/**
 * state/useFolderFonts.ts
 *
 * M16 P3: SWR-style hook for folder-scoped custom fonts.
 *
 * Fonts are stored in Postgres / MinIO, NOT in the Y.Doc, so they live
 * outside the CRDT layer.  This hook maintains a simple in-memory cache
 * keyed by folderId — navigating between decks in the same folder does
 * not re-fetch.
 *
 * Exported:
 *   useFolderFonts(folderId)          — requires a FolderFontsContext; use
 *                                       inside FolderDocProvider subtree.
 *   useFolderFontsOptional()          — returns null outside the provider.
 *   FolderFontsProvider               — wraps children, fetches fonts,
 *                                       exposes cache + invalidate fn.
 *
 * Cache TTL: fonts are re-fetched on mount when the cache entry is older
 * than 5 min. URLs expire in 1 h server-side, so re-fetching before that
 * keeps URLs fresh enough.
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useApi } from '../api/client.js'
import type { FolderFontSummary } from '../api/client.js'

// ---------------------------------------------------------------------------
// Cache — module-level so it persists across re-mounts of the same folder
// ---------------------------------------------------------------------------

interface CacheEntry {
  fonts: FolderFontSummary[]
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 min

function getCached(folderId: string): FolderFontSummary[] | null {
  const entry = cache.get(folderId)
  if (!entry) return null
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null
  return entry.fonts
}

function setCached(folderId: string, fonts: FolderFontSummary[]): void {
  cache.set(folderId, { fonts, fetchedAt: Date.now() })
}

function invalidateCache(folderId: string): void {
  cache.delete(folderId)
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface FolderFontsContextValue {
  folderId: string
  fonts: FolderFontSummary[]
  loading: boolean
  error: string | null
  /** Invalidate the cache and re-fetch fonts for this folder. */
  refresh(): Promise<void>
}

const FolderFontsContext = createContext<FolderFontsContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface FolderFontsProviderProps {
  folderId: string
  children: React.ReactNode
}

export function FolderFontsProvider({ folderId, children }: FolderFontsProviderProps) {
  const api = useApi()
  const [fonts, setFonts] = useState<FolderFontSummary[]>(() => getCached(folderId) ?? [])
  const [loading, setLoading] = useState<boolean>(() => getCached(folderId) === null)
  const [error, setError] = useState<string | null>(null)

  const doFetch = useCallback(
    async (invalidate: boolean) => {
      if (invalidate) invalidateCache(folderId)

      const cached = getCached(folderId)
      if (cached !== null && !invalidate) {
        setFonts(cached)
        setLoading(false)
        return
      }

      setLoading(true)
      setError(null)
      try {
        const result = await api.listFolderFonts(folderId)
        setCached(folderId, result)
        setFonts(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load folder fonts')
      } finally {
        setLoading(false)
      }
    },
    [api, folderId],
  )

  useEffect(() => {
    void doFetch(false)
  }, [doFetch])

  const refresh = useCallback(() => doFetch(true), [doFetch])

  const value: FolderFontsContextValue = { folderId, fonts, loading, error, refresh }

  return <FolderFontsContext.Provider value={value}>{children}</FolderFontsContext.Provider>
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Returns the live list of folder fonts. Must be inside FolderFontsProvider.
 */
export function useFolderFonts(): FolderFontsContextValue {
  const ctx = useContext(FolderFontsContext)
  if (!ctx) throw new Error('useFolderFonts must be used inside <FolderFontsProvider>')
  return ctx
}

/**
 * Like useFolderFonts but returns null outside the provider.
 * Use from shared widgets that must degrade gracefully.
 */
export function useFolderFontsOptional(): FolderFontsContextValue | null {
  return useContext(FolderFontsContext)
}
