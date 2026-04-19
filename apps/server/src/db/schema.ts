/**
 * db/schema.ts
 *
 * Drizzle ORM schema pro Narrative database.
 *
 * Tables:
 *   decks        — metadata prezentací (id, title, owner, timestamps)
 *   deck_updates — append-only Yjs update log (bytea per update per deck)
 *
 * Persistence strategy (M4):
 *   onLoadDocument  → načte všechny updates pro deck a aplikuje je sekvenčně
 *   onStoreDocument → uloží aktuální Y.Doc state jako nový update row
 *
 * TODO(M22): version history — sofistikovanější snapshot strategie
 * TODO(M29): kompakční strategie — merge N starých updates do 1 snapshot row
 *            aby loadDocument bylo O(1) pro decky s tisíci updatemi
 */

import { pgTable, text, timestamp, serial, index, customType } from 'drizzle-orm/pg-core'

// Custom type pro bytea (Yjs updates jsou Uint8Array)
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

// decks — metadata tabulka
export const decks = pgTable('decks', {
  id: text('id').primaryKey(),
  title: text('title').notNull().default('Untitled Deck'),
  ownerUserId: text('owner_user_id').notNull(), // M4: vždy 'demo-user'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// deck_updates — append-only Yjs update log
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

export type Deck = typeof decks.$inferSelect
export type NewDeck = typeof decks.$inferInsert
export type DeckUpdate = typeof deckUpdates.$inferSelect
export type NewDeckUpdate = typeof deckUpdates.$inferInsert
