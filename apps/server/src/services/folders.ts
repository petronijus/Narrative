/**
 * services/folders.ts — server implementation of `FolderService`
 * (packages/commands/src/services/folders.ts). The /folders routes, the
 * folder-font routes under /api/folders/:id/fonts and the `folder.*`
 * commands all call these functions.
 */

import { nanoid } from 'nanoid'
import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import type {
  BinarySource,
  FolderListPage,
  FolderListPageArgs,
  FolderRecord,
  FolderService,
  FolderSummary,
  FontFaceInfo,
} from '@narrative/commands'
import { decks, folders, mediaAssets } from '../db/schema.js'
import { purgeDeckBucketPrefix, purgeExplicitKeys } from '../media/bucketCleanup.js'
import { buildS3Client, MEDIA_BUCKET, presignGetUrl } from '../media/s3Client.js'
import {
  folderFontPostscriptCollides,
  getFolderFontAsset,
  listFolderFontAssets,
} from '../media/assets.js'
import { parseFontMetadata } from '../media/fontMetadata.js'
import type { ServiceDeps } from './deps.js'
import { seedNewFolder } from './tokens.js'
import { badRequest, conflict, failed, notFound, unprocessable } from './errors.js'
import {
  containsIgnoringCase,
  fontFaceInfo,
  iso,
  ownerIdsFor,
  requireOwnedFolder,
  validPageLimit,
} from './shared.js'
import { resolveBinarySource } from './binarySource.js'

/** Longest folder name the API accepts. */
export const MAX_FOLDER_NAME = 200

/** Largest folder font file, in bytes. */
export const MAX_FOLDER_FONT_BYTES = 10 * 1024 * 1024

// Browsers send WILDLY inconsistent MIME types for font files — even within
// the same browser, the value depends on the OS's MIME registry. macOS
// Safari sends 'font/otf' for .otf; Chrome on Windows sends
// 'application/vnd.ms-opentype'; Firefox sometimes sends
// 'application/font-sfnt' or 'application/x-font-opentype' for the same
// file; Chrome on Linux often sends an empty string. Be permissive: accept
// every spelling we've seen plus octet-stream and an empty string (the bytes
// are re-validated by opentype.js anyway, so the MIME is just metadata).
export const ALLOWED_FONT_MIME_TYPES = new Set([
  'font/ttf',
  'font/otf',
  'font/woff',
  'font/woff2',
  'font/sfnt',
  'application/font-woff',
  'application/font-woff2',
  'application/font-sfnt',
  'application/vnd.ms-opentype',
  'application/vnd.ms-fontobject',
  'application/x-font-ttf',
  'application/x-font-otf',
  'application/x-font-opentype',
  'application/x-font-truetype',
  'application/x-font-woff',
  'application/x-font-sfnt',
  // Some clients send application/octet-stream or empty MIME; we check the extension too.
  'application/octet-stream',
  '',
])

const FONT_MIME_TO_EXT: Record<string, string> = {
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'font/sfnt': 'ttf',
  'application/font-woff': 'woff',
  'application/font-woff2': 'woff2',
  'application/font-sfnt': 'ttf',
  'application/vnd.ms-opentype': 'otf',
  'application/x-font-ttf': 'ttf',
  'application/x-font-otf': 'otf',
  'application/x-font-opentype': 'otf',
  'application/x-font-truetype': 'ttf',
  'application/x-font-woff': 'woff',
  'application/x-font-sfnt': 'ttf',
}

function fontExtFromMime(mime: string, originalName?: string): string {
  const fromMime = FONT_MIME_TO_EXT[mime]
  if (fromMime) return fromMime
  if (originalName) {
    const dot = originalName.lastIndexOf('.')
    if (dot !== -1) {
      const ext = originalName.slice(dot + 1).toLowerCase()
      if (['ttf', 'otf', 'woff2'].includes(ext)) return ext
    }
  }
  return 'ttf'
}

/**
 * Find or create the "Drafts" folder for a user. On first deck creation for
 * a brand-new user (no existing folders), this auto-provisions it — with the
 * default tokens, like every new folder.
 */
