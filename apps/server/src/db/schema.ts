/**
 * db/schema.ts
 *
 * Drizzle ORM schema for Narrative database.
 *
 * Tables:
 *   decks            — presentation metadata (id, title, owner, timestamps)
 *   deck_updates     — append-only Yjs update log (bytea per update per deck)
 *   deck_permissions — per-deck role per user (M10)
 *   share_links      — view/edit tokens for public sharing (M10)
 *
 * Persistence strategy (M4):
 *   onLoadDocument  → load all updates for a deck and apply sequentially
 *   onStoreDocument → save current Y.Doc state as a new update row
 *
 * TODO(M22): version history — more sophisticated snapshot strategy
 * TODO(M29): compaction strategy — merge N old updates into 1 snapshot row
 *            so loadDocument is O(1) for decks with thousands of updates
 */

import {
  pgTable,
  text,
  timestamp,
  serial,
  index,
  customType,
  pgEnum,
  primaryKey,
  boolean,
  integer,
} from 'drizzle-orm/pg-core'

// Custom type for bytea (Yjs updates are Uint8Array)
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value)
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value)
  },
})

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * deck_role — role a user can hold on a deck.
 * Hierarchy: viewer < editor < owner.
 */
export const deckRoleEnum = pgEnum('deck_role', ['owner', 'editor', 'viewer'])

/**
 * media_asset_kind — discriminator between image and video assets.
 * Defaults to 'image' for backward compatibility with M11 rows.
 */
export const mediaAssetKindEnum = pgEnum('media_asset_kind', ['image', 'video', 'font'])

/**
 * media_transcode_status — lifecycle of ffmpeg transcode jobs (video only).
 * NULL for image assets.
 * Transitions: pending → processing → done | failed
 */
export const transcodeStatusEnum = pgEnum('media_transcode_status', [
  'pending',
  'processing',
  'done',
  'failed',
])

// ---------------------------------------------------------------------------
// folders — flat, owner-scoped folder list (M16 P1)
// ---------------------------------------------------------------------------

/**
 * Single-level folder that groups decks under an owner.
 * No parent_id — the hierarchy is intentionally flat.
 *
 * Every user has at least one "Drafts" folder; new decks land there by default.
 * Deleting a folder is only permitted when it contains no decks.
 */
export const folders = pgTable(
  'folders',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('folders_owner_user_id_idx').on(t.ownerUserId)],
)

// ---------------------------------------------------------------------------
// decks — metadata table
// ---------------------------------------------------------------------------

export const decks = pgTable(
  'decks',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull().default('Untitled Deck'),
    /** Denormalized primary owner for quick lookups. Mirrors deck_permissions owner row. */
    ownerUserId: text('owner_user_id').notNull(), // M4: always 'demo-user'; M10 phase 2: real JWT sub
    /**
     * M16 P1: folder this deck belongs to.
     * Every deck must be in exactly one folder. References folders(id).
     * ON DELETE RESTRICT prevents deleting a non-empty folder.
     */
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'restrict' }),
    /**
     * MinIO object key for the home-page deck preview thumbnail.
     * The editor uploads a JPEG snapshot of the first slide here so the
     * Landing grid can render previews on a fresh device / incognito.
     * NULL until the first thumbnail upload completes.
     */
    thumbnailKey: text('thumbnail_key'),
    thumbnailUpdatedAt: timestamp('thumbnail_updated_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [index('decks_folder_id_idx').on(t.folderId)],
)

// ---------------------------------------------------------------------------
// deck_updates — append-only Yjs update log
// ---------------------------------------------------------------------------

