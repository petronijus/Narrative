/**
 * schema.ts — Drizzle schema for the video-worker.
 *
 * Contains only the tables the worker needs to read/write.
 * This is a deliberate subset of apps/server/src/db/schema.ts.
 * Keep in sync with the server schema — both are derived from the same Postgres migrations.
 *
 * DO NOT add migration logic here. Migrations are managed by apps/server (drizzle-kit).
 */

import { pgTable, text, timestamp, index, pgEnum, integer } from 'drizzle-orm/pg-core'

export const mediaAssetKindEnum = pgEnum('media_asset_kind', ['image', 'video'])

export const transcodeStatusEnum = pgEnum('media_transcode_status', [
  'pending',
  'processing',
  'done',
  'failed',
])

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: text('id').primaryKey(),
    // Nullable since folder fonts (M16 P3); a component master's media has
    // component_id instead (A2.12b, migration 0027). The worker only
    // updates rows by id, so neither is read here.
    deckId: text('deck_id'),
    componentId: text('component_id'),
    uploaderUserId: text('uploader_user_id').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    originalFilename: text('original_filename'),
    width: integer('width'),
    height: integer('height'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    kind: mediaAssetKindEnum('kind').notNull().default('image'),
    durationSec: integer('duration_sec'),
    playbackKey: text('playback_key'),
    posterKey: text('poster_key'),
    thumbnailKey: text('thumbnail_key'),
    transcodeStatus: transcodeStatusEnum('transcode_status'),
    transcodeError: text('transcode_error'),
    // Migration 0039: the 1080p rendition of a video larger than 1080p.
    presentPlaybackKey: text('present_playback_key'),
    presentWidth: integer('present_width'),
    presentHeight: integer('present_height'),
  },
  (t) => [index('media_assets_deck_idx').on(t.deckId)],
)
