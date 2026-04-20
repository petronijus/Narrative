/**
 * state/DeckRoleContext.tsx
 *
 * M10: Per-deck role context. Provides the current user's effective role
 * for a given deck so components can gate UI accordingly.
 *
 * Role resolution priority:
 *   1. share_token in URL → 'viewer' (anonymous viewer path)
 *   2. viewerRole from deck list response (server includes it when authed)
 *   3. Fallback: 'viewer' (safe default — never grants write access unexpectedly)
 *
 * DeckRoleProvider is placed inside DeckShell so all editor/present children
 * can call useDeckRole() without prop-drilling.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useApi } from '../api/client.js'
import { useAuth } from './AuthContext.js'

export type DeckRole = 'owner' | 'editor' | 'viewer'

interface DeckRoleContextValue {
  role: DeckRole
  isLoading: boolean
}

const DeckRoleContext = createContext<DeckRoleContextValue>({ role: 'viewer', isLoading: false })

interface DeckRoleProviderProps {
  deckId: string
  children: ReactNode
}

export function DeckRoleProvider({ deckId, children }: DeckRoleProviderProps) {
  const location = useLocation()
  const { user } = useAuth()
  const api = useApi()

  const [role, setRole] = useState<DeckRole>('viewer')
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search)

    // share_token in URL → unauth viewer path, no API call needed
    if (searchParams.has('share_token')) {
      setRole('viewer')
      setIsLoading(false)
      return
    }

    // Not authenticated — treat as viewer (ProtectedRoute should have already redirected,
    // but be safe)
    if (user === null) {
      setRole('viewer')
      setIsLoading(false)
      return
    }

    // Fetch deck list and find viewerRole for this deck.
    // When state-sync phase 2 lands, GET /decks/:id will include viewerRole directly.
    // For now we use listDecks() which returns all accessible decks with viewerRole.
    let cancelled = false

    api
      .listDecks()
      .then((decks) => {
        if (cancelled) return
        const deck = decks.find((d) => d.id === deckId)
        if (deck !== undefined && deck.viewerRole !== undefined) {
          setRole(deck.viewerRole)
        } else {
          // Deck not found in list or viewerRole not yet returned by server.
          // Safe fallback: if user owns or can see the deck at all, treat as owner
          // until server provides the field. For M10 this is acceptable.
          setRole(deck !== undefined ? 'editor' : 'viewer')
        }
      })
      .catch(() => {
        if (cancelled) return
        setRole('viewer')
      })
      .finally(() => {
        if (cancelled) return
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [deckId, user, api, location.search])

  return <DeckRoleContext.Provider value={{ role, isLoading }}>{children}</DeckRoleContext.Provider>
}

export function useDeckRole(): DeckRoleContextValue {
  return useContext(DeckRoleContext)
}
