/**
 * api/client.ts
 *
 * M10: Centralized API client with automatic Bearer token injection.
 *
 * Usage:
 *   const api = useApi()          // inside React tree (reads AuthContext)
 *   api.listDecks()
 *
 * Outside React (e.g. tests) use createApiClient(() => token) directly.
 *
 * Responds to 401 by logging a warning — the consumer or AuthProvider's
 * silent renew handles re-auth. We never retry automatically here to
 * avoid infinite loops.
 */

import { useCallback, useMemo } from 'react'
import { useAuth } from '../state/AuthContext.js'

const API_URL = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001'

// ---------------------------------------------------------------------------
// Core request function
// ---------------------------------------------------------------------------

export interface ApiClient {
  listDecks(): Promise<DeckSummary[]>
  createDeck(title?: string): Promise<DeckSummary>
  deleteDeck(id: string): Promise<void>
  listPermissions(deckId: string): Promise<DeckPermission[]>
  grantPermission(deckId: string, body: GrantPermissionBody): Promise<void>
  revokePermission(deckId: string, userId: string): Promise<void>
  listShareLinks(deckId: string): Promise<ShareLink[]>
  createShareLink(deckId: string, body: CreateShareLinkBody): Promise<ShareLinkCreated>
  revokeShareLink(deckId: string, linkId: string): Promise<void>
}

export interface DeckSummary {
  id: string
  title: string
  ownerUserId: string
  createdAt: string
  updatedAt: string
  /** Server includes the authenticated user's effective role when known. M10. */
  viewerRole?: 'owner' | 'editor' | 'viewer'
}

export interface DeckPermission {
  userId: string
  role: 'owner' | 'editor' | 'viewer'
  grantedAt: string
}

export interface GrantPermissionBody {
  userId: string
  role: 'owner' | 'editor' | 'viewer'
}

export interface ShareLink {
  id: string
  role: 'owner' | 'editor' | 'viewer'
  createdAt: string
  expiresAt: string | null
  url: string
}

export interface ShareLinkCreated {
  id: string
  url: string
}

export interface CreateShareLinkBody {
  role: 'owner' | 'editor' | 'viewer'
  expiresAt?: string
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createApiClient(getToken: () => string | null): ApiClient {
  async function request(path: string, init?: RequestInit): Promise<Response> {
    const tok = getToken()
    const headers = new Headers(init?.headers)
    if (tok !== null && tok.length > 0) {
      headers.set('Authorization', `Bearer ${tok}`)
    }
    const res = await fetch(`${API_URL}${path}`, { ...init, headers })
    if (res.status === 401) {
      // Token may be expired or missing; caller should re-auth
      console.warn('[api] 401 — re-authentication needed')
    }
    return res
  }

  async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await request(path, init)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json() as Promise<T>
  }

  return {
    listDecks: () => requestJson<DeckSummary[]>('/decks'),

    createDeck: (title = 'Untitled Deck') =>
      requestJson<DeckSummary>('/decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      }),

    deleteDeck: async (id) => {
      const res = await request(`/decks/${id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    },

    listPermissions: (deckId) => requestJson<DeckPermission[]>(`/decks/${deckId}/permissions`),

    grantPermission: async (deckId, body) => {
      const res = await request(`/decks/${deckId}/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    },

    revokePermission: async (deckId, userId) => {
      const res = await request(`/decks/${deckId}/permissions/${userId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    },

    listShareLinks: (deckId) => requestJson<ShareLink[]>(`/decks/${deckId}/share-links`),

    createShareLink: (deckId, body) =>
      requestJson<ShareLinkCreated>(`/decks/${deckId}/share-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),

    revokeShareLink: async (deckId, linkId) => {
      const res = await request(`/decks/${deckId}/share-links/${linkId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    },
  }
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export function useApi(): ApiClient {
  const { token } = useAuth()
  // Stable getToken reference so the client instance stays stable while token changes
  const getToken = useCallback(() => token, [token])
  return useMemo(() => createApiClient(getToken), [getToken])
}
