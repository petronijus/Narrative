/**
 * scripts/backfillVideoPlayback.ts
 *
 * One-off backfill after the HLS → progressive-MP4 migration (0014).
 *
 * The 0014 migration dropped `hls_manifest_key` and added an empty
 * `playback_key`. Every pre-existing video row therefore has no playable
 * source until the worker re-runs and produces `playback.mp4`. This script
 * re-enqueues a transcode job for each affected video so the (now cheap,
 * lossless) remux repopulates `playback_key` + poster + thumbnail.
 *
 * Usage (run from the deploy host so it reaches the prod DB + Redis):
 *   pnpm --filter @narrative/server db:backfill-video            # dry run
 *   pnpm --filter @narrative/server db:backfill-video --apply    # enqueue
 *   pnpm --filter @narrative/server db:backfill-video --apply --all
 *       --all also re-enqueues videos that already HAVE a playback_key
 *       (e.g. to regenerate after a worker change). Default targets only
 *       rows missing playback_key.
 *
 * Idempotent: re-running is safe. A row already 'pending'/'processing' is
 * re-enqueued (the worker dedupes by job, and re-encoding is cheap).
 *
 * Requires POSTGRES_URL + MEDIA_REDIS_URL in the environment (the npm
 * script wires --env-file).
 */

import { and, eq, isNull } from 'drizzle-orm'
import { Pool } from 'pg'
import process from 'node:process'

import { createDb } from '../db.js'
import { mediaAssets } from '../db/schema.js'
import { enqueueVideoTranscode } from '../media/enqueue.js'
import { updateTranscodeStatus } from '../media/assets.js'

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const all = process.argv.includes('--all')

  const pool = new Pool({ connectionString: process.env['POSTGRES_URL'] })
  const db = createDb(pool)

  // Target videos. Default: only those missing a playback_key (the post-0014
  // backfill case). --all: every video row.
  const where = all
    ? eq(mediaAssets.kind, 'video')
    : and(eq(mediaAssets.kind, 'video'), isNull(mediaAssets.playbackKey))

  const rows = await db
    .select({
      id: mediaAssets.id,
      deckId: mediaAssets.deckId,
      storageKey: mediaAssets.storageKey,
      uploaderUserId: mediaAssets.uploaderUserId,
      mimeType: mediaAssets.mimeType,
    })
    .from(mediaAssets)
    .where(where)

  // deckId is nullable in the schema (folder-scoped fonts), but videos always
  // have one. Skip any defensively.
  const targets = rows.filter((r): r is typeof r & { deckId: string } => r.deckId !== null)

  console.log(
    `[backfill-video] ${targets.length} video(s) ${all ? '(all)' : 'missing playback_key'} ` +
      `— ${apply ? 'ENQUEUING' : 'DRY RUN (pass --apply to enqueue)'}`,
  )

  if (!apply) {
    for (const r of targets) {
      console.log(`  would enqueue: asset=${r.id} deck=${r.deckId} key=${r.storageKey}`)
    }
    await pool.end()
    return
  }

  let enqueued = 0
  for (const r of targets) {
    // Reset to 'pending' so the UI shows the processing state while the
    // worker regenerates outputs.
    await updateTranscodeStatus(db, r.id, 'pending')
    await enqueueVideoTranscode({
      assetId: r.id,
      deckId: r.deckId,
      storageKey: r.storageKey,
      uploaderUserId: r.uploaderUserId,
      mimeType: r.mimeType,
    })
    enqueued++
    console.log(`  enqueued: asset=${r.id} deck=${r.deckId}`)
  }

  console.log(`[backfill-video] done — ${enqueued} job(s) enqueued`)
  await pool.end()
}

main().catch((err) => {
  console.error('[backfill-video] failed:', err)
  process.exit(1)
})
