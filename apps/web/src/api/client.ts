/**
 * api/client.ts
 *
 * Centralised API client. Auth is carried by the `narrative_session` HttpOnly
 * cookie set during the server-driven OAuth flow, so every fetch goes out
 * with `credentials: 'include'` — there is no Bearer header path any more.
 *
 * Usage:
 *   const api = useApi()      // inside React tree
 *   api.listDecks()
 *
 * Outside React (e.g. tests) use createApiClient() directly.
 *
 * 401 → log a warning; callers / AuthProvider re-fetch /auth/me to surface
 * the logged-out state. We never retry automatically here to avoid loops.
 */

import { useMemo } from 'react'

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
  /** Invite by email. If the email belongs to a known user → instant grant.
   *  Otherwise → pending invite (the invitee gets a real permission row
   *  the next time they log in with this email). */
  inviteByEmail(deckId: string, body: InviteByEmailBody): Promise<InviteByEmailResult>
  revokePermission(deckId: string, userId: string): Promise<void>
  /** List pending email invites for a deck (owner only). */
  listInvites(deckId: string): Promise<DeckInvite[]>
  /** Cancel a pending email invite. Idempotent. */
  revokeInvite(deckId: string, inviteId: string): Promise<void>
  listShareLinks(deckId: string): Promise<ShareLink[]>
  createShareLink(deckId: string, body: CreateShareLinkBody): Promise<ShareLinkCreated>
  revokeShareLink(deckId: string, linkId: string): Promise<void>
  /** M12: Fetch video transcode status + URLs for a given asset. */
  getVideoInfo(assetId: string): Promise<VideoInfoResponse>
  /** M12: Get a display-variant URL for an image asset. */
  getMediaUrl(
    assetId: string,
    variant?: 'thumb' | 'preview' | 'display' | 'original',
  ): Promise<string>
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
  /**
   * List active editors per deck for a folder. Returns only decks with
   * at least one editor besides the caller. Used by the folder view to
   * show "who is editing" bubbles on each deck tile.
   */
  listFolderActiveEditors(folderId: string): Promise<ActiveEditorsEntry[]>

  /**
   * M28 — PowerPoint import. POSTs the raw .pptx bytes; server parses,
   * builds a Y.Doc, and creates a deck in the target folder. Returns the
   * new deckId and a brief import summary the UI can surface as a toast.
   */
  importPptx(file: File, folderId: string): Promise<ImportPptxResult>

  /**
   * M28 — Append a .pptx into an existing deck. Server appends the parsed
   * slides at the end of the current slide list via a differential Y.Doc
   * update; the caller's open Hocuspocus connection picks up the new slides
   * within seconds (no client-side refresh needed). Caller must already
   * have editor+ role on the deck.
   */
  appendPptx(file: File, deckId: string): Promise<AppendPptxResult>

  // ---------------------------------------------------------------------------
  // M16 P5 — Component API
  // ---------------------------------------------------------------------------
  /** List components in a folder (owner only). */
  listComponents(folderId: string): Promise<ComponentSummary[]>
  /**
   * Create a component metadata row. Pass `id` to pre-assign the component id
   * so the Hocuspocus doc name is known before connecting (avoids a round-trip).
   * Omit to let the server generate a nanoid(12).
   */
  createComponent(
    folderId: string,
    opts?: { name?: string; id?: string },
  ): Promise<ComponentSummary>
  /** Rename a component (owner only). */
  renameComponent(componentId: string, name: string): Promise<ComponentSummary>
  /** Delete a component and cascade its update log (owner only). Caller handles instance cleanup. */
  deleteComponent(componentId: string): Promise<void>
  /**
   * Upload (or replace) the master preview thumbnail for a component.
   * `dataUrl` must be a base64 data: URL of image/jpeg or image/png.
   * Server caps the decoded payload at ~1 MB.
   */
  uploadComponentThumbnail(componentId: string, dataUrl: string): Promise<ComponentSummary>

  // ---------------------------------------------------------------------------
  // M16 P3 — Folder font API
  // ---------------------------------------------------------------------------
  /** List fonts uploaded to a folder. */
  listFolderFonts(folderId: string): Promise<FolderFontSummary[]>
  /**
   * Upload a font file to a folder.
   * Sends the raw file bytes as body with the file's MIME type as Content-Type.
   * Optional original filename via X-Filename header for extension detection.
   */
  uploadFolderFont(
    folderId: string,
    file: File,
    opts?: { familyOverride?: string },
  ): Promise<FolderFontSummary>
  /**
   * Delete a folder font by asset id.
   * Returns the number of decks the font was promoted to (deck-scoped clones)
   * — non-zero when the folder still has presentations that may reference it.
   */
  deleteFolderFont(folderId: string, assetId: string): Promise<{ promotedToDeckCount: number }>
  /** List fonts that have been promoted to deck scope (deck-specific fonts). */
  listDeckFonts(deckId: string): Promise<FolderFontSummary[]>

  // ---------------------------------------------------------------------------
  // M16 P4 — Token usage scanning
  // ---------------------------------------------------------------------------
  /**
   * Scan all decks, components, and text styles in the folder for references
   * to the given token.  Intended for delete-time warnings.  May take up to
   * a few seconds for large folders — callers should show a loading indicator.
   */
  listTokenUsages(folderId: string, category: string, tokenId: string): Promise<TokenUsage[]>
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

