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
  /** M16 P2: folder this deck belongs to. null while loading. */
  folderId: string | null
}

const DeckRoleContext = createContext<DeckRoleContextValue>({
  role: 'viewer',
  isLoading: false,
  folderId: null,
})

/**
 * Static-value variant for surfaces outside the deck path that still
 * need to feed `useDeckRole()` consumers (toolbar, inspector, picker,
 * etc.). Used by the component master editor — it knows its folderId
 * from the route and grants the user 'owner' role for the master.
 */
export function DeckRoleStaticProvider({
  role,
  folderId,
  children,
}: {
  role: DeckRole
  folderId: string | null
  children: ReactNode
}) {
  return (
    <DeckRoleContext.Provider value={{ role, folderId, isLoading: false }}>
      {children}
    </DeckRoleContext.Provider>
  )
}

interface DeckRoleProviderProps {
  deckId: string
  children: ReactNode
}

export function DeckRoleProvider({ deckId, children }: DeckRoleProviderProps) {
  const location = useLocation()
  const { user } = useAuth()
  const api = useApi()

  const [role, setRole] = useState<DeckRole>('viewer')
  const [folderId, setFolderId] = useState<string | null>(null)
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
        } else if (deck !== undefined) {
          // Deck visible to caller but server didn't return viewerRole.
          // Derive from ownerUserId vs current user — without this the Share
          // button (owner-only) is unreachable for everyone.
          setRole(deck.ownerUserId === user.sub ? 'owner' : 'editor')
        } else {
          setRole('viewer')
        }
        // M16 P2: expose folderId so DeckShell can open the folder token doc.
        if (deck?.folderId) {
          setFolderId(deck.folderId)
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

  return (
    <DeckRoleContext.Provider value={{ role, folderId, isLoading }}>
      {children}
    </DeckRoleContext.Provider>
  )
}

export function useDeckRole(): DeckRoleContextValue {
  return useContext(DeckRoleContext)
}
