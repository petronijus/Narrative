/**
 * `DeckService` — defined here, implemented by apps/server/src/services/decks.ts.
 * See ../services.ts for the pattern: the HTTP routes under /decks and the
 * `deck.*` commands call these same methods.
 *
 * Failures are thrown as `CommandError` (the server throws a subclass that
 * also carries the HTTP status and body its route answers with).
 */

import type { DeckRole, DocumentRef, FontFaceInfo, ListKeyset } from './common.js'
import type { ObjectsMutationContext } from '@narrative/slide-model'
import type { InsertPlan } from '../insert/plan.js'

/** A deck row as the API returns it. Timestamps are ISO strings. */
export interface DeckRecord {
  id: string
  title: string
  ownerUserId: string
  folderId: string | null
  thumbnailKey: string | null
  thumbnailUpdatedAt: string | null
  /** Signed imgproxy URL of the deck thumbnail; null until one was rendered. */
  thumbnailUrl: string | null
  createdAt: string
  updatedAt: string
}

/** A deck plus the caller's effective role on it. */
export interface DeckWithRole extends DeckRecord {
  viewerRole: DeckRole
}

/** A freshly created deck: its document already holds one empty slide. */
export interface CreatedDeck extends DeckRecord {
  firstSlideId: string
}

/** A deck made by copying another one whole (`DeckService.duplicate`). */
export interface DuplicatedDeck extends DeckRecord {
  slideCount: number
  /** Media assets (images, videos, deck fonts) copied into the new deck. */
  mediaCopied: number
  /** Assets that could not be copied; their objects show a missing image. */
  skippedImages: number
  /** Token references rebound, when the copy landed in another folder. */
  tokens?: { rebound: number; literalised: number; detached: number; unmatched: number }
}

/**
 * A deck in a paged list: only what finding a deck needs (the agent's
 * `deck.list`; the full record is `get`).
 */
export interface DeckListItem {
  id: string
  title: string
  folderId: string | null
  /**
   * ISO timestamp of the deck's last change: its content (the latest stored
   * document state), its title or its folder — whichever is newest.
   */
  updatedAt: string
  /** The caller's effective role on the deck. */
  role: DeckRole
}

export interface DeckListPageArgs {
  userId: string
  /** Only decks in this folder, which must be the caller's own (as in `list`). */
  folderId?: string | undefined
  /** Only decks whose title contains this text, ignoring case (matched literally). */
  query?: string | undefined
  /** Page size, 1 to MAX_LIST_PAGE_SIZE. */
  limit: number
  /** Continue after this position (a previous page's `next`). */
  after?: ListKeyset | undefined
}

export interface DeckListPage {
  /** Most recently changed first (`updatedAt` descending, then id descending). */
  decks: DeckListItem[]
  /** Where the next page starts; null when this page is the last. */
  next: ListKeyset | null
}

export interface ActiveEditorsEntry {
  deckId: string
  users: Array<{ userId: string; email: string | null; name: string | null }>
}

/**
 * What moving a deck did to its token references (see
 * apps/server/src/services/tokenRebind.ts for the rule): references to a
 * source-folder token are pointed at the destination token of the same
 * category and name; without one, a colour reference becomes its literal
 * colour and a text-style link is detached (the text keeps its formatting).
 */
export interface TokenRebindReport {
  deckId: string
  /** References now pointing at a same-named destination token. */
  rebound: number
  /** Colour references replaced by their literal value (no same-named token). */
  literalised: number
  /** Text-style links removed (no same-named text style). */
  detached: number
  /** References left untouched: dangling already, or an effect style without a match. */
  unmatched: number
  /** Set when the document could not be rewritten; the move itself still happened. */
  error?: string
}

/**
 * What moving a deck to another folder did to the pictures and videos it
 * linked from its old folder (its components', the folder's own): they are
 * copied into the deck before it moves, so the new folder's readers can load
 * them (apps/server/src/services/localiseMedia.ts). A copy that fails before
 * the move stops it; what a collaborator linked during the move is caught up
 * afterwards and reported here.
 */
export interface MovedDeckMedia {
  deckId: string
  /**
   * Pictures and videos taken along: copied into the deck, its references
   * pointed at the copies (a copy an earlier, failed attempt made is reused
   * and counted).
   */
  copied: number
  /** References that stay broken: their asset is gone or another deck's (they were broken before). */
  unresolved: number
  /** Copies that failed after the deck had moved: those references show nothing in the new folder. */
  copyFailed: number
  /** Set when the catch-up after the move failed as a whole; the move itself still happened. */
  error?: string
}

export interface MoveDecksResult {
  movedCount: number
  tokens: TokenRebindReport[]
  /** One entry per moved deck when the folder changed (empty otherwise). */
  media: MovedDeckMedia[]
}

export interface DeckRecordsPageArgs {
  userId: string
  /** Only decks in this folder (as in `list`). */
  folderId?: string | undefined
  /** Page size, 1 to MAX_LIST_PAGE_SIZE. */
  limit: number
  /** Continue after this position (a previous page's `next`). */
  after?: ListKeyset | undefined
}

export interface DeckRecordsPage {
  /** `list`'s records in `list`'s order: created first, then id. */
  decks: DeckWithRole[]
  /** Where the next page starts; null when this page is the last. */
  next: ListKeyset | null
}

