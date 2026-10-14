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

import { withShareToken } from '../lib/shareToken.js'
import { API_URL } from '../lib/endpoints.js'
import { useMemo } from 'react'
import type {
  AgentRunSummary,
  RevertRunResult,
  EditableTokenCategory,
  TokenCategory,
  TokenPropagation,
} from '@narrative/commands'

/**
 * The document whose agent runs the Agent activity popover lists: a deck, or
 * a component master (agents edit masters too, and their runs revert the
 * same way).
 */
export type AgentRunTarget = { deckId: string } | { componentId: string }

// ---------------------------------------------------------------------------
// Core request function
// ---------------------------------------------------------------------------

export interface ApiClient {
  /** List decks. Pass `folderId` to filter to a specific folder. */
  listDecks(opts?: { folderId?: string }): Promise<DeckSummary[]>
  /**
   * Fetch a single deck by id, with the caller's role (`viewerRole`). With
   * `shareToken` it answers an anonymous share-link visitor too — the one
   * REST read a share link reaches.
   */
  getDeck(id: string, opts?: { shareToken?: string }): Promise<DeckSummary>
  /** Create a deck. Omit `folderId` to land in the caller's Drafts folder. */
  createDeck(title?: string, folderId?: string): Promise<DeckSummary>
  renameDeck(id: string, title: string): Promise<DeckSummary>
  /**
   * Copy a deck whole into a new deck of the caller (`deck.duplicate`):
   * slides, notes, guides and the media they show. Lands in the deck's
   * folder when the caller owns it, else in their Drafts.
   */
  duplicateDeck(id: string, body?: { title?: string; folderId?: string }): Promise<DeckSummary>
  deleteDeck(id: string): Promise<void>
  /**
   * P15: upload (or replace) the home-page preview thumbnail for a deck.
   * `dataUrl` must be a base64 data: URL of an image/jpeg or image/png.
   * Server caps the decoded payload at ~1 MB.
   */
  uploadDeckThumbnail(id: string, dataUrl: string): Promise<DeckSummary>
  /**
   * One slide as a PNG (1920×1080), rendered on the server by the render
   * worker from the live deck (`deck.exportPng`, agentic A3): the file and
   * the name the server gives it.
   */
  exportSlidePng(deckId: string, slideId: string): Promise<{ blob: Blob; filename: string }>
  /**
   * The deck as one PDF, rendered on the server (`deck.exportPdf`, agentic
   * A5.6; skipped slides left out): the file and the name the server gives it.
   */
  exportDeckPdf(deckId: string): Promise<{ blob: Blob; filename: string }>
  /**
   * Copy chosen slides of another deck into `deckId` at `at` (the slides
   * panel's cross-deck paste). The server checks editor access to the source
   * deck, copies the media the slides show and rebinds token references
   * across folders. Rejects with an `ApiError` carrying the server's reason.
   */
  insertSlidesFromDeck(
    deckId: string,
    body: { sourceDeckId: string; slideIds: string[]; at?: number },
  ): Promise<{ slideIds: string[]; insertedAt: number }>
  /**
   * Paste objects read from another deck (query.slide JSON) onto slide
   * `slideId` of `deckId` (the canvas's cross-deck paste, the server's
   * `object.insertFromDeck`): the pictures, videos and fonts they use are
   * copied into `deckId` and tokens rebound across folders. Rejects with an
   * `ApiError` carrying the server's reason.
   */
  /**
   * The cross-document paste (`object.insertFromDeck`): objects read from
   * `source` onto a slide of `target` — each a deck or a component master —
   * with their pictures and videos copied into the target.
   */
  insertObjectsFrom(
    target: DocumentRef,
    body: {
      source: DocumentRef
      slideId: string
      objects: Record<string, unknown>[]
      offset?: { x: number; y: number }
      at?: { x: number; y: number }
    },
  ): Promise<{ objectIds: string[] }>
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
  /** The folders the signed-in user is a member of, each with a deckCount and their role. */
  listFolders(): Promise<FolderSummary[]>
  /** Create a new folder. */
  createFolder(name: string): Promise<FolderSummary>
  /** Rename a folder (folder owner). */
  renameFolder(id: string, name: string): Promise<FolderSummary>
  /**
   * Delete a folder.
   * Throws with status 409 if folder is non-empty ({ error: 'folder_not_empty', deckCount }).
   * Throws with status 409 if folder is the user's Drafts ({ error: 'cannot_delete_drafts' }).
   */
  deleteFolder(id: string): Promise<void>
  // Folder sharing (folder owner): members see everything in the folder.
  listFolderMembers(folderId: string): Promise<DeckPermission[]>
  /** A known address becomes a member at once; anyone else gets a pending invite and an email. */
  inviteToFolder(folderId: string, body: InviteByEmailBody): Promise<InviteByEmailResult>
  setFolderMemberRole(
    folderId: string,
    userId: string,
    role: 'owner' | 'editor' | 'viewer',
  ): Promise<void>
  removeFolderMember(folderId: string, userId: string): Promise<void>
  listFolderInvites(folderId: string): Promise<DeckInvite[]>
  cancelFolderInvite(folderId: string, inviteId: string): Promise<void>
  /**
   * Bulk-move decks from srcFolderId to destFolderId: the caller owns every
   * deck and is an editor of both folders; the decks must live in
   * srcFolderId. Returns how many moved and, per deck, the linked pictures
   * and videos taken along (`media`; a copy that failed after the deck had
   * moved shows nothing in the new folder).
   */
  moveDecks(srcFolderId: string, deckIds: string[], destFolderId: string): Promise<MoveDecksResult>
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

