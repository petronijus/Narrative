/**
 * media/assets.ts
 *
 * CRUD helpers for the media_assets table.
 * All DB operations use Drizzle — no raw SQL.
 *
 * Called by:
 *   - media agent (phase 2): createMediaAsset() on tus upload finalize
 *   - server routes (future): listMediaAssets() for deck asset browser
 *   - BullMQ worker (phase 2): updateTranscodeStatus(), updateVideoAssetOutputs()
 *
 * NOTE: Deleting a deck cascades to media_assets rows (ON DELETE CASCADE),
 * but the original MinIO objects remain orphaned. See migration 0002 for details.
 */

import { eq, and } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { mediaAssets } from '../db/schema.js'
import type { MediaAsset } from '../db/schema.js'

export type { MediaAsset }

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type MediaAssetKind = 'image' | 'video'
export type TranscodeStatus = 'pending' | 'processing' | 'done' | 'failed'

/**
 * Richer view of a video asset row.
 * Only returned by getVideoAsset() when kind = 'video'.
 */
export interface VideoAssetRow {
  id: string
  deckId: string
  mimeType: string
  sizeBytes: number
  storageKey: string
  width: number | null
  height: number | null
  durationSec: number | null
  hlsManifestKey: string | null
  posterKey: string | null
  thumbnailKey: string | null
  transcodeStatus: TranscodeStatus | null
  transcodeError: string | null
  createdAt: Date
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

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
  /** Image/video width in px — only present when probe succeeds */
  width?: number
  /** Image/video height in px — only present when probe succeeds */
  height?: number
  /**
   * Asset kind. Defaults to 'image' for backward compatibility with M11 callers.
   * Media agent phase 2 passes kind: 'video' for video MIME types.
   */
  kind?: MediaAssetKind
  /**
   * Initial transcode status. Only set for video assets — omit for images.
   * Media agent phase 2 passes transcodeStatus: 'pending' on video upload finalize.
   */
  transcodeStatus?: TranscodeStatus
}

/**
 * Inserts a new media_assets row.
 * Called by the media agent after a successful tus upload + optional probe.
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
    kind: args.kind ?? 'image',
    transcodeStatus: args.transcodeStatus ?? null,
  })
}

// ---------------------------------------------------------------------------
// Read — generic
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Read — video-specific
// ---------------------------------------------------------------------------

/**
 * Returns a VideoAssetRow for the given asset id, but only if kind = 'video'.
 * Returns null when the asset does not exist or is an image asset.
 *
 * Used by:
 *   - server route GET /api/media/:id/video-info (phase 3)
 *   - BullMQ worker to verify it has the right asset type before transcoding
 */
export async function getVideoAsset(db: Database, id: string): Promise<VideoAssetRow | null> {
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, id), eq(mediaAssets.kind, 'video')))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  return {
    id: row.id,
    deckId: row.deckId,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    storageKey: row.storageKey,
    width: row.width,
    height: row.height,
    durationSec: row.durationSec,
    hlsManifestKey: row.hlsManifestKey,
    posterKey: row.posterKey,
    thumbnailKey: row.thumbnailKey,
    transcodeStatus: row.transcodeStatus as TranscodeStatus | null,
    transcodeError: row.transcodeError,
    createdAt: row.createdAt,
  }
}

/**
 * Returns all video assets for a given deck.
 * Filters by kind = 'video'.
 */
export async function listVideoAssets(db: Database, deckId: string): Promise<VideoAssetRow[]> {
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.deckId, deckId), eq(mediaAssets.kind, 'video')))

  return rows.map((row) => ({
    id: row.id,
    deckId: row.deckId,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    storageKey: row.storageKey,
    width: row.width,
    height: row.height,
    durationSec: row.durationSec,
    hlsManifestKey: row.hlsManifestKey,
    posterKey: row.posterKey,
    thumbnailKey: row.thumbnailKey,
    transcodeStatus: row.transcodeStatus as TranscodeStatus | null,
    transcodeError: row.transcodeError,
    createdAt: row.createdAt,
  }))
}

// ---------------------------------------------------------------------------
// Update — transcode lifecycle (called by BullMQ worker, phase 2)
// ---------------------------------------------------------------------------

/**
 * Updates the transcode_status for a video asset.
 * Pass error string only when status = 'failed'.
 *
 * Called by the BullMQ worker:
 *   - updateTranscodeStatus(db, id, 'processing') — job picked up
 *   - updateTranscodeStatus(db, id, 'failed', err.message) — ffmpeg error
 */
export async function updateTranscodeStatus(
  db: Database,
  id: string,
  status: TranscodeStatus,
  error?: string,
): Promise<void> {
  await db
    .update(mediaAssets)
    .set({
      transcodeStatus: status,
      transcodeError: error ?? null,
    })
    .where(eq(mediaAssets.id, id))
}

/**
 * Atomically sets all ffmpeg output keys and marks transcode_status = 'done'.
 * Called by the BullMQ worker on successful transcode completion.
 *
 * All six fields are required — partial updates are intentionally not supported
 * to prevent inconsistent state (e.g., manifest present without poster).
 */
export async function updateVideoAssetOutputs(
  db: Database,
  id: string,
  outputs: {
    hlsManifestKey: string
    posterKey: string
    thumbnailKey: string
    durationSec: number
    width: number
    height: number
  },
): Promise<void> {
  await db
    .update(mediaAssets)
    .set({
      hlsManifestKey: outputs.hlsManifestKey,
      posterKey: outputs.posterKey,
      thumbnailKey: outputs.thumbnailKey,
      durationSec: outputs.durationSec,
      width: outputs.width,
      height: outputs.height,
      transcodeStatus: 'done',
      transcodeError: null,
    })
    .where(eq(mediaAssets.id, id))
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Deletes a single media_assets row by id.
 * Does NOT delete the corresponding MinIO object — that is the responsibility
 * of the media agent cleanup job (TODO: media phase 2 / M29).
 */
export async function deleteMediaAsset(db: Database, id: string): Promise<void> {
  await db.delete(mediaAssets).where(eq(mediaAssets.id, id))
}
