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
 * Persistence strategy (PERF-2 — snapshot-compaction; supersedes M4 append-only):
 *   Every *_updates row is a full, self-contained Y.Doc snapshot
 *   (`Y.encodeStateAsUpdate(doc)` with no target state vector).
 *   onStoreDocument  → insert the new snapshot, then delete older rows for that
 *                      doc in the SAME transaction (keep only the latest).
 *   onLoadDocument   → apply all remaining rows (normally one). Full snapshots
 *                      are idempotent/commutative, so old multi-row decks still
 *                      load correctly and compact on the next store.
 *   No schema change was needed for PERF-2; the tables stay append-shaped, the
 *   write path just prunes superseded rows. See docs/adr/0006-*.
 *
 * TODO(M22): version history — retain N snapshots / periodic checkpoints.
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
  bigserial,
  jsonb,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

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
 * Every user has one Drafts folder (`isDrafts`); new decks land there by
 * default. Deleting a folder deletes its decks; Drafts cannot be deleted.
 */
export const folders = pgTable(
  'folders',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    /**
     * The creator's private Drafts folder — never shared, never deleted;
     * new decks without a folder land there. A flag, not the name: folders
     * have several owners, any of whom may rename one (migration 0034, with
     * the partial unique index "one Drafts per owner").
     */
    isDrafts: boolean('is_drafts').notNull().default(false),
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
    // Composite (deckId, id): the load (WHERE deckId=? ORDER BY id), the
    // compaction (WHERE deckId=? AND id<?) and the cascade all use it. The
    // single-column deck_id index it made redundant went in 0038.
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
    // As deck_updates' (0011; the single-column index went in 0038).
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
// folder_permissions — who may see and change a folder (folder sharing)
// ---------------------------------------------------------------------------

/**
 * A folder member and their role (the deck roles): viewer looks and
 * presents, editor changes the folder's decks, components, tokens and
 * fonts, owner also shares and deletes the folder. The role applies to
 * everything in the folder (docs/plans/folder-sharing.md). The folder's
 * creator (`folders.owner_user_id`) is its first owner (migration 0030).
 */
export const folderPermissions = pgTable(
  'folder_permissions',
  {
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: deckRoleEnum('role').notNull(),
    grantedAt: timestamp('granted_at').defaultNow().notNull(),
    /** userId of the granter; null when the system or a migration writes the row */
    grantedBy: text('granted_by'),
  },
  (t) => [
    primaryKey({ columns: [t.folderId, t.userId] }),
    index('folder_permissions_user_idx').on(t.userId),
  ],
)

// ---------------------------------------------------------------------------
// deck_moved_media — the linked media a deck took along when it left a folder
// (folder sharing, step 2)
// ---------------------------------------------------------------------------

/**
 * One linked picture or video a deck referenced when it moved out of a
 * folder, and the copy the move made of it in the deck. A deck links its
 * folder's pictures and videos without owning them; the move copies them
 * into the deck, but an undo or an agent run's revert can bring an old
 * reference back. The server then only re-points it at `copyAssetId`
 * (services/localiseMedia.ts) — it never copies an asset without a row
 * here. A fresh copy is made only when the recorded copy is gone, at most
 * once per row (`recopiedAt`), on `movedByUserId`'s authority and copy
 * budget. The copy, the folder and the mover go to NULL when deleted.
 * Migration 0032.
 */
export const deckMovedMedia = pgTable(
  'deck_moved_media',
  {
    deckId: text('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    /** The linked asset the deck referenced (a reference documents may hold; may be deleted since). */
    sourceAssetId: text('source_asset_id').notNull(),
    /** The deck's copy of it; NULL once that copy was deleted. */
    copyAssetId: text('copy_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    /** The folder the asset belonged to when the deck left it; NULL once deleted. */
    fromFolderId: text('from_folder_id').references(() => folders.id, { onDelete: 'set null' }),
    /** Who moved the deck (`users.sub`); NULL once the account is gone, or for a principal with no users row. */
    movedByUserId: text('moved_by_user_id').references(() => users.sub, { onDelete: 'set null' }),
    movedAt: timestamp('moved_at').defaultNow().notNull(),
    /** Set when the server copied the asset once more because the recorded copy was gone. */
    recopiedAt: timestamp('recopied_at'),
  },
  (t) => [
    primaryKey({ columns: [t.deckId, t.sourceAssetId] }),
    index('deck_moved_media_copy_idx').on(t.copyAssetId),
    index('deck_moved_media_folder_idx').on(t.fromFolderId),
    index('deck_moved_media_mover_idx').on(t.movedByUserId),
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
 *   - DELETE /decks/:id and DELETE /folders/:id both call
 *     `purgeDeckBucketPrefix(db, deckId)` after the cascade so MinIO blobs
 *     under `decks/<deckId>/` (originals, HLS bundles, thumbnails,
 *     untracked HLS segments) are swept too — except files another media
 *     row still names, such as a pre-0009 folder font uploaded in the deck.
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
    /**
     * A2.12b: component master this asset belongs to (pictures and videos of
     * a master; keys under components/<id>/). NULL otherwise. Migration 0027.
     */
    componentId: text('component_id').references(() => components.id, { onDelete: 'cascade' }),
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
    /** S3/MinIO key for the progressive playback MP4: decks/<deckId>/videos/<id>/playback.mp4 */
    playbackKey: text('playback_key'),
    /** S3/MinIO key for the poster frame: decks/<deckId>/videos/<id>/poster.jpg */
    posterKey: text('poster_key'),
    /** S3/MinIO key for the sidebar thumbnail: decks/<deckId>/videos/<id>/thumb.jpg */
    thumbnailKey: text('thumbnail_key'),
    /**
     * 0039: the playback fitted into 1920×1080 for a video larger than that
     * (<prefix>/videos/<id>/present.mp4), and its size — what present mode
     * plays at 1080p or less (docs/plans/performance.md, P3). NULL for
     * smaller videos, images and videos transcoded before 0039.
     */
    presentPlaybackKey: text('present_playback_key'),
    presentWidth: integer('present_width'),
    presentHeight: integer('present_height'),
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
    /**
     * A4.2c: a variable font's axis ranges, `{ wght?: [min, max], wdth?:
     * [min, max] }`; `{}` for a static font; NULL until read (a font stored
     * before migration 0035, until the data migration reads it).
     */
    fontAxes: jsonb('font_axes').$type<{ wght?: [number, number]; wdth?: [number, number] }>(),
  },
  (t) => [
    index('media_assets_deck_idx').on(t.deckId),
    index('media_assets_folder_id_idx').on(t.folderId),
    index('media_assets_component_id_idx').on(t.componentId),
    // Composite (parent, kind) — hot-path lookups filter by (deck/folder,
    // kind). Created by migration 0015 (hand-written; see drizzle/README.md).
    index('media_assets_deck_kind_idx').on(t.deckId, t.kind),
    index('media_assets_folder_kind_idx').on(t.folderId, t.kind),
    // One owner at most: a deck, a component master or a folder (0028).
    check(
      'media_assets_one_owner',
      sql`num_nonnulls(${t.deckId}, ${t.componentId}, ${t.folderId}) <= 1`,
    ),
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
  (t) => [
    index('components_folder_id_idx').on(t.folderId),
    // The id is a storage key segment (components/<id>/…): the nanoid
    // alphabet only (0028, NOT VALID for rows from before the server chose ids).
    check('components_id_storage_safe', sql`${t.id} ~ '^[A-Za-z0-9_-]{1,64}$'`),
  ],
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
    // As deck_updates' (0011; the single-column index went in 0038).
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
    /**
     * Google's `email_verified` claim at the last sign-in (migration 0020).
     * NULL for accounts that have not signed in since the column was added;
     * treated as unverified until they do.
     */
    emailVerified: boolean('email_verified'),
    name: text('name'),
    pictureUrl: text('picture_url'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    /**
     * Instance admin (docs/adr/0014): owner of every folder and deck except
     * other people's Drafts, and manages who may use Narrative at all. Set by
     * `ADMIN_EMAILS` at sign-in or by another admin; never inferred.
     */
    isAdmin: boolean('is_admin').notNull().default(false),
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
// folder_invites — pending invites to a folder by email (folder sharing,
// step 3). Converted to folder_permissions rows on the invitee's
// /auth/callback, as deck_invites are. Migration 0033 (the partial unique
// index on (folder_id, LOWER(email)) WHERE accepted_at IS NULL lives there).
// ---------------------------------------------------------------------------

export const folderInvites = pgTable(
  'folder_invites',
  {
    /** nanoid(12). */
    id: text('id').primaryKey(),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    /** Stored lower-case on insert. */
    email: text('email').notNull(),
    role: deckRoleEnum('role').notNull(),
    invitedBySub: text('invited_by_sub').notNull(),
    invitedAt: timestamp('invited_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBySub: text('accepted_by_sub'),
  },
  (t) => [index('folder_invites_folder_id_idx').on(t.folderId)],
)

// ---------------------------------------------------------------------------
// allowed_emails — who may sign in, managed by instance admins (ADR 0014).
// Joins the env allowlist (OIDC_ALLOWED_EMAILS / OIDC_ALLOWED_DOMAIN) and the
// implicit invite / share grants in auth/signInPolicy.ts.
// ---------------------------------------------------------------------------

export const allowedEmails = pgTable('allowed_emails', {
  /** Stored lower-case. */
  email: text('email').primaryKey(),
  addedBySub: text('added_by_sub').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
})

// ---------------------------------------------------------------------------
// email_settings — which kinds of email Narrative sends (email/catalog.ts),
// switched by instance admins. No row = on.
// ---------------------------------------------------------------------------

export const emailSettings = pgTable('email_settings', {
  /** An `EmailKind` (email/catalog.ts). */
  kind: text('kind').primaryKey(),
  enabled: boolean('enabled').notNull(),
  updatedBySub: text('updated_by_sub').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

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
// Agentic layer A1 (migration 0016, ADR 0011)
// ---------------------------------------------------------------------------

/**
 * Personal access tokens — the identity Claude Code (MCP) and scripts (batch
 * API) use instead of the browser session cookie. Only the SHA-256 of the
 * raw token is stored; `prefix` lets the owner recognise a token in a list.
 */
export const personalAccessTokens = pgTable(
  'personal_access_tokens',
  {
    /** nanoid — public id used to revoke a token. */
    id: text('id').primaryKey(),
    userSub: text('user_sub').notNull(),
    /** Human label chosen at creation ("MacBook Claude Code"). */
    name: text('name').notNull(),
    /** SHA-256 hex of the raw token. */
    tokenHash: text('token_hash').notNull(),
    /** First characters of the raw token, shown in the token list. */
    prefix: text('prefix').notNull(),
    /** Granted scopes, e.g. `mcp`, `api`. */
    scopes: text('scopes').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** Every token expires, at most 365 days after creation (migration 0020). */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('personal_access_tokens_token_hash_idx').on(t.tokenHash),
    index('personal_access_tokens_user_sub_idx').on(t.userSub),
  ],
)

/**
 * A one-time credential for ONE media upload into ONE deck through the tus
 * server (`media.uploadSession`, agentic A2.7a): an agent with a shell sends
 * a local file with curl instead of writing its bytes out as base64. The raw
 * token (`nus_…`) is shown once and stored only as its SHA-256; it is valid
 * for a few minutes, for media (image, video, font) only, and is bound to the
 * first upload it creates (`upload_id`), which it may then only continue.
 */
export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: text('id').primaryKey(),
    /** SHA-256 hex of the raw token. */
    tokenHash: text('token_hash').notNull(),
    /** Who the upload is for: the user the agent acts as. */
    userSub: text('user_sub').notNull(),
    /** The deck it uploads into; null for a component master's session (0029). */
    deckId: text('deck_id').references(() => decks.id, { onDelete: 'cascade' }),
    /** The component master it uploads into (0029); exactly one of the two is set. */
    componentId: text('component_id').references(() => components.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** The tus upload the session created; null until it creates one. */
    uploadId: text('upload_id'),
    /**
     * The credential that asked for the session (auth/agentSessions.ts
     * credential keys, migration 0025): revoking it deletes the session.
     * Null for a browser session.
     */
    credentialKey: text('credential_key'),
    /** The exact size of the one file the session may upload (migration 0025). */
    sizeBytes: integer('size_bytes'),
    /** image | video | font: the only kind the session may upload (migration 0025). */
    kind: text('kind'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('upload_sessions_token_hash_idx').on(t.tokenHash),
    index('upload_sessions_expires_at_idx').on(t.expiresAt),
    index('upload_sessions_credential_key_idx').on(t.credentialKey),
    index('upload_sessions_user_sub_idx').on(t.userSub),
    check('upload_sessions_one_owner', sql`num_nonnulls(${t.deckId}, ${t.componentId}) = 1`),
  ],
)

/**
 * One agent run: one MCP session's (or API client's) work on one deck, the
 * unit of attribution and of revert. Every write of the run uses
 * `agentOrigin(id)` as its Yjs transaction origin.
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    userSub: text('user_sub').notNull(),
    /** The deck the run works on (null for component-master or account/folder-level runs). */
    deckId: text('deck_id').references(() => decks.id, { onDelete: 'cascade' }),
    /** The component master the run edits instead of a deck (migration 0017). */
    componentId: text('component_id').references(() => components.id, { onDelete: 'cascade' }),
    /** `mcp` | `api` */
    surface: text('surface').notNull(),
    /** Client name the MCP session reported (e.g. "claude-code"). */
    clientName: text('client_name'),
    /** The user's request as the agent stated it when starting the run. */
    request: text('request'),
    /** `open` | `closed` | `reverted` */
    status: text('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    revertedBySub: text('reverted_by_sub'),
  },
  (t) => [
    index('agent_runs_deck_id_idx').on(t.deckId, t.createdAt),
    index('agent_runs_user_sub_idx').on(t.userSub, t.createdAt),
    index('agent_runs_component_id_idx').on(t.componentId, t.createdAt),
  ],
)

/** Every command an agent run executed, in order — the audit trail. */
export const agentOps = pgTable(
  'agent_ops',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    command: text('command').notNull(),
    input: jsonb('input').notNull(),
    /** The target the host authorised ({ deckId } | { componentId } | { folderId } | {}); migration 0017. */
    target: jsonb('target'),
    result: jsonb('result'),
    error: jsonb('error'),
    /**
     * How an op that needed the user's confirmation was confirmed:
     * `{ via: 'elicitation' | 'out_of_band' | 'explicit', by, surface, at, reasons?,
     * hosts?, confirmationId?, approvedAt? }` (migration 0019; agent/runStore.ts).
     */
    confirmation: jsonb('confirmation'),
    /**
     * Every host the op's downloads contacted — the requested one and each
     * redirect hop (migration 0023). NULL when it fetched nothing.
     */
    fetchedHosts: text('fetched_hosts').array(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('agent_ops_run_seq_idx').on(t.runId, t.seq)],
)

// ---------------------------------------------------------------------------
// MCP OAuth (migration 0018) — Narrative as the OAuth 2.1 authorization server
// for MCP clients such as claude.ai connectors. apps/server/src/mcp/oauth/.
// Only SHA-256 hashes of codes, tokens and client secrets are stored.
// ---------------------------------------------------------------------------

/** A dynamically registered OAuth client (RFC 7591). */
export const mcpOauthClients = pgTable('mcp_oauth_clients', {
  /** client_id (random). */
  id: text('id').primaryKey(),
  clientName: text('client_name').notNull(),
  /** The claude.ai callback, loopback `/callback` URIs and MCP_OAUTH_REDIRECT_URIS only (mcp/oauth/redirects.ts). */
  redirectUris: text('redirect_uris').array().notNull(),
  /** `none` | `client_secret_post` | `client_secret_basic` */
  tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull(),
  clientSecretHash: text('client_secret_hash'),
  clientUri: text('client_uri'),
  softwareId: text('software_id'),
  softwareVersion: text('software_version'),
  /**
   * The scopes the client registered (migration 0022). NULL on registrations
   * made before it: every supported scope, as they were treated then.
   */
  scopes: text('scopes').array(),
  /**
   * The grant types the client registered (migration 0022; RFC 7591 default
   * `authorization_code` when it sent none). A refresh token is issued only
   * to a client whose grant types include `refresh_token`. NULL on older
   * registrations: both grant types, as before.
   */
  grantTypes: text('grant_types').array(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
})

/** A user's approval of one client: the identity behind its tokens. */
export const mcpOauthGrants = pgTable(
  'mcp_oauth_grants',
  {
    id: text('id').primaryKey(),
    /**
     * A registered (RFC 7591) client. Exactly one of `clientId` and
     * `clientMetadataUrl` is set (CHECK, migration 0021).
     */
    clientId: text('client_id').references(() => mcpOauthClients.id, { onDelete: 'cascade' }),
    /** A Client ID Metadata Document client: its client_id URL (never a row in mcp_oauth_clients). */
    clientMetadataUrl: text('client_metadata_url'),
    /** The client's name when the user approved it (migration 0021; NULL before). */
    clientName: text('client_name'),
    /** The redirect URI the user approved (migration 0021; NULL before). */
    redirectUri: text('redirect_uri'),
    userSub: text('user_sub').notNull(),
    scopes: text('scopes').array().notNull(),
    /**
     * The client's grant types when the user approved it (migration 0022), so
     * the token endpoint never refetches a metadata document. NULL on older
     * grants: refresh allowed, as before.
     */
    grantTypes: text('grant_types').array(),
    /** The MCP resource (RFC 8707) the tokens are bound to. */
    resource: text('resource').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Set when a refresh token of the grant was replayed (migration 0022; see service.ts). */
    flaggedAt: timestamp('flagged_at', { withTimezone: true }),
    flagReason: text('flag_reason'),
  },
  (t) => [
    index('mcp_oauth_grants_user_sub_idx').on(t.userSub),
    index('mcp_oauth_grants_client_id_idx').on(t.clientId),
  ],
)

/** One authorization request: parameters, consent decision and one-time code. */
export const mcpOauthAuthorizations = pgTable(
  'mcp_oauth_authorizations',
  {
    id: text('id').primaryKey(),
    /** Registered client, or `clientMetadataUrl` for a CIMD client — exactly one (migration 0021). */
    clientId: text('client_id').references(() => mcpOauthClients.id, { onDelete: 'cascade' }),
    clientMetadataUrl: text('client_metadata_url'),
    /** Display snapshot of the client when the request was made (migration 0021). */
    clientName: text('client_name'),
    /** Every redirect URI the client had when the request was made (migration 0021). */
    clientRedirectUris: text('client_redirect_uris').array(),
    redirectUri: text('redirect_uri').notNull(),
    /**
     * Whether /authorize received `redirect_uri` explicitly (migration 0022).
     * When it did, the token request must repeat it exactly (RFC 6749 §4.1.3).
     */
    redirectUriProvided: boolean('redirect_uri_provided').notNull().default(true),
    /** The client's grant types when the request was made (migration 0022). */
    clientGrantTypes: text('client_grant_types').array(),
    /** PKCE S256 challenge. */
    codeChallenge: text('code_challenge').notNull(),
    scopes: text('scopes').array().notNull(),
    resource: text('resource').notNull(),
    state: text('state'),
    /** SHA-256 of the consent form's CSRF token. */
    csrfHash: text('csrf_hash').notNull(),
    /** The signed-in user who saw the consent page (bound on first view). */
    userSub: text('user_sub'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** `approved` | `denied` */
    decision: text('decision'),
    codeHash: text('code_hash'),
    codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }),
    exchangedAt: timestamp('exchanged_at', { withTimezone: true }),
    grantId: text('grant_id').references(() => mcpOauthGrants.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('mcp_oauth_authorizations_code_hash_idx').on(t.codeHash),
    index('mcp_oauth_authorizations_expires_at_idx').on(t.expiresAt),
    index('mcp_oauth_authorizations_client_id_idx').on(t.clientId),
  ],
)

/** Access and refresh tokens of a grant. */
export const mcpOauthTokens = pgTable(
  'mcp_oauth_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    grantId: text('grant_id')
      .notNull()
      .references(() => mcpOauthGrants.id, { onDelete: 'cascade' }),
    /** `access` | `refresh` */
    kind: text('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Refresh tokens: when it was rotated (single use). */
    usedAt: timestamp('used_at', { withTimezone: true }),
    /**
     * Refresh tokens: SHA-256 of the rotating request's client IP and
     * User-Agent (migration 0022), to tell a client racing itself from a
     * replay by someone else (service.ts, refresh replay).
     */
    usedByFingerprint: text('used_by_fingerprint'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('mcp_oauth_tokens_grant_id_idx').on(t.grantId),
    index('mcp_oauth_tokens_expires_at_idx').on(t.expiresAt),
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
export type FolderInvite = typeof folderInvites.$inferSelect
export type PersonalAccessToken = typeof personalAccessTokens.$inferSelect
export type NewPersonalAccessToken = typeof personalAccessTokens.$inferInsert
export type AgentRun = typeof agentRuns.$inferSelect
export type NewAgentRun = typeof agentRuns.$inferInsert
export type AgentOp = typeof agentOps.$inferSelect
export type NewAgentOp = typeof agentOps.$inferInsert

/**
 * One-time data migrations (services/dataMigrations.ts): tries, completion
 * (null until done), report, last error. Migration 0026.
 */
export const appDataMigrations = pgTable('app_data_migrations', {
  id: text('id').primaryKey(),
  attempts: integer('attempts').default(0).notNull(),
  completedAt: timestamp('completed_at'),
  report: jsonb('report'),
  lastError: text('last_error'),
})