  // ---------------------------------------------------------------------------
  // M16 P5 — Component API
  // ---------------------------------------------------------------------------
  /** List components in a folder (folder members). */
  listComponents(folderId: string): Promise<ComponentSummary[]>
  /**
   * `component.promote`: objects of a slide become a new component of the
   * deck's folder; the server builds the master and copies the pictures and
   * videos into the component. The server reads the deck live, so call it
   * once it holds the slide's latest changes (`useSlideDoc().whenSaved`).
   */
  promoteComponent(
    deckId: string,
    body: { slideId: string; objectIds: string[]; name: string },
  ): Promise<PromotedComponent>
  /**
   * `component.stamp`: the server stamps the master onto a slide (its
   * pictures and videos copied into the deck). The stamp reaches the editor
   * as a remote change; the ids are the stamped objects in stacking order.
   */
  stampComponent(
    deckId: string,
    body: { componentId: string; slideId: string; at?: { x: number; y: number } },
  ): Promise<{ objectIds: string[] }>
  /** Rename a component (folder editors). */
  renameComponent(componentId: string, name: string): Promise<ComponentSummary>
  /** Delete a component and cascade its update log (folder editors). Caller handles instance cleanup. */
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
  /**
   * Add a token to the folder document (`fields` as the `token.create`
   * command takes them, without the category). Resolves with its id once
   * the server has written it; the folder document brings it to every
   * editor. Throws `ApiError` (400 invalid fields, 409 colour cap).
   */
  createToken(
    folderId: string,
    category: EditableTokenCategory,
    fields: Record<string, unknown>,
  ): Promise<string>
  /**
   * Change a token (`null` removes an optional field). The server carries
   * the change into every deck and component master of the folder before
   * it answers. Throws `ApiError`.
   */
  updateToken(
    folderId: string,
    category: EditableTokenCategory,
    tokenId: string,
    patch: Record<string, unknown>,
  ): Promise<TokenPropagation>
  /** Remove a token. Throws `ApiError` (404 unknown, 409 a built-in text style). */
  deleteToken(folderId: string, category: TokenCategory, tokenId: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Agentic A1 — personal access tokens (session cookie only)
  // ---------------------------------------------------------------------------
  /** The signed-in user's personal access tokens (never the secret). */
  listAccessTokens(): Promise<AccessTokenSummary[]>
  /**
   * Create a personal access token. The raw `token` in the result is shown
   * once and can never be fetched again. Throws with `status` + `body`
   * (`{ error, message }`) on 400 (invalid input) and 409 (token cap).
   */
  createAccessToken(body: CreateAccessTokenBody): Promise<CreatedAccessToken>
  /** Revoke one of the user's tokens. Idempotent (a 404 counts as done). */
  revokeAccessToken(id: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Agentic A1 — connected apps: MCP OAuth connections (session cookie only)
  // ---------------------------------------------------------------------------
  /** The signed-in user's live OAuth connections (claude.ai connectors, …), newest first. */
  listOAuthConnections(): Promise<OAuthConnection[]>
  /**
   * Disconnect an app: revokes the connection's grant and every token of it,
   * and ends its open MCP sessions. Idempotent (a 404 counts as done).
   */
  disconnectOAuthConnection(id: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Agentic A1 — confirmation page (session cookie only)
  // ---------------------------------------------------------------------------
  /** A pending agent request of the signed-in user; null when unknown or not theirs. */
  getAgentConfirmation(id: string): Promise<AgentConfirmation | null>
  /**
   * Approve or decline it. Resolves to the updated confirmation; throws
   * `ApiRequestError` (409 when it expired or was already answered).
   */
  decideAgentConfirmation(id: string, decision: 'approve' | 'decline'): Promise<AgentConfirmation>

  // ---------------------------------------------------------------------------
  // Agentic A1 — Agent activity popover (editor role on the deck)
  // ---------------------------------------------------------------------------
  /**
   * Recent agent runs on a deck or a component master, newest first. Throws
   * `ApiRequestError` (403 for viewers).
   */
  listAgentRuns(target: AgentRunTarget, limit?: number): Promise<AgentRunSummary[]>
  /**
   * Revert an agent run (or only its last `lastOps` changes). Throws
   * `ApiRequestError` carrying the server's message — 409 when the run is
   * no longer revertible (already reverted, unloaded, expired), 404, 403.
   */
  revertAgentRun(runId: string, lastOps?: number): Promise<RevertRunResult>

  // ---------------------------------------------------------------------------
  // Agentic A4.6 — a folder's style pack (Folder Settings)
  // ---------------------------------------------------------------------------
  /**
   * Run a folder command through the command API (`POST /commands`, the
   * door scripts and agents use), as the signed-in user: `style.pack.get`,
   * `style.pack.edit`. Its result; throws `ApiRequestError` with the
   * command's own message (400 with what is invalid, 403, 404).
   */
  runFolderCommand<T>(folderId: string, command: string, input: unknown): Promise<T>
}

/**
 * A failed request whose response carried the command API's error body
 * (`{ ok: false, error: { code, message } }`). `message` is the server's
 * own sentence, written to be shown to the user.
 */
export class ApiRequestError extends Error {
  readonly status: number
  readonly code: string | null
  constructor(status: number, code: string | null, message: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
  }
}

/** Build an `ApiRequestError` from a failed response, falling back to `HTTP <status>`. */
async function apiRequestError(res: Response): Promise<ApiRequestError> {
  let code: string | null = null
  let message = `HTTP ${res.status}`
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } }
    if (typeof body.error?.code === 'string') code = body.error.code
    if (typeof body.error?.message === 'string' && body.error.message !== '') {
      message = body.error.message
    }
  } catch {
    /* non-JSON body — keep the status text */
  }
  return new ApiRequestError(res.status, code, message)
}

