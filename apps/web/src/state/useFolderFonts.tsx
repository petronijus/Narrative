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

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import type { FontFaceWeight } from '@narrative/commands'
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

/**
 * Shared empty list for the no-folder state. A fresh `[]` on every call
 * would be a new state value each time, so any caller whose `useApi()`
 * identity is unstable would re-run the fetch effect forever.
 */
const NO_FONTS: FolderFontSummary[] = []

function getCached(folderId: string | null): FolderFontSummary[] | null {
  if (folderId === null) return null
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

/**
 * External-trigger for the folder-fonts cache invalidation. Components
 * that upload a font but don't live inside a `FolderFontsProvider`
 * (e.g. the post-import missing-fonts panel on FoldersHome, where no
 * deck is open yet) call this so the deck's provider re-fetches when
 * it mounts after navigation. Inside-the-provider callers should
 * prefer `useFolderFonts().refresh()` — it both invalidates AND
 * re-fetches synchronously into the current context.
 */
export function invalidateFolderFontsCache(folderId: string): void {
  invalidateCache(folderId)
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface FolderFontsContextValue {
  /** null while the deck's folder is still being resolved. */
  folderId: string | null
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
  /**
   * The folder whose fonts to load, or null while it is still unknown
   * (the deck's folder arrives from the deck-role fetch a moment after
   * the editor mounts). A null id keeps the provider mounted with an
   * empty font list instead of forcing the caller to swap element types,
   * which would remount the whole editor subtree mid-load.
   */
  folderId: string | null
  children: React.ReactNode
}

export function FolderFontsProvider({ folderId, children }: FolderFontsProviderProps) {
  const api = useApi()
  const [fonts, setFonts] = useState<FolderFontSummary[]>(() => getCached(folderId) ?? NO_FONTS)
  const [loading, setLoading] = useState<boolean>(
    () => folderId !== null && getCached(folderId) === null,
  )
  const [error, setError] = useState<string | null>(null)

  const doFetch = useCallback(
    async (invalidate: boolean) => {
      if (folderId === null) {
        setFonts(NO_FONTS)
        setLoading(false)
        setError(null)
        return
      }

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

  return <FolderFontsContext value={value}>{children}</FolderFontsContext>
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

/**
 * The folder's font faces as a command sees them (`CommandContext.folderFonts`):
 * family and weight of each uploaded face (null when the folder has none, as
 * the server host reports it), undefined while they are not known — no
 * provider, or no list yet (first load pending or failed). A refetch keeps
 * the list it had on screen, so it keeps serving that one: the families the
 * pickers offer are the ones the commands know.
 */
export function useFolderFontsForCommands(): ReadonlyArray<FontFaceWeight> | null | undefined {
  const ctx = useContext(FolderFontsContext)
  const known = ctx !== null && (ctx.fonts.length > 0 || (!ctx.loading && ctx.error === null))
  const fonts = known ? ctx.fonts : undefined
  return useMemo(() => {
    if (fonts === undefined) return undefined
    return fonts.length === 0
      ? null
      : fonts.map((f) => ({
          family: f.family,
          weight: f.weight,
          ...(f.axes !== undefined ? { axes: f.axes } : {}),
        }))
  }, [fonts])
}