/** A user actively editing a deck. `email`/`name` are best-effort display
 *  fields (null when the directory hasn't seen this sub yet, e.g. share-link
 *  viewers — though those are excluded server-side). */
export interface ActiveEditorUser {
  userId: string
  email: string | null
  name: string | null
}

/** Snapshot of users actively editing a single deck. */
export interface ActiveEditorsEntry {
  deckId: string
  users: ActiveEditorUser[]
}

/** Summary returned by the .pptx import endpoint — drives the success toast. */
export interface ImportPptxResult {
  deckId: string
  slideCount: number
  objectsCreated: number
  skipped: { images: number; unknownShapes: number; fonts?: number }
  ignoredElements: string[]
  slideWidth: number
  slideHeight: number
  /** Number of embedded fonts lifted from the PPTX's `<p:embeddedFontLst>`
   *  and stamped into media_assets. Field is missing on older servers. */
  embeddedFontCount?: number
  /** Distinct fontFamily values referenced anywhere in the imported
   *  deck. Drives the post-import "upload missing fonts" panel. */
  referencedFontFamilies?: string[]
}

/** Summary returned by the append endpoint — same shape minus the deck-creation
 *  fields. `appendedSlides` is the number of slides added, not the deck total. */
export interface AppendPptxResult {
  deckId: string
  appendedSlides: number
  objectsCreated: number
  skipped: { images: number; unknownShapes: number }
  ignoredElements: string[]
  slideWidth: number
  slideHeight: number
}

// ---------------------------------------------------------------------------
// M16 P5 — Folder component types
// ---------------------------------------------------------------------------

export interface ComponentSummary {
  id: string
  folderId: string
  name: string
  createdAt: string
  updatedAt: string
  /** Signed imgproxy URL. NULL until the editor uploads a first thumbnail. */
  thumbnailUrl?: string | null
}

// ---------------------------------------------------------------------------
// M16 P3 — Folder font types
// ---------------------------------------------------------------------------

/**
 * A font asset uploaded to a folder and stored in MinIO.
 * Returned by listFolderFonts / uploadFolderFont.
 */
export interface FolderFontSummary {
  assetId: string
  family: string
  weight: number
  style: 'normal' | 'italic'
  postscriptName: string
  /** Presigned MinIO URL — valid for ~1 h. Refresh by calling listFolderFonts again. */
  url: string
  sizeBytes: number
  uploadedAt: string
}

// ---------------------------------------------------------------------------
// M16 P4 — Token usage types
// ---------------------------------------------------------------------------