// ---------------------------------------------------------------------------
// Agentic A1 — personal access token types
// ---------------------------------------------------------------------------

export type AccessTokenScope = 'mcp' | 'api'

export interface AccessTokenSummary {
  id: string
  name: string
  /** First characters of the token (`nrt_` + 6), to recognise it. */
  prefix: string
  scopes: AccessTokenScope[]
  createdAt: string
  lastUsedAt: string | null
  /** Every token expires, at most a year after creation. */
  expiresAt: string
  expired: boolean
}

/** The expiry choices the server accepts, in days. */
export const ACCESS_TOKEN_EXPIRY_DAYS = [30, 90, 365] as const
export type AccessTokenExpiryDays = (typeof ACCESS_TOKEN_EXPIRY_DAYS)[number]

export interface CreateAccessTokenBody {
  name: string
  scopes: AccessTokenScope[]
  /** 30, 90 or 365 — there is no "never". */
  expiresInDays: AccessTokenExpiryDays
}

export interface CreatedAccessToken {
  /** The raw token. Shown once; the server keeps only its hash. */
  token: string
  accessToken: AccessTokenSummary
}

// ---------------------------------------------------------------------------
// Agentic A1 — connected apps (MCP OAuth connections)
// ---------------------------------------------------------------------------

/** An app the user connected to Narrative through OAuth (GET /oauth/connections). */
export interface OAuthConnection {
  /** The grant id; DELETE /oauth/connections/:id disconnects it. */
  id: string
  /** The name the app registered with (self-asserted by the app). */
  clientName: string
  /** Hosts of the app's registered callbacks — where sign-ins were sent back to. */
  redirectHosts: string[]
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  /**
   * Set when one of the app's refresh tokens was used twice — a sign its
   * credentials may have been copied (the server revokes the connection when
   * the second use did not come from the app itself). Null otherwise.
   */
  flaggedAt: string | null
  /** Why it was flagged, in words; null when not flagged. */
  flagReason: string | null
}

