/**
 * assets.ts — media_assets DB helpers for the video-worker.
 *
 * Mirrors the subset of apps/server/src/media/assets.ts that the worker needs.
 * Only transcode-lifecycle mutations are included here.
 */

import { eq } from 'drizzle-orm'
import type { Database } from './db.js'
import { mediaAssets } from './schema.js'

export type TranscodeStatus = 'pending' | 'processing' | 'done' | 'failed'

/**
 * Updates transcode_status (and optionally transcode_error) for a video asset.
 * Called at job start ('processing') and on failure ('failed').
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
 * Called by the worker on successful transcode completion.
 */
export async function updateVideoAssetOutputs(
  db: Database,
  id: string,
  outputs: {
    playbackKey: string
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
      playbackKey: outputs.playbackKey,
      posterKey: outputs.posterKey,
      thumbnailKey: outputs.thumbnailKey,
      durationSec: Math.round(outputs.durationSec),
      width: outputs.width,
      height: outputs.height,
      transcodeStatus: 'done',
      transcodeError: null,
    })
    .where(eq(mediaAssets.id, id))
}
