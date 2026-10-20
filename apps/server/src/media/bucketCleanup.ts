/**
 * media/bucketCleanup.ts
 *
 * Best-effort cleanup of a deck's (or a component master's) MinIO objects.
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
 * A prefix sweep also keeps what may belong to a row that does not name it
 * YET: the video worker writes `<prefix>/videos/<rowId>/…` before it records
 * the keys on the row, and a copy is stored before its row is registered.
 * So every object under `videos/<id>/` of a row that exists stays, and so
 * does every object younger than the grace window (`sweepGraceMs`, 15
 * minutes — far longer than any upload of a video's outputs or a copy in
 * flight takes). A sweep of an owner that is gone (a deleted deck, component
 * or folder) runs once more after the window, for what was too young the
 * first time and what a transcode finished meanwhile: the delete schedules it
 * in the database (media/ownerSweeps.ts), so a restart does not forget it.
 *
 * Neither the prefix sweep nor `purgeUnreferencedKeys` deletes a key that a
 * remaining media row still names (`keysStillReferenced`): several rows can
 * share one stored file, and a file can outlive the owner whose prefix it
 * sits under — a folder font uploaded before migration 0009 lives under
 * `decks/<originDeck>/fonts/…` and its `deleteFont` clones share that key;
 * a deleted component's media stays under `components/<id>/`, named by the
 * rows its folder now owns. Run them after the delete committed, so the
 * deleted rows no longer count.
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
import {
  isStorageSafeId,
  mediaOwnerPrefix,
  parseTusUploadId,
  type MediaOwner,
} from './mediaOwner.js'
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

/** Objects younger than this are never swept (see the file header). */
export const DEFAULT_SWEEP_GRACE_MS = 15 * 60_000

/**
 * The grace window of prefix sweeps: `MEDIA_SWEEP_GRACE_MS` when set (a
 * non-negative number of milliseconds; the integration tests set 0), else
 * `DEFAULT_SWEEP_GRACE_MS`. Read at every sweep.
 */
export function sweepGraceMs(): number {
  const raw = process.env['MEDIA_SWEEP_GRACE_MS']
  const value = raw === undefined || raw === '' ? Number.NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SWEEP_GRACE_MS
}

export async function purgeDeckBucketPrefix(
  db: Database,
  deckId: string,
  log: MinimalLogger,
): Promise<PurgeResult> {
  return purgeBucketPrefix(db, { deckId }, log)
}

/**
 * `purgeDeckBucketPrefix` for a component master: whatever no media row
 * names any more under `components/<componentId>/` (the thumbnail, outputs
 * of media deleted earlier, what a failed copy left). Originals uploaded
 * into the master by tus are keyed by their upload id and need
 * `purgeUnreferencedKeys` as well. A deleted component hands its media to
 * the folder (services/components.ts), so its sweep keeps those files.
 */
export async function purgeComponentBucketPrefix(
  db: Database,
  componentId: string,
  log: MinimalLogger,
): Promise<PurgeResult> {
  return purgeBucketPrefix(db, { componentId }, log)
}

/**
 * The listed keys that may go: those no media row names. A tus upload's
 * `<key>.info` sidecar stays with its key. Throws when the database cannot
 * answer — a sweep that cannot tell must delete nothing.
 */
async function unreferencedOf(db: Database, keys: readonly string[]): Promise<string[]> {
  const base = (k: string) => (k.endsWith('.info') ? k.slice(0, -'.info'.length) : k)
  const kept = await keysStillReferenced(db, [...new Set([...keys, ...keys.map(base)])])
  return keys.filter((k) => !kept.has(k) && !kept.has(base(k)))
}

/**
 * The listed objects a prefix sweep must keep although no row names them
 * yet: those younger than the grace window, and those under
 * `<prefix>/videos/<id>/` of a media row that exists (a transcode's outputs
 * before the worker records them). Throws when the database cannot answer.
 */
async function pendingOf(
  db: Database,
  prefix: string,
  objects: ReadonlyArray<{ Key?: string | undefined; LastModified?: Date | undefined }>,
  now: number,
): Promise<Set<string>> {
  const keep = new Set<string>()
  const grace = sweepGraceMs()
  const videoOf = new Map<string, string>()
  for (const o of objects) {
    if (typeof o.Key !== 'string') continue
    const modified = o.LastModified?.getTime()
    // An object of unknown age is kept: a sweep that cannot tell deletes nothing.
    if (modified === undefined || now - modified < grace) keep.add(o.Key)
    if (o.Key.startsWith(`${prefix}videos/`)) {
      const id = o.Key.slice(`${prefix}videos/`.length).split('/')[0] ?? ''
      if (id !== '') videoOf.set(o.Key, id)
    }
  }
  const ids = [...new Set(videoOf.values())]
  if (ids.length > 0) {
    const rows = await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(inArray(mediaAssets.id, ids))
    const existing = new Set(rows.map((r) => r.id))
    for (const [key, id] of videoOf) if (existing.has(id)) keep.add(key)
  }
  return keep
}

