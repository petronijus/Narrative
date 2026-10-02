/**
 * media/bucketCleanup.ts
 *
 * Best-effort cleanup of a deck's MinIO objects.
 *
 * Two complementary passes are needed:
 *
 *  1. `purgeDeckBucketPrefix` sweeps the `decks/<deckId>/` prefix. This
 *     catches the deck thumbnail and the worker-produced video outputs
 *     (playback MP4 / poster / thumb), which DO live under that prefix.
 *
 *  2. `purgeExplicitKeys` deletes a caller-supplied list of keys. This is
 *     REQUIRED for tus-uploaded originals: @tus/s3-store keys each object
 *     by the upload id, which is the compound string
 *     `<assetId>:<deckId>:<base64url(path)>` — NOT the `decks/<deckId>/…`
 *     path — so the prefix sweep never sees them. The caller reads the
 *     `storage_key` (and video output keys) from `media_assets` BEFORE the
 *     DB cascade removes those rows, then passes them here. Each upload
 *     object also has a `<key>.info` metadata sidecar, which we delete too.
 *
 * Folder-level fonts (deckId NULL, folderId set) are uploaded the same way
 * and likewise need pass 2.
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
import { isStorageSafeId, mediaOwnerPrefix, type MediaOwner } from './mediaOwner.js'
import { inArray, or } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { mediaAssets } from '../db/schema.js'

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
  return purgeBucketPrefix({ deckId }, log)
}

/**
 * `purgeDeckBucketPrefix` for a component master: everything under
 * `components/<componentId>/` (copied pictures and videos, their
 * transcodes, the thumbnail). Originals uploaded into the master by tus
 * are keyed by their upload id and need `purgeExplicitKeys` as well. Only
 * a folder's deletion sweeps a component this way: deleting one component
 * hands its media to the folder (services/components.ts).
 */
export async function purgeComponentBucketPrefix(
  componentId: string,
  log: MinimalLogger,
): Promise<PurgeResult> {
  return purgeBucketPrefix({ componentId }, log)
}

async function purgeBucketPrefix(owner: MediaOwner, log: MinimalLogger): Promise<PurgeResult> {
  // An id that is not storage safe would widen the prefix into another
  // owner's keys (mediaOwner.ts): refuse the sweep, keep the orphans.
  if (!isStorageSafeId('deckId' in owner ? owner.deckId : owner.componentId)) {
    log.warn({ ...owner }, 'bucket prefix purge refused: the id cannot name storage keys')
    return { deleted: 0, pages: 0, errors: 1 }
  }
  const Prefix = `${mediaOwnerPrefix(owner)}/`
  const s3 = buildS3Client()

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
        { err, ...owner, prefix: Prefix },
        'bucket list failed (prefix cleanup aborted, orphans left)',
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
            { ...owner, perObjectErrors: res.Errors },
            'bucket batch delete returned per-object errors (orphans left)',
          )
        }
      } catch (err) {
        log.warn(
          { err, ...owner, batchSize: objects.length },
          'bucket batch delete failed (orphans left)',
        )
        errors++
      }
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken)

  if (log.info && (totalDeleted > 0 || errors > 0)) {
    log.info({ ...owner, deleted: totalDeleted, pages, errors }, 'bucket prefix purge complete')
  }

  return { deleted: totalDeleted, pages, errors }
}

/**
 * Delete an explicit list of S3 keys (plus each key's `<key>.info` tus
 * sidecar), batched at the DeleteObjects 1000-key limit. Loss-tolerant:
 * S3 errors are logged and swallowed so the user-visible delete still
 * succeeds. Used for tus-uploaded originals whose compound storage key
 * isn't reachable by the deck-prefix sweep.
 */
export async function purgeExplicitKeys(
  keys: ReadonlyArray<string>,
  log: MinimalLogger,
): Promise<PurgeResult> {
  const unique = new Set<string>()
  for (const k of keys) {
    if (typeof k !== 'string' || k === '') continue
    unique.add(k)
    unique.add(`${k}.info`)
  }

  let totalDeleted = 0
  let pages = 0
  let errors = 0

  if (unique.size === 0) return { deleted: 0, pages: 0, errors: 0 }

  const s3 = buildS3Client()
  const all = [...unique]

  for (let i = 0; i < all.length; i += 1000) {
    const batch = all.slice(i, i + 1000).map((Key) => ({ Key }))
    pages++
    try {
      const res = await s3.send(
        new DeleteObjectsCommand({
          Bucket: MEDIA_BUCKET,
          Delete: { Objects: batch, Quiet: true },
        }),
      )
      totalDeleted += batch.length
      if (res.Errors && res.Errors.length > 0) {
        errors += res.Errors.length
        log.warn(
          { perObjectErrors: res.Errors },
          'explicit key batch delete returned per-object errors (orphans left)',
        )
      }
    } catch (err) {
      log.warn({ err, batchSize: batch.length }, 'explicit key batch delete failed (orphans left)')
      errors++
    }
  }

  if (log.info && (totalDeleted > 0 || errors > 0)) {
    log.info({ deleted: totalDeleted, pages, errors }, 'explicit key purge complete')
  }

  return { deleted: totalDeleted, pages, errors }
}

/**
 * The keys among `keys` that a media row still names — as its stored file
 * or a video's output. Several rows can share one stored file (a deleted
 * folder font is cloned onto each deck of the folder under one key), so a
 * delete must not remove a file another row still shows.
 */
export async function keysStillReferenced(
  db: Database,
  keys: ReadonlyArray<string>,
): Promise<Set<string>> {
  const wanted = [...new Set(keys.filter((k) => typeof k === 'string' && k !== ''))]
  if (wanted.length === 0) return new Set()
  const rows = await db
    .select({
      storageKey: mediaAssets.storageKey,
      playbackKey: mediaAssets.playbackKey,
      posterKey: mediaAssets.posterKey,
      thumbnailKey: mediaAssets.thumbnailKey,
    })
    .from(mediaAssets)
    .where(
      or(
        inArray(mediaAssets.storageKey, wanted),
        inArray(mediaAssets.playbackKey, wanted),
        inArray(mediaAssets.posterKey, wanted),
        inArray(mediaAssets.thumbnailKey, wanted),
      ),
    )
  const named = new Set<string>()
  for (const r of rows) {
    for (const k of [r.storageKey, r.playbackKey, r.posterKey, r.thumbnailKey]) {
      if (typeof k === 'string' && k !== '') named.add(k)
    }
  }
  return new Set(wanted.filter((k) => named.has(k)))
}

/**
 * `purgeExplicitKeys` for the keys of rows just deleted: a key another row
 * still names (keysStillReferenced) is kept. Call it after the delete has
 * committed, so the deleted rows no longer count.
 */
export async function purgeUnreferencedKeys(
  db: Database,
  keys: ReadonlyArray<string>,
  log: MinimalLogger,
): Promise<PurgeResult> {
  const kept = await keysStillReferenced(db, keys)
  if (kept.size > 0 && log.info) {
    log.info({ kept: kept.size }, 'kept stored files other media rows still name')
  }
  return purgeExplicitKeys(
    keys.filter((k) => !kept.has(k)),
    log,
  )
}
