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

// ---------------------------------------------------------------------------
// decks — metadata table
// ---------------------------------------------------------------------------

export const decks = pgTable('decks', {
  id: text('id').primaryKey(),
  title: text('title').notNull().default('Untitled Deck'),
  /** Denormalized primary owner for quick lookups. Mirrors deck_permissions owner row. */
  ownerUserId: text('owner_user_id').notNull(), // M4: always 'demo-user'; M10 phase 2: real JWT sub
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

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
  (t) => [index('deck_updates_deck_id_idx').on(t.deckId)],
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
    userId: text('user_id').notNull(), // Authentik 'sub' claim (or 'demo-user' until phase 2)
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
// Inferred types
// ---------------------------------------------------------------------------

export type Deck = typeof decks.$inferSelect
export type NewDeck = typeof decks.$inferInsert
export type DeckUpdate = typeof deckUpdates.$inferSelect
export type NewDeckUpdate = typeof deckUpdates.$inferInsert
export type DeckPermission = typeof deckPermissions.$inferSelect
export type NewDeckPermission = typeof deckPermissions.$inferInsert
export type ShareLink = typeof shareLinks.$inferSelect
export type NewShareLink = typeof shareLinks.$inferInsert