async function purgeBucketPrefix(
  db: Database,
  owner: MediaOwner,
  log: MinimalLogger,
): Promise<PurgeResult> {
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
  let kept = 0
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

    const contents = page.Contents ?? []
    const listed = contents.map((o) => o.Key).filter((k): k is string => typeof k === 'string')
    let keys: string[]
    try {
      const pending = await pendingOf(db, Prefix, contents, Date.now())
      const candidates = listed.filter((k) => !pending.has(k))
      keys = candidates.length === 0 ? [] : await unreferencedOf(db, candidates)
    } catch (err) {
      log.warn(
        { err, ...owner, prefix: Prefix },
        'bucket prefix purge: reading which files media rows still name failed (cleanup aborted, orphans left)',
      )
      errors++
      break
    }
    kept += listed.length - keys.length
    const objects: ObjectIdentifier[] = keys.map((Key) => ({ Key }))

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

  if (log.info && (totalDeleted > 0 || kept > 0 || errors > 0)) {
    log.info(
      { ...owner, deleted: totalDeleted, kept, pages, errors },
      'bucket prefix purge complete',
    )
  }

  return { deleted: totalDeleted, pages, errors }
}

/**
 * The component ids whose `components/<id>/` prefix holds one of `keys` —
 * directly, or as the storage path a tus upload id encodes. A folder's
 * deletion sweeps these prefixes too: the media of a component deleted
 * earlier is the folder's now, and its rows' keys are all that is left of
 * that component. Ids that are not storage safe are left out (their prefix
 * would reach into another owner's keys).
 */
export function componentIdsInKeys(keys: Iterable<string>): Set<string> {
  const ids = new Set<string>()
  const add = (path: string | null) => {
    if (path === null || !path.startsWith('components/')) return
    const id = path.slice('components/'.length).split('/')[0] ?? ''
    if (isStorageSafeId(id) && path.length > `components/${id}/`.length) ids.add(id)
  }
  for (const key of keys) {
    if (key.startsWith('components/')) add(key)
    else add(parseTusUploadId(key)?.path ?? null)
  }
  return ids
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
      presentPlaybackKey: mediaAssets.presentPlaybackKey,
    })
    .from(mediaAssets)
    .where(
      or(
        inArray(mediaAssets.storageKey, wanted),
        inArray(mediaAssets.playbackKey, wanted),
        inArray(mediaAssets.posterKey, wanted),
        inArray(mediaAssets.thumbnailKey, wanted),
        inArray(mediaAssets.presentPlaybackKey, wanted),
      ),
    )
  const named = new Set<string>()
  for (const r of rows) {
    for (const k of [
      r.storageKey,
      r.playbackKey,
      r.posterKey,
      r.thumbnailKey,
      r.presentPlaybackKey,
    ]) {
      if (typeof k === 'string' && k !== '') named.add(k)
    }
  }
  return new Set(wanted.filter((k) => named.has(k)))
}

/**
 * `purgeExplicitKeys` for the keys of rows just deleted: a key another row
 * still names (keysStillReferenced) is kept. Call it after the delete has
 * committed, so the deleted rows no longer count. When the database cannot
 * say which keys are still named, nothing is deleted.
 */
export async function purgeUnreferencedKeys(
  db: Database,
  keys: ReadonlyArray<string>,
  log: MinimalLogger,
): Promise<PurgeResult> {
  let kept: Set<string>
  try {
    kept = await keysStillReferenced(db, keys)
  } catch (err) {
    log.warn(
      { err, keys: keys.length },
      'reading which files media rows still name failed (nothing deleted, orphans left)',
    )
    return { deleted: 0, pages: 0, errors: 1 }
  }
  if (kept.size > 0 && log.info) {
    log.info({ kept: kept.size }, 'kept stored files other media rows still name')
  }
  return purgeExplicitKeys(
    keys.filter((k) => !kept.has(k)),
    log,
  )
}