export type TokenUsage =
  | {
      kind: 'deck'
      deckId: string
      deckTitle: string
      slideIndex: number
      objectId?: string
      field: string
    }
  | {
      kind: 'component'
      componentId: string
      componentName: string
      objectId?: string
      field: string
    }
  | {
      kind: 'textStyle'
      styleId: string
      styleName: string
      field: 'color'
    }

export interface DeckPermission {
  userId: string
  role: 'owner' | 'editor' | 'viewer'
  grantedAt: string
  /** Resolved via the `users` directory on the server. Null only on legacy
   *  rows where the user hasn't logged in since the 0.7.0 migration. */
  email: string | null
  name: string | null
}

/** A pending invite by email — the invitee hasn't logged into Narrative yet. */
export interface DeckInvite {
  id: string
  email: string
  role: 'owner' | 'editor' | 'viewer'
  invitedAt: string
  expiresAt: string
}

export interface InviteByEmailBody {
  email: string
  role: 'owner' | 'editor' | 'viewer'
}

/** Server response on POST /decks/:id/permissions. */
export type InviteByEmailResult =
  | {
      kind: 'granted'
      user: {
        userId: string
        email: string
        name: string | null
        role: 'owner' | 'editor' | 'viewer'
      }
    }
  | {
      kind: 'pending'
      invite: {
        id: string
        email: string
        role: 'owner' | 'editor' | 'viewer'
        expiresAt: string
        replaced: boolean
      }
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

export function createApiClient(): ApiClient {
  async function request(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      // Sends the narrative_session cookie. In prod everything is same-origin
      // through Caddy so this is a no-op there; in dev (5173 → 3001) it
      // promotes the request to a same-site cross-origin fetch with cookies.
      credentials: 'include',
    })
    if (res.status === 401) {
      console.warn('[api] 401 — session missing or expired')
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

    inviteByEmail: async (deckId, body) => {
      const res = await request(`/decks/${deckId}/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        let detail: unknown
        try {
          detail = await res.json()
        } catch {
          /* ignore */
        }
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body: detail })
      }
      return (await res.json()) as InviteByEmailResult
    },

    revokePermission: async (deckId, userId) => {
      const res = await request(`/decks/${deckId}/permissions/${userId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    },

    listInvites: (deckId) => requestJson<DeckInvite[]>(`/decks/${deckId}/invites`),

    revokeInvite: async (deckId, inviteId) => {
      const res = await request(`/decks/${deckId}/invites/${inviteId}`, { method: 'DELETE' })
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

    listFolderActiveEditors: (folderId) =>
      requestJson<ActiveEditorsEntry[]>(`/folders/${folderId}/active-editors`),

    importPptx: async (file, folderId) => {
      const res = await request(`/folders/${folderId}/import-pptx`, {
        method: 'POST',
        // Raw .pptx body — server's content-type parser pipes it straight to a
        // Buffer. Filename is forwarded so the new deck inherits it as title.
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'X-Narrative-Filename': file.name,
        },
        body: file,
      })
      if (!res.ok) {
        // Surface server error text in the toast — it's the most useful thing
        // the UI can show (e.g. "Could not parse .pptx — not a ZIP archive").
        let body: unknown
        try {
          body = await res.json()
        } catch {
          body = {}
        }
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body })
      }
      return (await res.json()) as ImportPptxResult
    },

    appendPptx: async (file, deckId) => {
      const res = await request(`/decks/${deckId}/append-pptx`, {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'X-Narrative-Filename': file.name,
        },
        body: file,
      })
      if (!res.ok) {
        let body: unknown
        try {
          body = await res.json()
        } catch {
          body = {}
        }
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body })
      }
      return (await res.json()) as AppendPptxResult
    },

    // -------------------------------------------------------------------------
    // M16 P5 — Component methods
    // -------------------------------------------------------------------------

    listComponents: (folderId) =>
      requestJson<ComponentSummary[]>(`/folders/${folderId}/components`),

    createComponent: (folderId, opts) =>
      requestJson<ComponentSummary>(`/folders/${folderId}/components`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts ?? {}),
      }),

    renameComponent: (componentId, name) =>
      requestJson<ComponentSummary>(`/components/${componentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),

    deleteComponent: async (componentId) => {
      const res = await request(`/components/${componentId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    },

    uploadComponentThumbnail: (componentId, dataUrl) =>
      requestJson<ComponentSummary>(`/components/${componentId}/thumbnail`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      }),

    // -------------------------------------------------------------------------
    // M16 P3 — Folder font methods
    // -------------------------------------------------------------------------

    listFolderFonts: async (folderId) => {
      const data = await requestJson<{ fonts: FolderFontSummary[] }>(
        `/api/folders/${folderId}/fonts`,
      )
      return data.fonts
    },

    uploadFolderFont: async (folderId, file, opts) => {
      // file.type is inconsistent across browsers + OSes for font
      // files — Chrome/Windows sends 'application/vnd.ms-opentype'
      // for .otf, Firefox 'application/font-sfnt', Linux often empty.
      // Prefer extension-based inference so we hand the server a MIME
      // it has a registered content-type parser for; fall back to
      // file.type only when the extension is unrecognised. (The server
      // re-validates the bytes via opentype.js, so this is just
      // metadata to keep Fastify's parser layer happy.)
      const ext = file.name.toLowerCase().split('.').pop() ?? ''
      const extToMime: Record<string, string> = {
        ttf: 'font/ttf',
        otf: 'font/otf',
        woff: 'font/woff',
        woff2: 'font/woff2',
      }
      const mime =
        extToMime[ext] ??
        (file.type && file.type !== 'application/octet-stream' ? file.type : 'font/ttf')
      const arrayBuf = await file.arrayBuffer()
      // `familyOverride` reaches the server as a `?fontFamily=` query
      // param. The route uses it to stamp media_assets.font_family with
      // the PPTX-authored typeface name instead of the file's internal
      // `name` table value — so a missing-font upload binds to the
      // family the slide content actually references.
      const url =
        opts?.familyOverride !== undefined && opts.familyOverride !== ''
          ? `/api/folders/${folderId}/fonts?fontFamily=${encodeURIComponent(opts.familyOverride)}`
          : `/api/folders/${folderId}/fonts`
      const res = await request(url, {
        method: 'POST',
        headers: {
          'Content-Type': mime,
          'X-Filename': file.name,
        },
        body: arrayBuf,
      })
      if (!res.ok) {
        let body: unknown
        try {
          body = await res.json()
        } catch {
          body = {}
        }
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body })
      }
      return res.json() as Promise<FolderFontSummary>
    },

    deleteFolderFont: async (folderId, assetId) => {
      const res = await request(`/api/folders/${folderId}/fonts/${assetId}`, {
        method: 'DELETE',
      })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
      if (res.status === 200) {
        try {
          return (await res.json()) as { promotedToDeckCount: number }
        } catch {
          return { promotedToDeckCount: 0 }
        }
      }
      return { promotedToDeckCount: 0 }
    },

    listDeckFonts: async (deckId) => {
      const data = await requestJson<{ fonts: FolderFontSummary[] }>(`/api/decks/${deckId}/fonts`)
      return data.fonts
    },

    // -------------------------------------------------------------------------
    // M16 P4 — Token usage scanning
    // -------------------------------------------------------------------------

    listTokenUsages: async (folderId, category, tokenId) => {
      const data = await requestJson<{ usages: TokenUsage[] }>(
        `/folders/${folderId}/tokens/${encodeURIComponent(category)}/${encodeURIComponent(tokenId)}/usages`,
      )
      return data.usages
    },
  }
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export function useApi(): ApiClient {
  // The client is stateless now — same instance for the app's lifetime.
  return useMemo(() => createApiClient(), [])
}
