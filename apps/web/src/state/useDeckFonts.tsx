/**
 * state/useDeckFonts.tsx
 *
 * Deck-scoped fonts: created when a folder font is deleted while a
 * presentation referenced it (server promotes the row to deck scope so
 * the deck keeps rendering). The editor needs to load these alongside
 * folder fonts and surface a small notice for awareness.
 *
 * Mirrors useFolderFonts shape — same FolderFontSummary record type.
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useApi } from '../api/client.js'
import type { FolderFontSummary } from '../api/client.js'

interface CacheEntry {
  fonts: FolderFontSummary[]
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000

function getCached(deckId: string): FolderFontSummary[] | null {
  const entry = cache.get(deckId)
  if (!entry) return null
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null
  return entry.fonts
}

function setCached(deckId: string, fonts: FolderFontSummary[]): void {
  cache.set(deckId, { fonts, fetchedAt: Date.now() })
}

function invalidateCache(deckId: string): void {
  cache.delete(deckId)
}

export interface DeckFontsContextValue {
  deckId: string
  fonts: FolderFontSummary[]
  loading: boolean
  error: string | null
  refresh(): Promise<void>
}

const DeckFontsContext = createContext<DeckFontsContextValue | null>(null)

interface DeckFontsProviderProps {
  deckId: string
  children: React.ReactNode
}

export function DeckFontsProvider({ deckId, children }: DeckFontsProviderProps) {
  const api = useApi()
  const [fonts, setFonts] = useState<FolderFontSummary[]>(() => getCached(deckId) ?? [])
  const [loading, setLoading] = useState<boolean>(() => getCached(deckId) === null)
  const [error, setError] = useState<string | null>(null)

  const doFetch = useCallback(
    async (invalidate: boolean) => {
      if (invalidate) invalidateCache(deckId)
      const cached = getCached(deckId)
      if (cached !== null && !invalidate) {
        setFonts(cached)
        setLoading(false)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const result = await api.listDeckFonts(deckId)
        setCached(deckId, result)
        setFonts(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load deck fonts')
      } finally {
        setLoading(false)
      }
    },
    [api, deckId],
  )

  useEffect(() => {
    void doFetch(false)
  }, [doFetch])

  const refresh = useCallback(() => doFetch(true), [doFetch])

  const value: DeckFontsContextValue = { deckId, fonts, loading, error, refresh }

  return <DeckFontsContext value={value}>{children}</DeckFontsContext>
}

export function useDeckFonts(): DeckFontsContextValue {
  const ctx = useContext(DeckFontsContext)
  if (!ctx) throw new Error('useDeckFonts must be used inside <DeckFontsProvider>')
  return ctx
}

export function useDeckFontsOptional(): DeckFontsContextValue | null {
  return useContext(DeckFontsContext)
}
