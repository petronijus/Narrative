/**
 * `FolderService` — defined here, implemented by apps/server/src/services/folders.ts.
 * See ../services.ts for the pattern: the /folders and /api/folders/:id/fonts
 * routes and the `folder.*` commands call these same methods.
 */

import type { Role } from '../types.js'
import type { BinarySource, FontFaceInfo, ListKeyset } from './common.js'

/** A folder in the list view. */
export interface FolderSummary {
  id: string
  name: string
  /** ISO timestamp. */
  createdAt: string
  deckCount: number
  /** The caller's role in the folder: viewer reads it, editor changes it, owner also shares and deletes it. */
  role: Role
  /** Who shared the folder with the caller (folder sharing); null for a folder they created. */
  sharedBy: { name: string | null; email: string | null } | null
  /** The caller's private Drafts folder: never shared, never deleted. */
  isDrafts: boolean
}

export interface FolderListPageArgs {
  userId: string
  /** Only folders whose name contains this text, ignoring case (matched literally). */
  query?: string | undefined
  /** Page size, 1 to MAX_LIST_PAGE_SIZE. */
  limit: number
  /** Continue after this position (a previous page's `next`). */
  after?: ListKeyset | undefined
}

export interface FolderListPage {
  /** By name A→Z ignoring case, then id. */
  folders: FolderSummary[]
  /** Where the next page starts; null when this page is the last. */
  next: ListKeyset | null
}

/** A folder row. */
export interface FolderRecord {
  id: string
  ownerUserId: string
  name: string
  createdAt: string
}

export interface FolderService {
  /** The folders the caller is a member of, each with their role in it. */
  list(args: { userId: string }): Promise<FolderSummary[]>
  /**
   * The caller's folders (the ones they are a member of), filtered, sorted by name and keyset-paged — for the
   * agent's `folder.list`. `list` keeps serving the web app.
   */
  listPage(args: FolderListPageArgs): Promise<FolderListPage>
  /** A new folder, the caller its owner. */
  create(args: {
    userId: string
    name: string
  }): Promise<FolderRecord & { deckCount: number; role: Role; sharedBy: null; isDrafts: false }>
  rename(args: { userId: string; folderId: string; name: string }): Promise<FolderRecord>
  /** Delete the folder and every deck in it. The Drafts folder cannot be deleted. */
  delete(args: { userId: string; folderId: string }): Promise<{ deletedDeckCount: number }>
  /** The folder's fonts: its members, its decks' guests, and a share-link visitor of one of its decks. */
  listFonts(args: {
    userId: string | null
    folderId: string
    shareToken?: string | null | undefined
  }): Promise<FontFaceInfo[]>
  /**
   * Add a font file (TTF / OTF / WOFF / WOFF2, at most 10 MB) to the folder.
   * `familyOverride` binds it to a family name other than the one in the file.
   */
  uploadFont(args: {
    userId: string
    folderId: string
    source: BinarySource
    familyOverride?: string | undefined
  }): Promise<FontFaceInfo>
  /**
   * Remove a folder font. Every deck in the folder gets a deck-scoped copy
   * so it keeps rendering.
   */
  deleteFont(args: {
    userId: string
    folderId: string
    assetId: string
  }): Promise<{ promotedToDeckCount: number }>
}
