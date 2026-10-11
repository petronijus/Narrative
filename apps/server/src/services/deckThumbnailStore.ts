/**
 * services/deckThumbnailStore.ts — a deck's card picture (what the folder
 * page shows for it) put in storage and on the deck row.
 *
 * Two writers: the editor uploads the first slide it rendered
 * (`PUT /decks/:id/thumbnail`, routes/decks.ts), and the render worker draws
 * it for a deck nobody has open (services/deckThumbnails.ts) or on request
 * (`deck.refreshThumbnail`, services/render.ts).
 *
 * Every picture gets a key of its own (`decks/<id>/thumb-<random>.<ext>`):
 *   - writers racing each other cannot delete what the row points at — the
 *     row is swapped under a row lock, and nothing the row names, nothing
 *     it named just before and nothing younger than `REPLACED_GRACE_MS` is
 *     deleted;
 *   - a card URL handed out earlier (imgproxy signs the path, without an
 *     expiry) stops showing the deck once newer pictures replaced it — not
 *     at once: a folder page opened a moment before still shows the picture
 *     it was given, until the next change after `REPLACED_GRACE_MS`.
 * Only a PNG or a JPEG is stored, by its bytes, whatever a writer declares.
 */

import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '../db/client.js'
import { decks } from '../db/schema.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'

export type DeckRow = typeof decks.$inferSelect

/** How long a replaced picture is kept for the pages that were given its URL. */
export const REPLACED_GRACE_MS = 10 * 60_000

export class ThumbnailStorageError extends Error {}
export class ThumbnailFormatError extends Error {}

const SIGNATURES: Record<'image/png' | 'image/jpeg', number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
}

/** Do the bytes start like the declared type? */
export function hasImageSignature(bytes: Uint8Array, mime: 'image/png' | 'image/jpeg'): boolean {
  const signature = SIGNATURES[mime]
  return bytes.byteLength > signature.length && signature.every((b, i) => bytes[i] === b)
}

async function deleteObject(key: string): Promise<void> {
  // Best effort: a stray object under the deck's prefix goes with the deck.
  await buildS3Client()
    .send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }))
    .catch(() => undefined)
}

/**
 * Store `picture` as the deck's card picture. Returns the updated deck row,
 * or null when the deck no longer exists (nothing is left in storage then).
 * Throws ThumbnailFormatError for bytes that are not the declared image
 * type, ThumbnailStorageError when storage refuses the object.
 */
export async function storeDeckThumbnail(
  db: Database,
  deckId: string,
  picture: { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' },
  opts: { graceMs?: number; now?: () => number } = {},
): Promise<DeckRow | null> {
  if (!hasImageSignature(picture.bytes, picture.mime)) {
    throw new ThumbnailFormatError(
      `the picture is not a ${picture.mime === 'image/png' ? 'PNG' : 'JPEG'}`,
    )
  }
  const ext = picture.mime === 'image/png' ? 'png' : 'jpg'
  const storageKey = `decks/${deckId}/thumb-${nanoid(12)}.${ext}`
  try {
    await buildS3Client().send(
      new PutObjectCommand({
        Bucket: MEDIA_BUCKET,
        Key: storageKey,
        Body: picture.bytes,
        ContentType: picture.mime,
        CacheControl: 'public, max-age=60',
      }),
    )
  } catch (err) {
    throw new ThumbnailStorageError(err instanceof Error ? err.message : String(err))
  }

  const swapped = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ thumbnailKey: decks.thumbnailKey })
      .from(decks)
      .where(eq(decks.id, deckId))
      .for('update')
    if (before === undefined) return null
    const now = new Date()
    const [row] = await tx
      .update(decks)
      .set({ thumbnailKey: storageKey, thumbnailUpdatedAt: now, updatedAt: now })
      .where(eq(decks.id, deckId))
      .returning()
    return { row: row!, previousKey: before.thumbnailKey }
  })
  if (swapped === null) {
    await deleteObject(storageKey)
    return null
  }
  await dropReplaced(deckId, new Set([storageKey, swapped.previousKey]), {
    graceMs: opts.graceMs ?? REPLACED_GRACE_MS,
    now: opts.now ?? Date.now,
  })
  return swapped.row
}

/**
 * Delete the deck's earlier card pictures (the legacy fixed `thumb.<ext>`
 * included) except `keep` and those stored within `graceMs` — a writer
 * racing this one may have just stored the picture its row swap will name.
 */
async function dropReplaced(
  deckId: string,
  keep: Set<string | null>,
  opts: { graceMs: number; now: () => number },
): Promise<void> {
  let listed
  try {
    listed = await buildS3Client().send(
      new ListObjectsV2Command({ Bucket: MEDIA_BUCKET, Prefix: `decks/${deckId}/thumb` }),
    )
  } catch {
    return // Best effort: what is left goes with the deck, or at the next store.
  }
  const cutoff = opts.now() - opts.graceMs
  for (const object of listed.Contents ?? []) {
    if (object.Key === undefined || keep.has(object.Key)) continue
    if ((object.LastModified?.getTime() ?? Infinity) > cutoff) continue
    await deleteObject(object.Key)
  }
}