export const deckUpdates = pgTable(
  'deck_updates',
  {
    id: serial('id').primaryKey(),
    deckId: text('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    update: bytea('update').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('deck_updates_deck_id_idx').on(t.deckId),
    // Composite (deckId, id) supports the hot WHERE deckId=? ORDER BY id query
    // (onLoadDocument). Without it, planner uses the single-column index then
    // sorts.
    index('deck_updates_deck_id_id_idx').on(t.deckId, t.id),
  ],
)

// ---------------------------------------------------------------------------
// folder_updates — append-only Yjs update log for folder design-token docs (M16 P2)
// ---------------------------------------------------------------------------

/**
 * Stores Hocuspocus Y.Doc updates for folder-scoped design token documents.
 * Each folder has a doc named `folder:<folderId>` on the Hocuspocus server.
 * The Y.Doc layout: tokens Y.Map → colors/textStyles/effectStyles sub-maps.
 *
 * Mirrors deck_updates strategy: onLoadDocument applies all rows sequentially;
 * onStoreDocument appends the current state as a new row (debounced by Hocuspocus).
 */
export const folderUpdates = pgTable(
  'folder_updates',
  {
    id: serial('id').primaryKey(),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    update: bytea('update').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('folder_updates_folder_id_idx').on(t.folderId),
    index('folder_updates_folder_id_id_idx').on(t.folderId, t.id),
  ],
)

// ---------------------------------------------------------------------------
// deck_permissions — per-deck role per user (M10)
// ---------------------------------------------------------------------------

/**
 * Stores the explicit role a user holds on a deck.
 * Composite PK: (deck_id, user_id) — one row per user per deck.
 *
 * Intentional denormalization: decks.owner_user_id is kept for fast queries.
 * On deck creation, BOTH decks.owner_user_id AND a deck_permissions row
 * with role='owner' are written in the same transaction.
 */
export const deckPermissions = pgTable(
  'deck_permissions',
  {
    deckId: text('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(), // Google OIDC 'sub' claim (or 'demo-user' when BYPASS_AUTH=true)
    role: deckRoleEnum('role').notNull(),
    grantedAt: timestamp('granted_at').defaultNow().notNull(),
    /** userId of the granter; null when system/migration writes the row */
    grantedBy: text('granted_by'),
  },
  (t) => [
    primaryKey({ columns: [t.deckId, t.userId] }),
    index('deck_permissions_user_idx').on(t.userId),
  ],
)

// ---------------------------------------------------------------------------
// share_links — public-token-based access (M10)
// ---------------------------------------------------------------------------

export const shareLinks = pgTable(
  'share_links',
  {
    id: text('id').primaryKey(), // nanoid(21) — public token
    deckId: text('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    role: deckRoleEnum('role').notNull(), // typically 'viewer'; 'editor' allowed for public-edit links
    createdAt: timestamp('created_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at'), // null = never expires
    createdBy: text('created_by').notNull(),
    revoked: boolean('revoked').default(false).notNull(),
  },
  (t) => [index('share_links_deck_idx').on(t.deckId)],
)

// ---------------------------------------------------------------------------
// media_assets — uploaded media originals (M11)
// ---------------------------------------------------------------------------

/**
 * Tracks every uploaded original file associated with a deck.
 *
 * Lifecycle:
 *   - Row is inserted by the media agent on tus upload finalize (phase 2).
 *   - ON DELETE CASCADE from decks ensures rows are removed when a deck is deleted.
 *
 * KNOWN ISSUE (M11): When a deck is deleted, the cascade removes media_assets rows
 * but leaves the original files orphaned in MinIO. This is intentional for M11.
 * TODO(M29 or media phase 2): add a post-delete hook or periodic GC job to enqueue
 * bucket cleanup for all storageKey values belonging to the deleted deck.
 *
 * imgproxy variants (thumb, display, original) are generated on demand from the
 * original stored at storageKey — no variant rows needed here.
 */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: text('id').primaryKey(), // nanoid produced by media agent on upload start
    /**
     * Deck this asset belongs to. NULL for folder-scoped font assets (M16 P3).
     * ON DELETE CASCADE — when deck is deleted, all its media rows are removed.
     */
    deckId: text('deck_id').references(() => decks.id, { onDelete: 'cascade' }),
    /**
     * M16 P3: Folder this asset belongs to. NULL for deck-scoped assets.
     * When kind='font' and folder_id is set, the row is a folder-level font.
     * ON DELETE CASCADE — when folder is deleted, all folder fonts are removed.
     */
    folderId: text('folder_id').references(() => folders.id, { onDelete: 'cascade' }),
    uploaderUserId: text('uploader_user_id').notNull(),
    mimeType: text('mime_type').notNull(), // e.g. image/png, image/jpeg
    sizeBytes: integer('size_bytes').notNull(),
    /** Bucket key: decks/<deckId>/uploads/<id>/original.<ext> */
    storageKey: text('storage_key').notNull(),
    originalFilename: text('original_filename'),
    /** Image width in px — populated when mime is image/* and probe succeeds */
    width: integer('width'),
    /** Image height in px — populated when mime is image/* and probe succeeds */
    height: integer('height'),
    createdAt: timestamp('created_at').defaultNow().notNull(),

    // M12 additions — video support
    /** Discriminator: 'image' (default, backfilled) or 'video'. */
    kind: mediaAssetKindEnum('kind').notNull().default('image'),
    /** Video duration in seconds — populated by ffmpeg probe after transcode. */
    durationSec: integer('duration_sec'),
    /** S3/MinIO key for the HLS master playlist: decks/<deckId>/videos/<id>/master.m3u8 */
    hlsManifestKey: text('hls_manifest_key'),
    /** S3/MinIO key for the poster frame: decks/<deckId>/videos/<id>/poster.jpg */
    posterKey: text('poster_key'),
    /** S3/MinIO key for the sidebar thumbnail: decks/<deckId>/videos/<id>/thumb.jpg */
    thumbnailKey: text('thumbnail_key'),
    /**
     * Transcode job status — NULL for image assets.
     * Lifecycle: pending → processing → done | failed (set by BullMQ worker, phase 2).
     */
    transcodeStatus: transcodeStatusEnum('transcode_status'),
    /** Error message from ffmpeg when transcodeStatus = 'failed'. */
    transcodeError: text('transcode_error'),

    // P15 additions — custom font support. NULL for image / video rows;
    // populated from opentype.js parse on upload finalize when kind='font'.
    /** Canonical CSS family name (OpenType `name` table id 1 / 16). */
    fontFamily: text('font_family'),
    /** OS/2 usWeightClass — 100..900. Default 400 if the font omits it. */
    fontWeight: integer('font_weight'),
    /** 'normal' | 'italic' — derived from fsSelection ITALIC bit. */
    fontStyle: text('font_style'),
    /** Postscript name — uniquely identifies one face within a family. */
    fontPostscriptName: text('font_postscript_name'),
  },
  (t) => [
    index('media_assets_deck_idx').on(t.deckId),
    index('media_assets_folder_id_idx').on(t.folderId),
  ],
)

// ---------------------------------------------------------------------------
// components — master component metadata (M16 P5)
// ---------------------------------------------------------------------------

/**
 * One master component per row. The actual content lives in a Hocuspocus
 * Y.Doc named `component:<id>` backed by component_updates rows.
 *
 * The component is folder-scoped: ON DELETE CASCADE from folders ensures
 * all component rows (and their updates) are removed when the folder goes.
 *
 * thumbnail_key follows the same pattern as decks.thumbnail_key — NULL until
 * the editor uploads a first snapshot, then a MinIO object key.
 */
export const components = pgTable(
  'components',
  {
    id: text('id').primaryKey(),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default('Untitled component'),
    thumbnailKey: text('thumbnail_key'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [index('components_folder_id_idx').on(t.folderId)],
)

// ---------------------------------------------------------------------------
// component_updates — append-only Yjs update log for component:<id> docs (M16 P5)
// ---------------------------------------------------------------------------

/**
 * Stores Hocuspocus Y.Doc updates for component master documents.
 * Each component has a doc named `component:<componentId>` on the Hocuspocus
 * server. Mirrors deck_updates / folder_updates: onLoadDocument applies all
 * rows sequentially; onStoreDocument appends the current state as a new row.
 *
 * ON DELETE CASCADE from components keeps this clean when a component is
 * deleted via the REST API.
 */
export const componentUpdates = pgTable(
  'component_updates',
  {
    id: serial('id').primaryKey(),
    componentId: text('component_id')
      .notNull()
      .references(() => components.id, { onDelete: 'cascade' }),
    update: bytea('update').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('component_updates_component_id_idx').on(t.componentId),
    index('component_updates_component_id_id_idx').on(t.componentId, t.id),
  ],
)

// ---------------------------------------------------------------------------
// users — directory of every Google account that has signed in. Keyed by
// `sub` so it can join `deck_permissions.user_id`, `decks.owner_user_id`,
// `folders.owner_user_id`, etc. Outlives `sessions` (which get
// sweep-deleted).
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    /** Google OIDC `sub` claim — also the value stored in `*.user_id` columns. */
    sub: text('sub').primaryKey(),
    email: text('email').notNull(),
    name: text('name'),
    pictureUrl: text('picture_url'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  // Case-insensitive email uniqueness — see migration 0013 for the actual
  // `LOWER(email)` unique index (drizzle's plain unique() doesn't support
  // expressions). The index is enforced at the DB layer; ORM-side type only.
  () => [],
)

// ---------------------------------------------------------------------------
// deck_invites — pending invites by email. Converted to deck_permissions
// rows on the invitee's first /auth/callback.
// ---------------------------------------------------------------------------

export const deckInvites = pgTable(
  'deck_invites',
  {
    /** nanoid(12) — also forms the invite URL token. */
    id: text('id').primaryKey(),
    deckId: text('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    /** Stored lower-case on insert. */
    email: text('email').notNull(),
    role: deckRoleEnum('role').notNull(),
    invitedBySub: text('invited_by_sub').notNull(),
    invitedAt: timestamp('invited_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBySub: text('accepted_by_sub'),
  },
  (t) => [index('deck_invites_deck_id_idx').on(t.deckId)],
)

// ---------------------------------------------------------------------------
// sessions — server-side opaque session rows (replaces browser-PKCE flow).
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 hex of the raw cookie value; the raw value never lands in the DB. */
    idHash: text('id_hash').primaryKey(),
    userSub: text('user_sub').notNull(),
    userEmail: text('user_email').notNull(),
    userName: text('user_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [
    index('sessions_user_sub_idx').on(t.userSub),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
)

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Folder = typeof folders.$inferSelect
export type NewFolder = typeof folders.$inferInsert
export type FolderUpdate = typeof folderUpdates.$inferSelect
export type NewFolderUpdate = typeof folderUpdates.$inferInsert
export type Deck = typeof decks.$inferSelect
export type NewDeck = typeof decks.$inferInsert
export type DeckUpdate = typeof deckUpdates.$inferSelect
export type NewDeckUpdate = typeof deckUpdates.$inferInsert
export type DeckPermission = typeof deckPermissions.$inferSelect
export type NewDeckPermission = typeof deckPermissions.$inferInsert
export type ShareLink = typeof shareLinks.$inferSelect
export type NewShareLink = typeof shareLinks.$inferInsert
export type MediaAsset = typeof mediaAssets.$inferSelect
export type NewMediaAsset = typeof mediaAssets.$inferInsert
export type Component = typeof components.$inferSelect
export type NewComponent = typeof components.$inferInsert
export type ComponentUpdate = typeof componentUpdates.$inferSelect
export type NewComponentUpdate = typeof componentUpdates.$inferInsert
export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type DeckInvite = typeof deckInvites.$inferSelect
export type NewDeckInvite = typeof deckInvites.$inferInsert
