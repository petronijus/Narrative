/**
 * media/bucketCleanup.ts
 *
 * Best-effort sweep of every MinIO object under a deck's prefix.
 *
 * All deck-scoped media — uploads, transcoded HLS bundles, deck thumbnail,
 * folder font originals stored under the deck — lives under the single
 * key prefix `decks/<deckId>/`. Listing and batch-deleting that prefix is
 * the simplest way to leave zero blobs behind when a deck is deleted,
 * without needing to enumerate every storage_key / hls_manifest_key /
 * poster_key / thumbnail_key column on `media_assets`. It also catches
 * untracked HLS segment files (`segment_000.ts`, etc.) that aren't stored
 * in any DB column.
 *
 * Loss-tolerant: every S3 error is logged and swallowed. The DB cascade
 * has already removed the corresponding rows by the time this runs, so
 * any storage failures only leave orphans that a future GC pass can
 * reap — the user-visible delete still succeeds.
 *
 * Pagination: ListObjectsV2 returns up to 1000 keys per page; we
 * DeleteObjects each page as we go so memory stays bounded even for
 * giant decks (e.g. an imported PPTX with hundreds of media items).
 */

import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import type { ObjectIdentifier } from '@aws-sdk/client-s3'
import { buildS3Client, MEDIA_BUCKET } from './s3Client.js'

interface MinimalLogger {
  warn: (obj: Record<string, unknown>, msg?: string) => void
  info?: (obj: Record<string, unknown>, msg?: string) => void
}

export interface PurgeResult {
  deleted: number
  pages: number
  errors: number
}

export async function purgeDeckBucketPrefix(
  deckId: string,
  log: MinimalLogger,
): Promise<PurgeResult> {
  const s3 = buildS3Client()
  const Prefix = `decks/${deckId}/`

  let continuationToken: string | undefined
  let totalDeleted = 0
  let pages = 0
  let errors = 0

  do {
    let page
    try {
      page = await s3.send(
        new ListObjectsV2Command({
          Bucket: MEDIA_BUCKET,
          Prefix,
          ContinuationToken: continuationToken,
        }),
      )
    } catch (err) {
      log.warn(
        { err, deckId, prefix: Prefix },
        'bucket list failed (deck cleanup aborted, orphans left)',
      )
      errors++
      break
    }

    pages++

    const objects: ObjectIdentifier[] = (page.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === 'string')
      .map((Key) => ({ Key }))

    if (objects.length > 0) {
      try {
        const res = await s3.send(
          new DeleteObjectsCommand({
            Bucket: MEDIA_BUCKET,
            Delete: { Objects: objects, Quiet: true },
          }),
        )
        totalDeleted += objects.length
        if (res.Errors && res.Errors.length > 0) {
          errors += res.Errors.length
          log.warn(
            { deckId, perObjectErrors: res.Errors },
            'bucket batch delete returned per-object errors (orphans left)',
          )
        }
      } catch (err) {
        log.warn(
          { err, deckId, batchSize: objects.length },
          'bucket batch delete failed (orphans left)',
        )
        errors++
      }
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken)

  if (log.info && (totalDeleted > 0 || errors > 0)) {
    log.info({ deckId, deleted: totalDeleted, pages, errors }, 'deck bucket prefix purge complete')
  }

  return { deleted: totalDeleted, pages, errors }
}
