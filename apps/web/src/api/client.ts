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
  /** List decks. Pass `folderId` to filter to a specific folder. */
  listDecks(opts?: { folderId?: string }): Promise<DeckSummary[]>
  /** Fetch a single deck by id. */
  getDeck(id: string): Promise<DeckSummary>
  /** Create a deck. Omit `folderId` to land in the caller's Drafts folder. */
  createDeck(title?: string, folderId?: string): Promise<DeckSummary>
  renameDeck(id: string, title: string): Promise<DeckSummary>
  deleteDeck(id: string): Promise<void>
  /**
   * P15: upload (or replace) the home-page preview thumbnail for a deck.
   * `dataUrl` must be a base64 data: URL of an image/jpeg or image/png.
   * Server caps the decoded payload at ~1 MB.
   */
  uploadDeckThumbnail(id: string, dataUrl: string): Promise<DeckSummary>
  listPermissions(deckId: string): Promise<DeckPermission[]>
  grantPermission(deckId: string, body: GrantPermissionBody): Promise<void>
  revokePermission(deckId: string, userId: string): Promise<void>
  listShareLinks(deckId: string): Promise<ShareLink[]>
  createShareLink(deckId: string, body: CreateShareLinkBody): Promise<ShareLinkCreated>
  revokeShareLink(deckId: string, linkId: string): Promise<void>
  /** M12: Fetch video transcode status + URLs for a given asset. */
  getVideoInfo(assetId: string): Promise<VideoInfoResponse>
  /** M12: Get a display-variant URL for an image asset. */
  getMediaUrl(assetId: string, variant?: 'thumb' | 'display' | 'original'): Promise<string>
  // ---------------------------------------------------------------------------
  // M16 P1 — Folder API
  // ---------------------------------------------------------------------------
  /** List folders owned by the authenticated user, each with a deckCount. */
  listFolders(): Promise<FolderSummary[]>
  /** Create a new folder. */
  createFolder(name: string): Promise<FolderSummary>
  /** Rename a folder (owner only). */
  renameFolder(id: string, name: string): Promise<FolderSummary>
  /**
   * Delete a folder.
   * Throws with status 409 if folder is non-empty ({ error: 'folder_not_empty', deckCount }).
   * Throws with status 409 if folder is the user's Drafts ({ error: 'cannot_delete_drafts' }).
   */
  deleteFolder(id: string): Promise<void>
  /**
   * Bulk-move decks from srcFolderId to destFolderId.
   * All deckIds must be owned by the caller and currently live in srcFolderId.
   * Returns the count of decks actually moved.
   */
  moveDecks(
    srcFolderId: string,
    deckIds: string[],
    destFolderId: string,
  ): Promise<{ movedCount: number }>
}

export interface DeckSummary {
  id: string
  title: string
  ownerUserId: string
  /** M16 P1: folder this deck belongs to. */
  folderId: string
  createdAt: string
  updatedAt: string
  /**
   * P15 server-side preview. Signed imgproxy URL of `decks/<id>/thumb.jpg`,
   * or null when the deck hasn't had a thumbnail uploaded yet.
   */
  thumbnailUrl?: string | null
  /** ISO timestamp of the last thumbnail upload — used for cache busts. */
  thumbnailUpdatedAt?: string | null
  /** Server includes the authenticated user's effective role when known. M10. */
  viewerRole?: 'owner' | 'editor' | 'viewer'
}

// ---------------------------------------------------------------------------
// M16 P1 — Folder types
// ---------------------------------------------------------------------------

export interface FolderSummary {
  id: string
  name: string
  /** Number of decks currently in the folder. */
  deckCount: number
  createdAt: string
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
// Video info types (M12)
// ---------------------------------------------------------------------------

export interface VideoInfoResponse {
  assetId: string
  transcodeStatus: 'pending' | 'processing' | 'done' | 'failed'
  durationSec: number | null
  width: number | null
  height: number | null
  posterUrl: string | null
  thumbnailUrl: string | null
  hlsManifestUrl: string | null
  transcodeError: string | null
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
    listDecks: (opts) => {
      const url = opts?.folderId != null ? `/decks?folderId=${opts.folderId}` : '/decks'
      return requestJson<DeckSummary[]>(url)
    },

    getDeck: (id) => requestJson<DeckSummary>(`/decks/${id}`),

    createDeck: (title = 'Untitled Deck', folderId) =>
      requestJson<DeckSummary>('/decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, ...(folderId != null ? { folderId } : {}) }),
      }),

    renameDeck: (id, title) =>
      requestJson<DeckSummary>(`/decks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      }),

    deleteDeck: async (id) => {
      const res = await request(`/decks/${id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    },

    uploadDeckThumbnail: (id, dataUrl) =>
      requestJson<DeckSummary>(`/decks/${id}/thumbnail`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      }),

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

    getVideoInfo: (assetId) => requestJson<VideoInfoResponse>(`/api/media/${assetId}/video-info`),

    getMediaUrl: async (assetId, variant = 'display') => {
      const data = await requestJson<{ url: string }>(
        `/api/media/${assetId}/url?variant=${variant}`,
      )
      return data.url
    },

    // -------------------------------------------------------------------------
    // M16 P1 — Folder methods
    // -------------------------------------------------------------------------

    listFolders: () => requestJson<FolderSummary[]>('/folders'),

    createFolder: (name) =>
      requestJson<FolderSummary>('/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),

    renameFolder: (id, name) =>
      requestJson<FolderSummary>(`/folders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),

    deleteFolder: async (id) => {
      const res = await request(`/folders/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        // Surface structured error body so callers can handle 409 folder_not_empty
        let body: unknown
        try {
          body = await res.json()
        } catch {
          body = {}
        }
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body })
      }
    },

    moveDecks: (srcFolderId, deckIds, destFolderId) =>
      requestJson<{ movedCount: number }>(`/folders/${srcFolderId}/move-decks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deckIds, destFolderId }),
      }),
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
