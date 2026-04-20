/**
 * media/assets.ts
 *
 * CRUD helpers for the media_assets table.
 * All DB operations use Drizzle — no raw SQL.
 *
 * Called by:
 *   - media agent (phase 2): createMediaAsset() on tus upload finalize
 *   - server routes (future): listMediaAssets() for deck asset browser
 *
 * NOTE: Deleting a deck cascades to media_assets rows (ON DELETE CASCADE),
 * but the original MinIO objects remain orphaned. See migration 0002 for details.
 */

import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { mediaAssets } from '../db/schema.js'
import type { MediaAsset } from '../db/schema.js'

export type { MediaAsset }

export interface CreateMediaAssetArgs {
  /** nanoid produced by the media agent at upload-start time */
  id: string
  deckId: string
  uploaderUserId: string
  mimeType: string
  sizeBytes: number
  /** Bucket key: decks/<deckId>/uploads/<id>/original.<ext> */
  storageKey: string
  originalFilename?: string
  /** Image width in px — only present when probe succeeds */
  width?: number
  /** Image height in px — only present when probe succeeds */
  height?: number
}

/**
 * Inserts a new media_assets row.
 * Called by the media agent after a successful tus upload + optional image probe.
 */
export async function createMediaAsset(db: Database, args: CreateMediaAssetArgs): Promise<void> {
  await db.insert(mediaAssets).values({
    id: args.id,
    deckId: args.deckId,
    uploaderUserId: args.uploaderUserId,
    mimeType: args.mimeType,
    sizeBytes: args.sizeBytes,
    storageKey: args.storageKey,
    originalFilename: args.originalFilename ?? null,
    width: args.width ?? null,
    height: args.height ?? null,
  })
}

/**
 * Returns a single media_assets row by id, or null if not found.
 */
export async function getMediaAsset(db: Database, id: string): Promise<MediaAsset | null> {
  const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).limit(1)

  return rows[0] ?? null
}

/**
 * Returns all media_assets rows for a given deck, ordered by createdAt ascending.
 */
export async function listMediaAssets(db: Database, deckId: string): Promise<MediaAsset[]> {
  return db.select().from(mediaAssets).where(eq(mediaAssets.deckId, deckId))
}

/**
 * Deletes a single media_assets row by id.
 * Does NOT delete the corresponding MinIO object — that is the responsibility
 * of the media agent cleanup job (TODO: media phase 2 / M29).
 */
export async function deleteMediaAsset(db: Database, id: string): Promise<void> {
  await db.delete(mediaAssets).where(eq(mediaAssets.id, id))
}
