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

import { eq, and, isNull } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { mediaAssets } from '../db/schema.js'
import type { MediaAsset } from '../db/schema.js'

export type { MediaAsset }

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type MediaAssetKind = 'image' | 'video' | 'font'
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
  /** Deck the asset belongs to. NULL for folder-scoped font assets (M16 P3). */
  deckId?: string
  /** Folder the asset belongs to. Set only for folder-scoped fonts (M16 P3). */
  folderId?: string
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
  /** P15: parsed font family name. Set only when kind='font'. */
  fontFamily?: string
  /** P15: OS/2 usWeightClass — 100..900. Set only when kind='font'. */
  fontWeight?: number
  /** P15: 'normal' | 'italic'. Set only when kind='font'. */
  fontStyle?: string
  /** P15: parsed postscript name. Set only when kind='font'. */
  fontPostscriptName?: string
}

/**
 * Inserts a new media_assets row.
 * Called by the media agent after a successful tus upload + optional probe.
 */
export async function createMediaAsset(db: Database, args: CreateMediaAssetArgs): Promise<void> {
  await db.insert(mediaAssets).values({
    id: args.id,
    deckId: args.deckId ?? null,
    folderId: args.folderId ?? null,
    uploaderUserId: args.uploaderUserId,
    mimeType: args.mimeType,
    sizeBytes: args.sizeBytes,
    storageKey: args.storageKey,
    originalFilename: args.originalFilename ?? null,
    width: args.width ?? null,
    height: args.height ?? null,
    kind: args.kind ?? 'image',
    transcodeStatus: args.transcodeStatus ?? null,
    fontFamily: args.fontFamily ?? null,
    fontWeight: args.fontWeight ?? null,
    fontStyle: args.fontStyle ?? null,
    fontPostscriptName: args.fontPostscriptName ?? null,
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

  if (row.deckId === null) return null
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

  return rows
    .filter((row): row is typeof row & { deckId: string } => row.deckId !== null)
    .map((row) => ({
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
// Read — font-specific (P15)
// ---------------------------------------------------------------------------

export interface FontAssetRow {
  id: string
  /** Deck the font belongs to. Null for folder-scoped fonts. */
  deckId: string | null
  /** Folder the font belongs to. Null for deck-scoped fonts. */
  folderId: string | null
  mimeType: string
  storageKey: string
  fontFamily: string
  fontWeight: number
  fontStyle: 'normal' | 'italic'
  fontPostscriptName: string
  uploaderUserId: string
  originalFilename: string | null
  sizeBytes: number
  createdAt: Date
}

/**
 * Returns a font asset by id, or null when missing / not a font row.
 */
export async function getFontAsset(db: Database, id: string): Promise<FontAssetRow | null> {
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, id), eq(mediaAssets.kind, 'font')))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return toFontRow(row)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toFontRow(row: any): FontAssetRow {
  return {
    id: row.id,
    deckId: row.deckId ?? null,
    folderId: row.folderId ?? null,
    mimeType: row.mimeType,
    storageKey: row.storageKey,
    fontFamily: row.fontFamily ?? '',
    fontWeight: row.fontWeight ?? 400,
    fontStyle: (row.fontStyle as 'normal' | 'italic' | null) ?? 'normal',
    fontPostscriptName: row.fontPostscriptName ?? row.fontFamily ?? '',
    uploaderUserId: row.uploaderUserId,
    originalFilename: row.originalFilename,
    sizeBytes: row.sizeBytes ?? 0,
    createdAt: row.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Folder-scoped font helpers (M16 P3)
// ---------------------------------------------------------------------------

/**
 * Returns every font asset belonging to a folder (kind='font', folder_id=folderId,
 * deck_id IS NULL). These are the fonts uploaded via the folder settings page.
 */
export async function listFolderFontAssets(
  db: Database,
  folderId: string,
): Promise<FontAssetRow[]> {
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.folderId, folderId),
        eq(mediaAssets.kind, 'font'),
        isNull(mediaAssets.deckId),
      ),
    )
  return rows.map(toFontRow)
}

/**
 * Returns a single folder-scoped font by asset id.
 * Returns null when not found or when the row belongs to a deck rather than a folder.
 */
export async function getFolderFontAsset(
  db: Database,
  assetId: string,
  folderId: string,
): Promise<FontAssetRow | null> {
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.id, assetId),
        eq(mediaAssets.folderId, folderId),
        eq(mediaAssets.kind, 'font'),
        isNull(mediaAssets.deckId),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return toFontRow(row)
}

/**
 * Returns true when the given postscript name already exists in the folder.
 * Used to reject uploads that would create a duplicate face.
 */
export async function folderFontPostscriptCollides(
  db: Database,
  folderId: string,
  postscriptName: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.folderId, folderId),
        eq(mediaAssets.kind, 'font'),
        isNull(mediaAssets.deckId),
        eq(mediaAssets.fontPostscriptName, postscriptName),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Returns every font asset bound to a single deck (kind='font', deck_id=:deckId,
 * folder_id IS NULL). Populated when the user deletes a folder font that's
 * referenced by one or more decks — the row is "promoted" to deck scope so
 * the presentation keeps rendering.
 */
export async function listDeckFontAssets(db: Database, deckId: string): Promise<FontAssetRow[]> {
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.deckId, deckId),
        eq(mediaAssets.kind, 'font'),
        isNull(mediaAssets.folderId),
      ),
    )
  return rows.map(toFontRow)
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