export async function getOrProvisionDrafts(
  deps: Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>,
  userId: string,
): Promise<string> {
  const { db } = deps
  const [existing] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.ownerUserId, userId), eq(folders.name, 'Drafts')))
    .limit(1)
  if (existing) return existing.id

  const id = nanoid(12)
  const [created] = await db
    .insert(folders)
    .values({ id, ownerUserId: userId, name: 'Drafts', createdAt: new Date() })
    .returning({ id: folders.id })
  if (!created) throw new Error('Failed to provision Drafts folder')
  await seedNewFolder(deps, created.id)
  return created.id
}

/** Trim and validate a folder name (400 when empty or longer than 200 characters). */
export function validFolderName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name === '') throw badRequest('name is required')
  if (name.length > MAX_FOLDER_NAME) throw badRequest(`name too long (max ${MAX_FOLDER_NAME})`)
  return name
}

function folderRecord(row: {
  id: string
  ownerUserId: string
  name: string
  createdAt: Date | string
}): FolderRecord {
  return { id: row.id, ownerUserId: row.ownerUserId, name: row.name, createdAt: iso(row.createdAt) }
}

/** The folder sort (and keyset) key: the name ignoring case. */
const folderNameKey = sql<string>`lower(${folders.name})`
/** Longest keyset key accepted (lower-cased names are at most MAX_FOLDER_NAME characters). */
const MAX_FOLDER_KEY = 4 * MAX_FOLDER_NAME

