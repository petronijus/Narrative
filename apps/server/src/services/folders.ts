/**
 * services/folders.ts — server implementation of `FolderService`
 * (packages/commands/src/services/folders.ts). The /folders routes, the
 * folder-font routes under /api/folders/:id/fonts and the `folder.*`
 * commands all call these functions.
 */

import { nanoid } from 'nanoid'
import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import type {
  BinarySource,
  FolderListPage,
  FolderListPageArgs,
  FolderRecord,
  FolderService,
  FolderSummary,
  FontFaceInfo,
} from '@narrative/commands'
import { components, decks, folderPermissions, folders, mediaAssets, users } from '../db/schema.js'
import type { DeckRole } from '../auth/permissions.js'
import { adminProbe } from '../auth/admin.js'
import {
  componentIdsInKeys,
  purgeComponentBucketPrefix,
  purgeDeckBucketPrefix,
  purgeUnreferencedKeys,
} from '../media/bucketCleanup.js'
import { scheduleOwnerSweeps } from '../media/ownerSweeps.js'
import { buildS3Client, MEDIA_BUCKET, presignGetUrl } from '../media/s3Client.js'
import { closeConnectionsForDocument, closeDeckConnections } from '../hocuspocus/connections.js'
import {
  folderFontPostscriptCollides,
  getFolderFontAsset,
  listFolderFontAssets,
} from '../media/assets.js'
import { parseFontMetadata } from '../media/fontMetadata.js'
import type { ServiceDeps } from './deps.js'
import { folderAudience, notifyDeleted } from '../email/events.js'
import { seedNewFolder } from './tokens.js'
import { badRequest, conflict, failed, notFound, unprocessable } from './errors.js'
import {
  containsIgnoringCase,
  fontFaceInfo,
  iso,
  ownerIdsFor,
  requireFolderContentReader,
  requireFolderRole,
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
 * Find or create the user's Drafts folder (`folders.is_drafts`, migration
 * 0034 — not the name: a folder's owners may rename it). On first deck
 * creation for a brand-new user this auto-provisions it — with the default
 * tokens, like every new folder. Two requests provisioning at once meet the
 * "one Drafts per owner" index; the loser takes the winner's folder.
 */
export async function getOrProvisionDrafts(
  deps: Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>,
  userId: string,
): Promise<string> {
  const { db } = deps
  const findDrafts = async () => {
    const [row] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.ownerUserId, userId), eq(folders.isDrafts, true)))
      .limit(1)
    return row?.id ?? null
  }
  const existing = await findDrafts()
  if (existing !== null) return existing

  const id = nanoid(12)
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(folders)
      .values({ id, ownerUserId: userId, name: 'Drafts', isDrafts: true, createdAt: new Date() })
      .onConflictDoNothing()
      .returning({ id: folders.id })
    // The creator is the folder's first member (folder sharing, migration 0030).
    if (row) await tx.insert(folderPermissions).values({ folderId: id, userId, role: 'owner' })
    return row
  })
  if (!created) {
    const winner = await findDrafts()
    if (winner === null) throw new Error('Failed to provision Drafts folder')
    return winner
  }
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

  /**
   * The caller's memberships, one row per folder with their role in it, as a
   * subquery to join. `min` of the `deck_role` enum is the HIGHEST role: the
   * enum is declared owner, editor, viewer, and Postgres orders an enum by
   * declaration. More than one row per folder only in BYPASS_AUTH dev mode
   * (the dev user and the legacy demo user). `grantedBy` names who shared
   * the folder with the caller: null for the folders they created.
   */
  function memberships(userId: string, admin: boolean) {
    const ids = ownerIdsFor(userId, deps.bypass)
    if (admin) {
      // An instance admin (ADR 0014) is owner of every folder but other
      // people's Drafts; `grantedBy` still names who shared one with them.
      return db
        .select({
          folderId: folders.id,
          role: sql<DeckRole>`CASE WHEN ${folders.isDrafts} THEN min(${folderPermissions.role}) ELSE 'owner' END`.as(
            'role',
          ),
          grantedBy: sql<string | null>`max(${folderPermissions.grantedBy})`.as('granted_by'),
        })
        .from(folders)
        .leftJoin(
          folderPermissions,
          and(eq(folderPermissions.folderId, folders.id), inArray(folderPermissions.userId, ids)),
        )
        .groupBy(folders.id)
        .having(sql`count(${folderPermissions.userId}) > 0 OR NOT ${folders.isDrafts}`)
        .as('my_folders')
    }
    return db
      .select({
        folderId: folderPermissions.folderId,
        role: sql<DeckRole>`min(${folderPermissions.role})`.as('role'),
        // Who granted the membership (one row per folder outside dev mode).
        grantedBy: sql<string | null>`max(${folderPermissions.grantedBy})`.as('granted_by'),
      })
      .from(folderPermissions)
      .where(inArray(folderPermissions.userId, ids))
      .groupBy(folderPermissions.folderId)
      .as('my_folders')
  }

  /** Who shared the folder with the caller: the granter's directory entry, or null for their own. */
  function sharedBy(
    userId: string,
    row: { grantedBy: string | null; sharerName: string | null; sharerEmail: string | null },
  ): FolderSummary['sharedBy'] {
    if (row.grantedBy === null || ownerIdsFor(userId, deps.bypass).includes(row.grantedBy))
      return null
    return { name: row.sharerName, email: row.sharerEmail }
  }

  async function list(args: { userId: string }): Promise<FolderSummary[]> {
    const deckCountSub = deckCounts()
    const mine = memberships(args.userId, await adminProbe(db, args.userId))
    const rows = await db
      .select({
        id: folders.id,
        name: folders.name,
        createdAt: folders.createdAt,
        deckCount: sql<number>`coalesce(${deckCountSub.count}, 0)`,
        role: mine.role,
        grantedBy: mine.grantedBy,
        sharerName: users.name,
        sharerEmail: users.email,
        isDrafts: folders.isDrafts,
      })
      .from(folders)
      .innerJoin(mine, eq(mine.folderId, folders.id))
      .leftJoin(deckCountSub, eq(folders.id, deckCountSub.folderId))
      .leftJoin(users, eq(users.sub, mine.grantedBy))
      .orderBy(folders.createdAt)
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: iso(r.createdAt),
      deckCount: r.deckCount,
      role: r.role,
      sharedBy: sharedBy(args.userId, r),
      isDrafts: r.isDrafts,
    }))
  }

  /**
   * The caller's folders by name A→Z ignoring case, then id; a page
   * continues with `(lower(name), id) > (key, id)`. Fetches `limit + 1` rows
   * to know whether another page follows. Membership as in `list`.
   */
  async function listPage(args: FolderListPageArgs): Promise<FolderListPage> {
    const limit = validPageLimit(args.limit)
    if (args.after !== undefined && args.after.key.length > MAX_FOLDER_KEY)
      throw badRequest('cursor: not a position this list returned')
    const filters: SQL[] = []
    if (args.query !== undefined && args.query !== '')
      filters.push(containsIgnoringCase(folders.name, args.query))
    if (args.after !== undefined)
      filters.push(sql`(${folderNameKey}, ${folders.id}) > (${args.after.key}, ${args.after.id})`)

    const deckCountSub = deckCounts()
    const mine = memberships(args.userId, await adminProbe(db, args.userId))
    const rows = await db
      .select({
        id: folders.id,
        name: folders.name,
        createdAt: folders.createdAt,
        deckCount: sql<number>`coalesce(${deckCountSub.count}, 0)`,
        role: mine.role,
        grantedBy: mine.grantedBy,
        sharerName: users.name,
        sharerEmail: users.email,
        isDrafts: folders.isDrafts,
        key: folderNameKey,
      })
      .from(folders)
      .innerJoin(mine, eq(mine.folderId, folders.id))
      .leftJoin(deckCountSub, eq(folders.id, deckCountSub.folderId))
      .leftJoin(users, eq(users.sub, mine.grantedBy))
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
        role: r.role,
        sharedBy: sharedBy(args.userId, r),
        isDrafts: r.isDrafts,
      })),
      next: rows.length > limit && last !== undefined ? { key: last.key, id: last.id } : null,
    }
  }

  async function create(args: { userId: string; name: string }) {
    const name = validFolderName(args.name)
    const id = nanoid(12)
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(folders)
        .values({ id, ownerUserId: args.userId, name, createdAt: new Date() })
        .returning()
      // The creator is the folder's first member (folder sharing, migration 0030).
      if (row) {
        await tx
          .insert(folderPermissions)
          .values({ folderId: id, userId: args.userId, role: 'owner' })
      }
      return row
    })
    if (!created) throw failed('Failed to create folder')
    await seedNewFolder(deps, id)
    return {
      ...folderRecord(created),
      deckCount: 0,
      role: 'owner' as const,
      sharedBy: null,
      isDrafts: false as const,
    }
  }

  async function rename(args: { userId: string; folderId: string; name: string }) {
    const name = validFolderName(args.name)
    await requireFolderRole(db, args.folderId, args.userId, 'owner', { bypass: deps.bypass })
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
    const existing = await requireFolderRole(db, id, args.userId, 'owner', { bypass: deps.bypass })
    if (existing.isDrafts) throw conflict('cannot_delete_drafts')
    // Who to tell, read before the rows cascade away.
    const audience = await folderAudience(deps, id, args.userId)

    // Capture deck ids so MinIO blobs can be swept after the cascade.
    const containedDecks = await db
      .select({ id: decks.id })
      .from(decks)
      .where(eq(decks.folderId, id))
    const deckIds = containedDecks.map((d) => d.id)

    // Storage keys of every contained deck's assets, the folder's own media
    // (fonts, and the pictures and videos of components deleted earlier) AND
    // its component masters' pictures and videos (A2.12b — they cascade
    // away with the folder's components), collected BEFORE the cascade
    // removes the rows: tus originals and folder fonts use keys outside any
    // decks/<id>/ or components/<id>/ prefix.
    const containedComponents = await db
      .select({ id: components.id })
      .from(components)
      .where(eq(components.folderId, id))
    const componentIds = containedComponents.map((c) => c.id)
    const ownMedia =
      componentIds.length > 0
        ? or(eq(mediaAssets.folderId, id), inArray(mediaAssets.componentId, componentIds))
        : eq(mediaAssets.folderId, id)
    const assetRows = await db
      .select({
        folderId: mediaAssets.folderId,
        storageKey: mediaAssets.storageKey,
        playbackKey: mediaAssets.playbackKey,
        posterKey: mediaAssets.posterKey,
        thumbnailKey: mediaAssets.thumbnailKey,
        presentPlaybackKey: mediaAssets.presentPlaybackKey,
      })
      .from(mediaAssets)
      .where(deckIds.length > 0 ? or(inArray(mediaAssets.deckId, deckIds), ownMedia) : ownMedia)
    const keysOf = (r: (typeof assetRows)[number]) =>
      [r.storageKey, r.playbackKey, r.posterKey, r.thumbnailKey, r.presentPlaybackKey].filter(
        (k): k is string => typeof k === 'string' && k !== '',
      )
    const explicitKeys = assetRows.flatMap(keysOf)
    // A component deleted earlier left its media to the folder (its rows are
    // folder-owned now, their files still under components/<old id>/): its
    // prefix — transcodes, leftovers — goes with the folder like a live
    // component's. Only the rows' keys still name it.
    const sweptComponents = new Set(componentIds)
    for (const c of componentIdsInKeys(assetRows.filter((r) => r.folderId === id).flatMap(keysOf)))
      sweptComponents.add(c)

    // Decks first (FK is ON DELETE RESTRICT); cascades remove their updates,
    // permissions, share links and media rows. One transaction, so a crash
    // cannot leave the decks destroyed while the folder survives — and the
    // second sweep of every prefix commits with it (media/ownerSweeps.ts).
    await db.transaction(async (tx) => {
      if (containedDecks.length > 0) await tx.delete(decks).where(eq(decks.folderId, id))
      await tx.delete(folders).where(eq(folders.id, id))
      await scheduleOwnerSweeps(tx, [
        ...containedDecks.map((d) => ({ deckId: d.id })),
        ...[...sweptComponents].map((c) => ({ componentId: c })),
      ])
    })

    // Nobody keeps the folder's documents open: its decks, its component
    // masters and its token document. (A store that still runs for one finds
    // its owner gone and stores nothing — hocuspocus/persistence.ts.)
    for (const d of containedDecks) closeDeckConnections(d.id)
    for (const c of componentIds) closeConnectionsForDocument(`component:${c}`)
    closeConnectionsForDocument(`folder:${id}`)

    // Best-effort MinIO cleanup, loss-tolerant; a file another media row
    // still names is kept (media/bucketCleanup.ts).
    const sweepPrefixes = () =>
      Promise.all([
        ...containedDecks.map((d) => purgeDeckBucketPrefix(db, d.id, deps.log)),
        ...[...sweptComponents].map((c) => purgeComponentBucketPrefix(db, c, deps.log)),
      ])
    // What is too young to sweep now (a transcode or a copy still writing)
    // goes with the sweeps scheduled above.
    await Promise.all([sweepPrefixes(), purgeUnreferencedKeys(db, explicitKeys, deps.log)])
    notifyDeleted(deps, {
      actorId: args.userId,
      audience,
      kind: 'folder',
      title: existing.name,
      deckCount: containedDecks.length,
    })
    return { deletedDeckCount: containedDecks.length }
  }

  async function listFonts(args: {
    userId: string | null
    folderId: string
    shareToken?: string | null | undefined
  }): Promise<FontFaceInfo[]> {
    // A deck guest reads its folder's fonts too, a share-link visitor
    // included: the deck renders with them.
    await requireFolderContentReader(db, args.folderId, args.userId, {
      bypass: deps.bypass,
      shareToken: args.shareToken,
    })
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
    await requireFolderRole(db, folderId, userId, 'editor', { bypass: deps.bypass })

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
      fontAxes: meta.axes ?? {},
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
    await requireFolderRole(db, folderId, userId, 'editor', { bypass: deps.bypass })
    const asset = await getFolderFontAsset(db, assetId, folderId)
    if (!asset) throw notFound('Font asset not found')

    // Every deck in the folder gets a deck-scoped clone so a presentation
    // that uses the font keeps rendering (Yjs docs are not scanned for use;
    // cloning to all is the safe deterministic option, sharing one MinIO key).
    // A folder editor is an editor of every deck in it (folder sharing), so
    // the clones land on decks the caller may change — whoever created them.
    const folderDecks = await db
      .select({ id: decks.id })
      .from(decks)
      .where(eq(decks.folderId, folderId))

    // The clones and the delete commit together: a deck never loses the
    // font between the two.
    await db.transaction(async (tx) => {
      if (folderDecks.length > 0) {
        await tx.insert(mediaAssets).values(
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
            fontAxes: asset.fontAxes,
          })),
        )
      }
      await tx.delete(mediaAssets).where(eq(mediaAssets.id, assetId))
    })
    const promotedToDeckCount = folderDecks.length

    // The file goes only when no row names it any more — not the clones,
    // nor another row sharing the key (media/bucketCleanup.ts).
    await purgeUnreferencedKeys(db, [asset.storageKey], deps.log)
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
