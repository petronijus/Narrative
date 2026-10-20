/**
 * state/DeckRoleContext.tsx
 *
 * M10: Per-deck role context. Provides the current user's effective role
 * for a given deck so components can gate UI accordingly.
 *
 * The role and the deck's folder come from GET /decks/:id, which answers with
 * the caller's role on that one deck: the higher of their deck grant and
 * folder role, raised by a `share_token` in the URL (the anonymous viewer
 * path; the folder id opens the folder's token document, which admits the
 * link read-only). Anything else — no session and no token, a refused or
 * failed request — is 'viewer', the safe default that never grants writes.
 *
 * Until the answer arrives the role is 'viewer' too, so the editor is
 * read-only for that moment. It used to fetch the caller's whole deck list
 * (GET /decks) and pick this deck out of it: on a long list — 7,752 decks,
 * 3.4 MB, on the e2e dev user on 2026-10-15 — that moment grew long enough
 * for the inspector's fields to still be disabled when a person (or a spec)
 * reached for them.
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
  return <DeckRoleContext value={{ role, folderId, isLoading: false }}>{children}</DeckRoleContext>
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
  // Only the share link's token matters, not the rest of the query: the
  // render page changes `?slide=` for every slide it shows, and each change
  // asked GET /decks/:id again (docs/plans/performance.md, R1).
  const shareToken = new URLSearchParams(location.search).get('share_token')

  useEffect(() => {
    // Neither a session nor a share link (ProtectedRoute should have
    // redirected already, but be safe).
    if (shareToken === null && user === null) {
      setRole('viewer')
      setIsLoading(false)
      return
    }

    let cancelled = false
    api
      .getDeck(deckId, shareToken !== null ? { shareToken } : undefined)
      .then((deck) => {
        if (cancelled) return
        setRole(deck.viewerRole ?? 'viewer')
        // M16 P2: expose folderId so DeckShell can open the folder token doc.
        setFolderId(deck.folderId ?? null)
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
  }, [deckId, user, api, shareToken])

  return <DeckRoleContext value={{ role, folderId, isLoading }}>{children}</DeckRoleContext>
}

export function useDeckRole(): DeckRoleContextValue {
  return useContext(DeckRoleContext)
}