export function createFoldersService(deps: ServiceDeps): FolderService {
  const { db } = deps

  /** Decks per folder, as a subquery to left-join (a folder without decks has no row). */
  function deckCounts() {
    return db
      .select({
        folderId: decks.folderId,
        count: sql<number>`cast(count(*) as int)`.as('count'),
      })
      .from(decks)
      .groupBy(decks.folderId)
      .as('deck_counts')
  }

  async function list(args: { userId: string }): Promise<FolderSummary[]> {
    const deckCountSub = deckCounts()
    const rows = await db
      .select({
        id: folders.id,
        name: folders.name,
        createdAt: folders.createdAt,
        deckCount: sql<number>`coalesce(${deckCountSub.count}, 0)`,
      })
      .from(folders)
      .leftJoin(deckCountSub, eq(folders.id, deckCountSub.folderId))
      .where(inArray(folders.ownerUserId, ownerIdsFor(args.userId, deps.bypass)))
      .orderBy(folders.createdAt)
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: iso(r.createdAt),
      deckCount: r.deckCount,
    }))
  }

  /**
   * The caller's folders by name A→Z ignoring case, then id; a page
   * continues with `(lower(name), id) > (key, id)`. Fetches `limit + 1` rows
   * to know whether another page follows. Ownership as in `list`.
   */
  async function listPage(args: FolderListPageArgs): Promise<FolderListPage> {
    const limit = validPageLimit(args.limit)
    if (args.after !== undefined && args.after.key.length > MAX_FOLDER_KEY)
      throw badRequest('cursor: not a position this list returned')
    const filters: SQL[] = [inArray(folders.ownerUserId, ownerIdsFor(args.userId, deps.bypass))]
    if (args.query !== undefined && args.query !== '')
      filters.push(containsIgnoringCase(folders.name, args.query))
    if (args.after !== undefined)
      filters.push(sql`(${folderNameKey}, ${folders.id}) > (${args.after.key}, ${args.after.id})`)

    const deckCountSub = deckCounts()
    const rows = await db
      .select({
        id: folders.id,
        name: folders.name,
        createdAt: folders.createdAt,
        deckCount: sql<number>`coalesce(${deckCountSub.count}, 0)`,
        key: folderNameKey,
      })
      .from(folders)
      .leftJoin(deckCountSub, eq(folders.id, deckCountSub.folderId))
      .where(and(...filters))
      .orderBy(asc(folderNameKey), asc(folders.id))
      .limit(limit + 1)

    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return {
      folders: page.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: iso(r.createdAt),
        deckCount: r.deckCount,
      })),
      next: rows.length > limit && last !== undefined ? { key: last.key, id: last.id } : null,
    }
  }

  async function create(args: { userId: string; name: string }) {
    const name = validFolderName(args.name)
    const id = nanoid(12)
    const [created] = await db
      .insert(folders)
      .values({ id, ownerUserId: args.userId, name, createdAt: new Date() })
      .returning()
    if (!created) throw failed('Failed to create folder')
    await seedNewFolder(deps, id)
    return { ...folderRecord(created), deckCount: 0 }
  }

  async function rename(args: { userId: string; folderId: string; name: string }) {
    const name = validFolderName(args.name)
    await requireOwnedFolder(db, args.folderId, args.userId)
    const [updated] = await db
      .update(folders)
      .set({ name })
      .where(eq(folders.id, args.folderId))
      .returning()
    if (!updated) throw notFound('Folder not found')
    return folderRecord(updated)
  }

  async function remove(args: { userId: string; folderId: string }) {
    const id = args.folderId
    const existing = await requireOwnedFolder(db, id, args.userId)
    if (existing.name === 'Drafts') throw conflict('cannot_delete_drafts')

    // Capture deck ids so MinIO blobs can be swept after the cascade.
    const containedDecks = await db
      .select({ id: decks.id })
      .from(decks)
      .where(eq(decks.folderId, id))
    const deckIds = containedDecks.map((d) => d.id)

    // Storage keys of every contained deck's assets AND the folder's own
    // fonts, collected BEFORE the cascade removes the rows: tus originals and
    // folder fonts use keys outside any decks/<id>/ prefix.
    const assetRows = await db
      .select({
        storageKey: mediaAssets.storageKey,
        playbackKey: mediaAssets.playbackKey,
        posterKey: mediaAssets.posterKey,
        thumbnailKey: mediaAssets.thumbnailKey,
      })
      .from(mediaAssets)
      .where(
        deckIds.length > 0
          ? or(inArray(mediaAssets.deckId, deckIds), eq(mediaAssets.folderId, id))
          : eq(mediaAssets.folderId, id),
      )
    const explicitKeys = assetRows.flatMap((r) =>
      [r.storageKey, r.playbackKey, r.posterKey, r.thumbnailKey].filter(
        (k): k is string => typeof k === 'string' && k !== '',
      ),
    )

    // Decks first (FK is ON DELETE RESTRICT); cascades remove their updates,
    // permissions, share links and media rows. One transaction, so a crash
    // cannot leave the decks destroyed while the folder survives.
    await db.transaction(async (tx) => {
      if (containedDecks.length > 0) await tx.delete(decks).where(eq(decks.folderId, id))
      await tx.delete(folders).where(eq(folders.id, id))
    })

    // Best-effort MinIO cleanup, loss-tolerant.
    await Promise.all([
      ...containedDecks.map((d) => purgeDeckBucketPrefix(d.id, deps.log)),
      purgeExplicitKeys(explicitKeys, deps.log),
    ])
    return { deletedDeckCount: containedDecks.length }
  }

  async function listFonts(args: { userId: string; folderId: string }): Promise<FontFaceInfo[]> {
    await requireOwnedFolder(db, args.folderId, args.userId)
    const rows = await listFolderFontAssets(db, args.folderId)
    return Promise.all(rows.map(fontFaceInfo))
  }

  async function uploadFont(args: {
    userId: string
    folderId: string
    source: BinarySource
    familyOverride?: string | undefined
  }): Promise<FontFaceInfo> {
    const { userId, folderId } = args
    await requireOwnedFolder(db, folderId, userId)

    const file = await resolveBinarySource(args.source, {
      userId,
      maxBytes: MAX_FOLDER_FONT_BYTES,
      what: 'Font file',
      tooLargeMessage: (n) => `Font exceeds 10 MB limit (got ${n} bytes)`,
    })
    const mimeType = ALLOWED_FONT_MIME_TYPES.has(file.mimeType)
      ? file.mimeType
      : 'application/octet-stream'

    // Parse font metadata — throws on invalid OpenType/TrueType data.
    let meta: ReturnType<typeof parseFontMetadata>
    try {
      const arrayBuf = file.bytes.buffer.slice(
        file.bytes.byteOffset,
        file.bytes.byteOffset + file.bytes.byteLength,
      ) as ArrayBuffer
      meta = parseFontMetadata(arrayBuf)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw unprocessable(`Invalid font file: ${msg}`)
    }

    if (await folderFontPostscriptCollides(db, folderId, meta.postscriptName)) {
      throw conflict('A font with this postscript name already exists in this folder', {
        postscriptName: meta.postscriptName,
      })
    }

    const assetId = nanoid(21)
    const ext = fontExtFromMime(mimeType, file.filename)
    const storageKey = `fonts/${folderId}/${assetId}/original.${ext}`
    await buildS3Client().send(
      new PutObjectCommand({
        Bucket: MEDIA_BUCKET,
        Key: storageKey,
        Body: file.bytes,
        ContentType: mimeType,
        ContentLength: file.bytes.length,
      }),
    )

    const override = args.familyOverride?.trim()
    const effectiveFamily = override !== undefined && override !== '' ? override : meta.family
    const uploadedAt = new Date()
    await db.insert(mediaAssets).values({
      id: assetId,
      deckId: null,
      folderId,
      uploaderUserId: userId,
      mimeType,
      sizeBytes: file.bytes.length,
      storageKey,
      originalFilename: file.filename ?? null,
      kind: 'font',
      fontFamily: effectiveFamily,
      fontWeight: meta.weight,
      fontStyle: meta.style,
      fontPostscriptName: meta.postscriptName,
    })

    return {
      assetId,
      family: effectiveFamily,
      weight: meta.weight,
      style: meta.style,
      postscriptName: meta.postscriptName,
      url: await presignGetUrl(storageKey),
      sizeBytes: file.bytes.length,
      uploadedAt: uploadedAt.toISOString(),
    }
  }

  async function deleteFont(args: { userId: string; folderId: string; assetId: string }) {
    const { userId, folderId, assetId } = args
    await requireOwnedFolder(db, folderId, userId)
    const asset = await getFolderFontAsset(db, assetId, folderId)
    if (!asset) throw notFound('Font asset not found')

    // Every deck in the folder gets a deck-scoped clone so a presentation
    // that uses the font keeps rendering (Yjs docs are not scanned for use;
    // cloning to all is the safe deterministic option, sharing one MinIO key).
    // IDOR-1: only decks the CALLER owns — folder membership is not deck
    // ownership, and cloning a row onto someone else's deck is cross-tenant
    // row creation.
    const folderDecks = await db
      .select({ id: decks.id })
      .from(decks)
      .where(and(eq(decks.folderId, folderId), eq(decks.ownerUserId, userId)))

    let promotedToDeckCount = 0
    if (folderDecks.length > 0) {
      await db.insert(mediaAssets).values(
        folderDecks.map((d) => ({
          id: nanoid(),
          deckId: d.id,
          folderId: null,
          uploaderUserId: asset.uploaderUserId,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          storageKey: asset.storageKey,
          originalFilename: asset.originalFilename,
          kind: 'font' as const,
          fontFamily: asset.fontFamily,
          fontWeight: asset.fontWeight,
          fontStyle: asset.fontStyle,
          fontPostscriptName: asset.fontPostscriptName,
        })),
      )
      promotedToDeckCount = folderDecks.length
    }

    await db.delete(mediaAssets).where(eq(mediaAssets.id, assetId))

    // The object is shared by the clones; delete it only when none were made.
    if (promotedToDeckCount === 0) {
      try {
        await buildS3Client().send(
          new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: asset.storageKey }),
        )
      } catch (err) {
        deps.log.warn(
          { err, key: asset.storageKey },
          '[folderFonts] MinIO delete failed (orphaned)',
        )
      }
    }
    return { promotedToDeckCount }
  }

  return {
    list,
    listPage,
    create,
    rename,
    delete: remove,
    listFonts,
    uploadFont,
    deleteFont,
  }
}