/**
 * An agent request waiting for the user's confirmation
 * (GET /agent-confirmations/:id). Everything in `summary` was built by the
 * server from the exact call, never from text the agent wrote.
 */
export interface AgentConfirmation {
  id: string
  status: 'pending' | 'approved' | 'declined' | 'used' | 'expired'
  summary: {
    commandId: string
    title: string
    action: string
    target: { kind: 'deck' | 'component' | 'folder' | 'account'; label: string | null }
    details: Array<{ label: string; value: string }>
    reasons: Array<'irreversible' | 'url_fetch'>
    hosts: string[]
    clientName: string | null
  }
  createdAt: string
  expiresAt: string
  decidedAt: string | null
}

/**
 * Public URL of the MCP endpoint, derived from the API base the SPA talks to
 * (prod `https://<domain>/api` → `https://<domain>/api/mcp`; Caddy strips
 * `/api`, so the server route is `/mcp`).
 */
export function mcpEndpointUrl(): string {
  return `${API_URL.replace(/\/+$/, '')}/mcp`
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
  /** The caller's role in the folder: viewer reads it, editor changes it, owner also shares and deletes it. */
  role: 'owner' | 'editor' | 'viewer'
  /** Who shared the folder with the caller (folder sharing); null for a folder they created. */
  sharedBy: { name: string | null; email: string | null } | null
  /** The user's private Drafts folder: never shared, never deleted. */
  isDrafts: boolean
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

/** What moving decks did (services/decks.ts `moveDecks`). */
export interface MoveDecksResult {
  movedCount: number
  /** Per moved deck, when the folder changed: the linked media it took along. */
  media?: Array<{
    deckId: string
    copied: number
    unresolved: number
    /** Copies that failed after the deck had moved: those pictures show nothing there. */
    copyFailed: number
    /** The pass after the move failed as a whole (the move itself happened). */
    error?: string
  }>
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
  /** Slides inserted, not the deck's new total. */
  appendedSlides: number
  objectsCreated: number
  skipped: { images: number; unknownShapes: number }
  ignoredElements: string[]
  slideWidth: number
  slideHeight: number
  /** Index the first inserted slide actually landed at, after the server
   *  clamped the requested one. The panel selects this slide when the
   *  import finishes, which would be wrong if it assumed its own index. */
  insertedAt: number
}

// ---------------------------------------------------------------------------
// M16 P5 — Folder component types
// ---------------------------------------------------------------------------

/** A document objects live in: a deck, or a component master. */
export type DocumentRef = { deckId: string } | { componentId: string }

export interface ComponentSummary {
  id: string
  folderId: string
  name: string
  createdAt: string
  updatedAt: string
  /** Signed imgproxy URL. NULL until the editor uploads a first thumbnail. */
  thumbnailUrl?: string | null
}

/** What POST /decks/:id/promote-component made (`component.promote`). */
export interface PromotedComponent {
  component: ComponentSummary
  objectCount: number
  /** Pictures and videos copied into the component. */
  mediaCopied: number
  /** Pictures whose file could not be copied. */
  skippedImages: number
  /** Links to slides, removed (a master has no slides). */
  droppedLinks: number
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
  /** A variable face's weight and width axis ranges, [min, max] (A4.2c). */
  axes?: { wght?: [number, number]; wdth?: [number, number] }
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
  playbackUrl: string | null
  transcodeError: string | null
}

/** A refused request, with the status and the server's own explanation (`{ error }`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function apiError(res: Response): Promise<ApiError> {
  let message = `HTTP ${res.status}`
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error !== '') message = body.error
  } catch {
    // not JSON — keep the status line
  }
  return new ApiError(res.status, message)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * The file name of an attachment response: RFC 5987 `filename*=UTF-8''…`
 * when present (the server sends it for every name), else `filename="…"`.
 */
export function attachmentFilename(res: Response, fallback: string): string {
  const header = res.headers.get('content-disposition') ?? ''
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1]
  if (extended !== undefined) {
    try {
      return decodeURIComponent(extended)
    } catch {
      // A malformed escape: fall back to the plain name.
    }
  }
  return /filename="([^"]+)"/.exec(header)?.[1] ?? fallback
}

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

    getDeck: (id, opts) =>
      requestJson<DeckSummary>(
        opts?.shareToken === undefined
          ? `/decks/${id}`
          : `/decks/${id}?share_token=${encodeURIComponent(opts.shareToken)}`,
      ),

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

    duplicateDeck: async (id, body = {}) => {
      const res = await request(`/decks/${id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await apiError(res)
      return (await res.json()) as DeckSummary
    },

    deleteDeck: async (id) => {
      const res = await request(`/decks/${id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    },

    insertSlidesFromDeck: async (deckId, body) => {
      const res = await request(`/decks/${deckId}/insert-slides`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await apiError(res)
      return (await res.json()) as { slideIds: string[]; insertedAt: number }
    },

    insertObjectsFrom: async (target, { source, ...rest }) => {
      const path =
        'deckId' in target
          ? `/decks/${target.deckId}/insert-objects`
          : `/components/${target.componentId}/insert-objects`
      const res = await request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...('deckId' in source
            ? { sourceDeckId: source.deckId }
            : { sourceComponentId: source.componentId }),
          ...rest,
        }),
      })
      if (!res.ok) throw await apiError(res)
      return (await res.json()) as { objectIds: string[] }
    },

    exportSlidePng: async (deckId, slideId) => {
      const res = await request(
        `/decks/${encodeURIComponent(deckId)}/export.png?slide=${encodeURIComponent(slideId)}`,
      )
      if (!res.ok) throw await apiError(res)
      return { blob: await res.blob(), filename: attachmentFilename(res, 'slide.png') }
    },

    exportDeckPdf: async (deckId) => {
      const res = await request(`/decks/${encodeURIComponent(deckId)}/export.pdf`)
      if (!res.ok) throw await apiError(res)
      return { blob: await res.blob(), filename: attachmentFilename(res, 'deck.pdf') }
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

    listFolderMembers: (folderId) => requestJson<DeckPermission[]>(`/folders/${folderId}/members`),

    // The folder sharing calls surface the server's message (apiError): it
    // says why a share was refused — the Drafts folder, your own role, the
    // last owner.
    inviteToFolder: async (folderId, body) => {
      const res = await request(`/folders/${folderId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await apiError(res)
      return (await res.json()) as InviteByEmailResult
    },

    setFolderMemberRole: async (folderId, userId, role) => {
      const res = await request(`/folders/${folderId}/members/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      })
      if (!res.ok) throw await apiError(res)
    },

    removeFolderMember: async (folderId, userId) => {
      const res = await request(`/folders/${folderId}/members/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw await apiError(res)
    },

    listFolderInvites: (folderId) => requestJson<DeckInvite[]>(`/folders/${folderId}/invites`),

    cancelFolderInvite: async (folderId, inviteId) => {
      const res = await request(`/folders/${folderId}/invites/${inviteId}`, { method: 'DELETE' })
      // Already accepted or cancelled: nothing left to cancel.
      if (!res.ok && res.status !== 404) throw await apiError(res)
    },

    moveDecks: (srcFolderId, deckIds, destFolderId) =>
      requestJson<MoveDecksResult>(`/folders/${srcFolderId}/move-decks`, {
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

    // -------------------------------------------------------------------------
    // M16 P5 — Component methods
    // -------------------------------------------------------------------------

    listComponents: (folderId) =>
      requestJson<ComponentSummary[]>(`/folders/${folderId}/components`),

    promoteComponent: async (deckId, body) => {
      const res = await request(`/decks/${deckId}/promote-component`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await apiError(res)
      return (await res.json()) as PromotedComponent
    },

    stampComponent: async (deckId, body) => {
      const res = await request(`/decks/${deckId}/stamp-component`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await apiError(res)
      return (await res.json()) as { objectIds: string[] }
    },

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
      // A share-link visit (or the render page) reads them with its token.
      const data = await requestJson<{ fonts: FolderFontSummary[] }>(
        withShareToken(`/api/folders/${folderId}/fonts`),
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
      const data = await requestJson<{ fonts: FolderFontSummary[] }>(
        withShareToken(`/api/decks/${deckId}/fonts`),
      )
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

    createToken: async (folderId, category, fields) => {
      const res = await request(`/folders/${folderId}/tokens/${encodeURIComponent(category)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      if (!res.ok) throw await apiError(res)
      return ((await res.json()) as { tokenId: string }).tokenId
    },

    updateToken: async (folderId, category, tokenId, patch) => {
      const res = await request(
        `/folders/${folderId}/tokens/${encodeURIComponent(category)}/${encodeURIComponent(tokenId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        },
      )
      if (!res.ok) throw await apiError(res)
      return ((await res.json()) as { propagated: TokenPropagation }).propagated
    },

    deleteToken: async (folderId, category, tokenId) => {
      const res = await request(
        `/folders/${folderId}/tokens/${encodeURIComponent(category)}/${encodeURIComponent(tokenId)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw await apiError(res)
    },

    // -------------------------------------------------------------------------
    // Agentic A1 — personal access tokens
    // -------------------------------------------------------------------------

    listAccessTokens: async () => {
      const data = await requestJson<{ tokens: AccessTokenSummary[] }>('/access-tokens')
      return data.tokens
    },

    createAccessToken: async (body) => {
      const res = await request('/access-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        let detail: unknown
        try {
          detail = await res.json()
        } catch {
          detail = {}
        }
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body: detail })
      }
      return (await res.json()) as CreatedAccessToken
    },

    revokeAccessToken: async (id) => {
      const res = await request(`/access-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    },

    // -------------------------------------------------------------------------
    // Agentic A1 — connected apps
    // -------------------------------------------------------------------------

    listOAuthConnections: async () => {
      const data = await requestJson<{ connections: OAuthConnection[] }>('/oauth/connections')
      return data.connections
    },

    disconnectOAuthConnection: async (id) => {
      const res = await request(`/oauth/connections/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
    },

    // -------------------------------------------------------------------------
    // Agentic A1 — confirmation page
    // -------------------------------------------------------------------------

    getAgentConfirmation: async (id) => {
      const res = await request(`/agent-confirmations/${encodeURIComponent(id)}`)
      if (res.status === 404) return null
      if (!res.ok) throw await apiRequestError(res)
      return (await res.json()) as AgentConfirmation
    },

    decideAgentConfirmation: async (id, decision) => {
      const res = await request(`/agent-confirmations/${encodeURIComponent(id)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      if (!res.ok) {
        let message = `HTTP ${res.status}`
        let code: string | null = null
        try {
          const body = (await res.json()) as { error?: unknown; message?: unknown }
          if (typeof body.error === 'string') code = body.error
          if (typeof body.message === 'string') message = body.message
        } catch {
          /* keep the status */
        }
        throw new ApiRequestError(res.status, code, message)
      }
      return (await res.json()) as AgentConfirmation
    },

    // -------------------------------------------------------------------------
    // Agentic A1 — Agent activity popover
    // -------------------------------------------------------------------------

    listAgentRuns: async (target, limit) => {
      const query = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`
      const base =
        'deckId' in target
          ? `/decks/${encodeURIComponent(target.deckId)}`
          : `/components/${encodeURIComponent(target.componentId)}`
      const res = await request(`${base}/agent-runs${query}`)
      if (!res.ok) throw await apiRequestError(res)
      const data = (await res.json()) as { runs: AgentRunSummary[] }
      return data.runs
    },

    runFolderCommand: async <T>(folderId: string, command: string, input: unknown) => {
      const res = await request('/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: { folderId }, command, input, client: 'Folder settings' }),
      })
      if (!res.ok) throw await apiRequestError(res)
      return ((await res.json()) as { result: T }).result
    },

    revertAgentRun: async (runId, lastOps) => {
      const res = await request(`/agent-runs/${encodeURIComponent(runId)}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lastOps === undefined ? {} : { lastOps }),
      })
      if (!res.ok) throw await apiRequestError(res)
      return (await res.json()) as RevertRunResult
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