export interface DeckService {
  /**
   * Decks the user can open, optionally only those in one of the user's
   * folders; oldest first (created, then id).
   */
  list(args: { userId: string; folderId?: string | undefined }): Promise<DeckWithRole[]>
  /**
   * `list` keyset-paged: the same records in the same order, so the pages
   * put together are `list` (GET /decks?limit=&cursor=, for a deck grid
   * that should not wait for a folder of hundreds of decks).
   */
  listRecordsPage(args: DeckRecordsPageArgs): Promise<DeckRecordsPage>
  /**
   * The same decks as `list`, as lean items, filtered, sorted by last change
   * (newest first) and keyset-paged — for callers that cannot take the whole
   * list at once (the agent's `deck.list`). `list` keeps serving the web app.
   */
  listPage(args: DeckListPageArgs): Promise<DeckListPage>
  /** One deck; `userId` may be null when a share token grants access. */
  get(args: {
    userId: string | null
    deckId: string
    shareToken?: string | null | undefined
  }): Promise<DeckWithRole>
  /**
   * Create a deck (in `folderId`, which the user must own, else in their
   * Drafts folder) together with its first document state: one empty slide,
   * so it can be edited right away without a browser having opened it.
   */
  create(args: {
    userId: string
    title?: string | undefined
    folderId?: string | undefined
  }): Promise<CreatedDeck>
  /**
   * Copy a deck whole into a NEW deck the user owns: every slide with its
   * objects, animations, notes and outline, the deck guides, and the media
   * the slides show (copied, since media is deck-scoped). Needs editor access
   * to the source (copying is exporting). Lands in `folderId` (which the user
   * must own), else the source's folder when the user owns it, else Drafts;
   * across folders token references are rebound like `moveDecks` does.
   * Sharing is not copied: the copy is the user's alone.
   */
  duplicate(args: {
    userId: string
    deckId: string
    title?: string | undefined
    folderId?: string | undefined
  }): Promise<DuplicatedDeck>
  rename(args: { deckId: string; title: string }): Promise<DeckRecord>
  /**
   * Delete the deck, its document, permissions, share links and media (rows
   * and storage). `userId`: who deletes it — everyone else it was shared with
   * is told by email.
   */
  delete(args: { deckId: string; userId?: string }): Promise<void>
  /**
   * Move decks from one folder to another — the user needs the owner role on
   * every deck and the editor role in both folders — copying the media each
   * deck links from the source folder into it first (`media`), and rebind
   * the decks' token references to the destination folder's tokens.
   * `origin` is the Yjs transaction origin of the document rewrites.
   */
  moveDecks(args: {
    userId: string
    sourceFolderId: string
    deckIds: readonly string[]
    destFolderId: string
    origin?: unknown
  }): Promise<MoveDecksResult>
  /** `moveDecks` for one deck, from whichever folder it is in now. */
  moveDeck(args: {
    userId: string
    deckId: string
    destFolderId: string
    origin?: unknown
  }): Promise<MoveDecksResult>
  /** Who has each deck of the folder open right now (folder members only). */
  activeEditors(args: { userId: string; folderId: string }): Promise<ActiveEditorsEntry[]>
  /**
   * Fonts bound to the deck itself (copies made when a folder font the deck
   * may use was deleted). The folder's own fonts are `FolderService.listFonts`.
   */
  listFonts(args: { deckId: string }): Promise<FontFaceInfo[]>
  /**
   * Stage objects read from another document (planned by `planInsert`) for
   * insertion into `target`: the pictures and videos the target may not
   * show are copied into it (a deck, or a component master, owns its media;
   * its folder's component media stays linked), the source deck's own fonts
   * too between decks, token references rebound when the folders differ,
   * and links to the source's slides removed. Copying out of a deck needs
   * editor access to it (it is exporting it); out of a component a role in
   * its folder (editor into another folder); into a component the editor
   * role. Linked media is copied for whoever may read its folder.
   */
  prepareObjectInsert(args: {
    userId: string
    source: DocumentRef
    target: DocumentRef
    plan: InsertPlan
  }): Promise<PreparedObjectInsert>
}

export interface ObjectInsertResult {
  objectIds: string[]
  /** Media rows registered for the target, copied from the source. */
  mediaRegistered: number
  /** Pictures and videos left unresolved: not copied (unreadable, gone) or failed to copy. */
  skippedImages: number
  /** Links to slides of the source deck (removed: they do not exist here). */
  droppedLinks: number
  /** Across folders: what happened to token references (deck.moveToFolder's rule). */
  tokens?: { rebound: number; literalised: number; detached: number; unmatched: number }
}

/**
 * Objects staged for insertion (media registered under the target);
 * `apply` adds them to a slide synchronously, inside the host's one
 * transaction. `discard` releases the staged media when `apply` will not run;
 * `settle`, once the write committed, carries the media the objects link from
 * the target deck's folder into the deck if it changed folders meanwhile.
 */
export interface PreparedObjectInsert {
  apply(objects: ObjectsMutationContext): ObjectInsertResult
  discard(): Promise<void>
  /** After the write. Best effort: never throws. */
  settle(): Promise<void>
}
