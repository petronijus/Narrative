/**
 * services/decks.ts — server implementation of `DeckService`
 * (packages/commands/src/services/decks.ts). The /decks routes, the
 * /folders/:id/{move-decks,active-editors} routes, GET /api/decks/:id/fonts
 * and the `deck.*` commands all call these functions, so the route and the
 * agent command cannot drift apart.
 */

import { nanoid } from 'nanoid'
import * as Y from 'yjs'
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { createSlideDoc, readFolderTokens } from '@narrative/slide-model'
import type {
  ActiveEditorsEntry,
  CreatedDeck,
  DeckListPage,
  DeckListPageArgs,
  DeckRecord,
  DeckRole,
  DeckService,
  DeckWithRole,
  DuplicatedDeck,
  MoveDecksResult,
  TokenRebindReport,
} from '@narrative/commands'
import { decks, deckPermissions, deckUpdates, folders, mediaAssets } from '../db/schema.js'
import { resolveDeckAccess } from '../auth/permissions.js'
import { listUsersBySubs } from '../auth/users.js'
import { signImgproxyUrl } from '../media/imgproxyUrl.js'
import { purgeDeckBucketPrefix, purgeExplicitKeys } from '../media/bucketCleanup.js'
import { listDeckFontAssets } from '../media/assets.js'
import { activeEditorsByDeck } from '../hocuspocus/presence.js'
import type { ServiceDeps } from './deps.js'
import { badRequest, failed, forbidden, notFound } from './errors.js'
import {
  containsIgnoringCase,
  fontFaceInfo,
  iso,
  isoOrNull,
  ownerIdsFor,
  requireOwnedFolder,
  validPageLimit,
} from './shared.js'
import { getOrProvisionDrafts } from './folders.js'
import { readDocCopy, writeLiveDoc } from './liveDocs.js'
import { applyTokenRebinding, planTokenRebinding } from './tokenRebind.js'
import { copyStoredObject, stageDeckCopy, stageObjectInsert } from './deckInsert.js'
import { discardDeckMedia, registerDeckMedia } from '../pptx/importDeck.js'

/** Longest deck title the API accepts. */
export const MAX_DECK_TITLE = 200

interface DeckRow {
  id: string
  title: string
  ownerUserId: string
  folderId: string | null
  thumbnailKey: string | null
  thumbnailUpdatedAt: Date | string | null
  createdAt: Date | string
  updatedAt: Date | string
}

/**
 * A deck row as the API returns it, with a signed imgproxy thumbnail URL so
 * the home page can render previews without exposing the MinIO key. The
 * `?v=<ms>` query string busts client + imgproxy caches whenever the editor
 * uploads a fresh snapshot.
 */
export function deckRecord(row: DeckRow): DeckRecord {
  let thumbnailUrl: string | null = null
  if (row.thumbnailKey !== null && row.thumbnailKey !== undefined) {
    const base = signImgproxyUrl({
      storageKey: row.thumbnailKey,
      variant: 'thumb',
      extension: 'jpg',
    })
    const updated = row.thumbnailUpdatedAt
    const v =
      updated === null || updated === undefined
        ? 0
        : (updated instanceof Date ? updated : new Date(updated)).getTime()
    thumbnailUrl = v > 0 ? `${base}?v=${v}` : base
  }
  return {
    id: row.id,
    title: row.title,
    ownerUserId: row.ownerUserId,
    folderId: row.folderId ?? null,
    thumbnailKey: row.thumbnailKey ?? null,
    thumbnailUpdatedAt: isoOrNull(row.thumbnailUpdatedAt),
    thumbnailUrl,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

/** Trim and validate a deck title (400 when empty or longer than 200 characters). */
export function validDeckTitle(raw: unknown): string {
  const title = typeof raw === 'string' ? raw.trim() : ''
  if (title === '') throw badRequest('title is required')
  if (title.length > MAX_DECK_TITLE) throw badRequest(`title too long (max ${MAX_DECK_TITLE})`)
  return title
}

const DECK_LAST_CHANGE_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/

export function createDecksService(deps: ServiceDeps): DeckService {
  const { db } = deps

  /** A folder filter must name a folder the caller owns (404 / 403 otherwise). */
  async function requireFilterFolder(userId: string, folderId: string): Promise<void> {
    const [folder] = await db
      .select({ ownerUserId: folders.ownerUserId })
      .from(folders)
      .where(eq(folders.id, folderId))
      .limit(1)
    if (!folder) throw notFound('Folder not found')
    if (!ownerIdsFor(userId, deps.bypass).includes(folder.ownerUserId)) throw forbidden()
  }

  async function list(args: { userId: string; folderId?: string | undefined }) {
    const { userId } = args
    const filterFolderId = args.folderId ?? null

    if (filterFolderId !== null) await requireFilterFolder(userId, filterFolderId)

    if (deps.bypass === true) {
      // BYPASS_AUTH=true dev fallback: both 'dev-user' and legacy 'demo-user' owned decks.
      // TODO(post-M10): remove when production migration script has run.
      const ownerCondition = inArray(decks.ownerUserId, ['dev-user', 'demo-user'])
      const whereClause =
        filterFolderId !== null
          ? and(ownerCondition, eq(decks.folderId, filterFolderId))
          : ownerCondition
      const rows = await db.select().from(decks).where(whereClause).orderBy(decks.createdAt)
      // In bypass mode dev-user always has owner role on their own decks.
      return rows.map((r) => ({ ...deckRecord(r), viewerRole: 'owner' as const }))
    }

    // Decks where the user has any explicit permission row (deck_permissions is
    // the authoritative access list post-M10), as one subquery — no N+1.
    const accessibleDeckIds = db
      .select({ deckId: deckPermissions.deckId })
      .from(deckPermissions)
      .where(eq(deckPermissions.userId, userId))
    const accessCondition = sql`${decks.id} IN (${accessibleDeckIds})`
    const whereClause =
      filterFolderId !== null
        ? and(accessCondition, eq(decks.folderId, filterFolderId))
        : accessCondition
    const rows = await db.select().from(decks).where(whereClause).orderBy(decks.createdAt)

    // The caller's effective role on each deck: one small follow-up query.
    const rolesByDeck = new Map<string, DeckRole>()
    if (rows.length > 0) {
      const permRows = await db
        .select({ deckId: deckPermissions.deckId, role: deckPermissions.role })
        .from(deckPermissions)
        .where(
          and(
            eq(deckPermissions.userId, userId),
            inArray(
              deckPermissions.deckId,
              rows.map((r) => r.id),
            ),
          ),
        )
      for (const p of permRows) rolesByDeck.set(p.deckId, p.role as DeckRole)
    }
    // Default to viewer if no permission row was found (the IN clause
    // guarantees one exists — defensive).
    return rows.map((r) => ({ ...deckRecord(r), viewerRole: rolesByDeck.get(r.id) ?? 'viewer' }))
  }

  /**
   * `list` as a keyset-paged, filtered list of lean items, newest change
   * first: ORDER BY last change DESC, id DESC, and a page continues with
   * `(last change, id) < (key, id)`. Fetches `limit + 1` rows to know whether
   * another page follows. Access is `list`'s: a deck_permissions row for the
   * caller (joined here, which also yields the role), or in BYPASS_AUTH dev
   * mode the decks of dev-user and the legacy demo-user (role owner).
   */
  async function listPage(args: DeckListPageArgs): Promise<DeckListPage> {
    const limit = validPageLimit(args.limit)
    // When each deck last changed: the newer of `decks.updated_at` (bumped
    // by rename and move) and the time its document was last stored —
    // deck_updates keeps the latest compacted state per deck (ADR 0006), so
    // its newest `created_at` is the last content change. Content edits never
    // touch `decks.updated_at`, which is why the column alone cannot answer
    // "recently updated". A joined aggregate rather than a correlated
    // subquery: Drizzle drops table names from the select list of a
    // single-table query, which would silently re-bind a correlated
    // `deck_id = id` to deck_updates.id; with a join every column is
    // qualified.
    const lastStore = db
      .select({
        deckId: deckUpdates.deckId,
        storedAt: sql`max(${deckUpdates.createdAt})`.as('stored_at'),
      })
      .from(deckUpdates)
      .groupBy(deckUpdates.deckId)
      .as('deck_last_store')
    const lastChange = sql`GREATEST(${decks.updatedAt}, COALESCE(${lastStore.storedAt}, ${decks.updatedAt}))`
    // Its keyset form: text with microseconds, because the column holds
    // microseconds and a JavaScript Date only milliseconds — a key rounded to
    // milliseconds would skip or repeat decks stored within one millisecond.
    const lastChangeKey = sql<string>`to_char(${lastChange}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`

    if (args.after !== undefined && !DECK_LAST_CHANGE_KEY.test(args.after.key))
      throw badRequest('cursor: not a position this list returned')
    if (args.folderId !== undefined) await requireFilterFolder(args.userId, args.folderId)

    const filters: SQL[] = []
    if (args.folderId !== undefined) filters.push(eq(decks.folderId, args.folderId))
    if (args.query !== undefined && args.query !== '')
      filters.push(containsIgnoringCase(decks.title, args.query))
    if (args.after !== undefined)
      filters.push(
        sql`(${lastChange}, ${decks.id}) < (${args.after.key}::timestamp, ${args.after.id})`,
      )

    const columns = {
      id: decks.id,
      title: decks.title,
      folderId: decks.folderId,
      updatedAt: lastChange.mapWith(decks.updatedAt),
      key: lastChangeKey,
    }
    const order = [desc(lastChange), desc(decks.id)] as const

    const rows =
      deps.bypass === true
        ? (
            await db
              .select(columns)
              .from(decks)
              .leftJoin(lastStore, eq(lastStore.deckId, decks.id))
              .where(and(inArray(decks.ownerUserId, ['dev-user', 'demo-user']), ...filters))
              .orderBy(...order)
              .limit(limit + 1)
          ).map((r) => ({ ...r, role: 'owner' as DeckRole }))
        : await db
            .select({ ...columns, role: deckPermissions.role })
            .from(decks)
            .leftJoin(lastStore, eq(lastStore.deckId, decks.id))
            .innerJoin(
              deckPermissions,
              and(eq(deckPermissions.deckId, decks.id), eq(deckPermissions.userId, args.userId)),
            )
            .where(and(...filters))
            .orderBy(...order)
            .limit(limit + 1)

    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return {
      decks: page.map((r) => ({
        id: r.id,
        title: r.title,
        folderId: r.folderId ?? null,
        updatedAt: iso(r.updatedAt as Date | string),
        role: r.role as DeckRole,
      })),
      next: rows.length > limit && last !== undefined ? { key: last.key, id: last.id } : null,
    }
  }

  async function get(args: {
    userId: string | null
    deckId: string
    shareToken?: string | null | undefined
  }): Promise<DeckWithRole> {
    const access = await resolveDeckAccess(db, {
      deckId: args.deckId,
      userId: args.userId,
      shareToken: args.shareToken ?? null,
    })
    if (!access) throw forbidden()
    const [deck] = await db.select().from(decks).where(eq(decks.id, args.deckId)).limit(1)
    if (!deck) throw notFound('Deck not found')
    return { ...deckRecord(deck), viewerRole: access.role }
  }

  async function create(args: {
    userId: string
    title?: string | undefined
    folderId?: string | undefined
  }): Promise<CreatedDeck> {
    const ownerUserId = args.userId
    const title = args.title ?? 'Untitled Deck'

    // The target folder: verified ownership when named, else Drafts
    // (auto-provisioned for a brand-new user).
    let targetFolderId: string
    if (args.folderId) {
      const [folder] = await db
        .select({ id: folders.id, ownerUserId: folders.ownerUserId })
        .from(folders)
        .where(eq(folders.id, args.folderId))
        .limit(1)
      if (!folder) throw notFound('Folder not found')
      if (folder.ownerUserId !== ownerUserId) throw forbidden()
      targetFolderId = folder.id
    } else {
      targetFolderId = await getOrProvisionDrafts(deps, ownerUserId)
    }

    const id = nanoid(12)
    const now = new Date()

    // The first document state: one empty slide, written with the deck. A
    // deck used to get its first slide from the first browser that opened it
    // (hydrateSlideDoc); creating it here means an agent can edit a deck it
    // just created, and two browsers opening an empty deck at once can no
    // longer each add a first slide.
    const initial = createSlideDoc()
    const firstSlideId = initial.slides.get(0).get('id') as string
    const state = Y.encodeStateAsUpdate(initial.doc)
    initial.doc.destroy()

    // One transaction: deck row, owner permission (keeps decks.owner_user_id
    // and deck_permissions in sync from the start) and the first snapshot.
    const deck = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(decks)
        .values({
          id,
          title,
          ownerUserId,
          folderId: targetFolderId,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
      if (!inserted) return null
      await tx.insert(deckPermissions).values({
        deckId: id,
        userId: ownerUserId,
        role: 'owner',
        grantedAt: now,
        grantedBy: ownerUserId,
      })
      await tx.insert(deckUpdates).values({ deckId: id, update: state, createdAt: now })
      return inserted
    })
    if (!deck) throw failed('Failed to create deck')
    return { ...deckRecord(deck), firstSlideId }
  }

  async function duplicate(args: {
    userId: string
    deckId: string
    title?: string | undefined
    folderId?: string | undefined
  }): Promise<DuplicatedDeck> {
    const [source] = await db
      .select({
        id: decks.id,
        title: decks.title,
        folderId: decks.folderId,
        thumbnailKey: decks.thumbnailKey,
      })
      .from(decks)
      .where(eq(decks.id, args.deckId))
      .limit(1)
    if (!source) throw notFound('Deck not found')

    // Where the copy goes: the named folder (owned), else the source's folder
    // when the user owns it, else their Drafts.
    let targetFolderId: string
    if (args.folderId !== undefined) {
      targetFolderId = (await requireOwnedFolder(db, args.folderId, args.userId)).id
    } else {
      const [own] =
        source.folderId === null
          ? []
          : await db
              .select({ id: folders.id })
              .from(folders)
              .where(and(eq(folders.id, source.folderId), eq(folders.ownerUserId, args.userId)))
              .limit(1)
      targetFolderId = own?.id ?? (await getOrProvisionDrafts(deps, args.userId))
    }
    const title =
      args.title !== undefined
        ? validDeckTitle(args.title)
        : `${source.title} (copy)`.slice(0, MAX_DECK_TITLE)

    const id = nanoid(12)
    // Access to the source, the document, its media and tokens — all staged
    // before any row exists.
    const staged = await stageDeckCopy(deps, {
      userId: args.userId,
      sourceDeckId: source.id,
      sourceFolderId: source.folderId,
      targetDeckId: id,
      targetFolderId,
    })

    // The preview comes along, so the copy does not sit in the deck list as
    // "No preview" until someone opens it. Best effort: without it the first
    // editor to open the copy renders one, as for any new deck.
    let thumbnailKey: string | null = null
    if (source.thumbnailKey !== null) {
      const ext = source.thumbnailKey.split('.').pop() === 'png' ? 'png' : 'jpg'
      const key = `decks/${id}/thumb.${ext}`
      try {
        await copyStoredObject(source.thumbnailKey, key)
        thumbnailKey = key
      } catch (err) {
        deps.log.warn({ err, deckId: source.id }, 'deck duplicate: copying the thumbnail failed')
      }
    }

    const now = new Date()
    let inserted: typeof decks.$inferSelect | undefined
    try {
      // Deck row, owner permission, first document state and media rows in
      // ONE transaction (the media rows reference the deck).
      inserted = await registerDeckMedia({
        db,
        deckId: id,
        ownerUserId: args.userId,
        media: staged.media,
        log: deps.log,
        alongside: async (tx) => {
          const [row] = await tx
            .insert(decks)
            .values({
              id,
              title,
              ownerUserId: args.userId,
              folderId: targetFolderId,
              thumbnailKey,
              thumbnailUpdatedAt: thumbnailKey === null ? null : now,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
          await tx.insert(deckPermissions).values({
            deckId: id,
            userId: args.userId,
            role: 'owner',
            grantedAt: now,
            grantedBy: args.userId,
          })
          await tx.insert(deckUpdates).values({ deckId: id, update: staged.state, createdAt: now })
          return row
        },
      })
    } catch (err) {
      await discardDeckMedia({ db, deckId: id, media: staged.media, log: deps.log })
      throw err
    }
    if (!inserted) throw failed('Failed to create the copy')
    return {
      ...deckRecord(inserted),
      slideCount: staged.slideCount,
      mediaCopied: staged.media.mediaAssetRows.length,
      skippedImages: staged.skippedImages,
      ...(staged.tokens !== undefined ? { tokens: staged.tokens } : {}),
    }
  }

  async function rename(args: { deckId: string; title: string }): Promise<DeckRecord> {
    const title = validDeckTitle(args.title)
    const [updated] = await db
      .update(decks)
      .set({ title, updatedAt: new Date() })
      .where(eq(decks.id, args.deckId))
      .returning()
    if (!updated) throw notFound('Deck not found')
    return deckRecord(updated)
  }

  async function remove(args: { deckId: string }): Promise<void> {
    const id = args.deckId
    // Collect every storage key BEFORE the cascade removes the media_assets
    // rows. tus-uploaded originals live at a compound key outside the
    // decks/<id>/ prefix, so the prefix sweep alone would orphan them.
    const assetRows = await db
      .select({
        storageKey: mediaAssets.storageKey,
        playbackKey: mediaAssets.playbackKey,
        posterKey: mediaAssets.posterKey,
        thumbnailKey: mediaAssets.thumbnailKey,
      })
      .from(mediaAssets)
      .where(eq(mediaAssets.deckId, id))

    const deleted = await db.delete(decks).where(eq(decks.id, id)).returning({ id: decks.id })
    if (deleted.length === 0) throw notFound('Deck not found')

    const explicitKeys = assetRows.flatMap((r) =>
      [r.storageKey, r.playbackKey, r.posterKey, r.thumbnailKey].filter(
        (k): k is string => typeof k === 'string' && k !== '',
      ),
    )
    // Pass 1: sweep decks/<id>/ (thumbnail, worker video outputs, exports).
    // Pass 2: explicit keys (tus originals + their .info sidecars).
    // Both loss-tolerant: errors are logged and swallowed.
    await Promise.all([
      purgeDeckBucketPrefix(id, deps.log),
      purgeExplicitKeys(explicitKeys, deps.log),
    ])
  }

  /**
   * Rewrite each moved deck's token references for its new folder. Runs
   * after the move committed; a deck whose document cannot be rewritten is
   * reported (the move stands — its references then resolve to nothing and
   * render with fallbacks, exactly as before this existed).
   */
  async function rebindTokens(
    deckIds: readonly string[],
    sourceFolderId: string,
    destFolderId: string,
    origin: unknown,
  ): Promise<TokenRebindReport[]> {
    if (deckIds.length === 0 || sourceFolderId === destFolderId) return []
    const failedAll = (err: unknown): TokenRebindReport[] =>
      deckIds.map((deckId) => ({
        deckId,
        rebound: 0,
        literalised: 0,
        detached: 0,
        unmatched: 0,
        error: err instanceof Error ? err.message : String(err),
      }))
    let plan
    try {
      const [sourceDoc, destDoc] = await Promise.all([
        readDocCopy(deps, 'folder', sourceFolderId),
        readDocCopy(deps, 'folder', destFolderId),
      ])
      try {
        plan = planTokenRebinding(readFolderTokens(sourceDoc), readFolderTokens(destDoc))
      } finally {
        sourceDoc.destroy()
        destDoc.destroy()
      }
    } catch (err) {
      deps.log.warn(
        { err, sourceFolderId, destFolderId },
        'move-decks: reading folder tokens failed',
      )
      return failedAll(err)
    }
    const reports: TokenRebindReport[] = []
    if (plan.refs.size === 0 && plan.textStyleLinks.size === 0) {
      // The source folder has no tokens: nothing in the deck can point at one
      // of them, so there is nothing to rewrite.
      return deckIds.map((deckId) => ({
        deckId,
        rebound: 0,
        literalised: 0,
        detached: 0,
        unmatched: 0,
      }))
    }
    for (const deckId of deckIds) {
      try {
        const counts = await writeLiveDoc(
          deps,
          'deck',
          deckId,
          (doc) => applyTokenRebinding(doc, plan),
          origin,
        )
        reports.push({ deckId, ...counts })
      } catch (err) {
        deps.log.warn({ err, deckId }, 'move-decks: rebinding token references failed')
        reports.push(...failedAll(err).filter((r) => r.deckId === deckId))
      }
    }
    return reports
  }

  async function moveDecks(args: {
    userId: string
    sourceFolderId: string
    deckIds: readonly string[]
    destFolderId: string
    origin?: unknown
  }): Promise<MoveDecksResult> {
    const { userId, sourceFolderId, destFolderId } = args
    const ids = [...args.deckIds]
    if (ids.length === 0) throw badRequest('deckIds must be a non-empty array')
    if (destFolderId === '') throw badRequest('destFolderId is required')

    await requireOwnedFolder(db, sourceFolderId, userId, {
      notFoundMessage: 'Source folder not found',
    })
    await requireOwnedFolder(db, destFolderId, userId, {
      notFoundMessage: 'Destination folder not found',
    })

    // Every deck must be the caller's and sit in the source folder.
    const deckRows = await db
      .select({ id: decks.id, ownerUserId: decks.ownerUserId, folderId: decks.folderId })
      .from(decks)
      .where(inArray(decks.id, ids))
    if (deckRows.some((d) => d.ownerUserId !== userId)) {
      throw forbidden('Forbidden: some decks are not owned by you')
    }
    const notInSrc = deckRows.filter((d) => d.folderId !== sourceFolderId)
    if (notInSrc.length > 0) {
      throw badRequest('Some decks are not in the source folder', { count: notInSrc.length })
    }
    if (deckRows.length !== ids.length) throw badRequest('Some deck ids not found')

    const result = await db
      .update(decks)
      .set({ folderId: destFolderId, updatedAt: new Date() })
      .where(inArray(decks.id, ids))
      .returning({ id: decks.id })

    const tokens = await rebindTokens(
      result.map((r) => r.id),
      sourceFolderId,
      destFolderId,
      args.origin,
    )
    return { movedCount: result.length, tokens }
  }

  async function moveDeck(args: {
    userId: string
    deckId: string
    destFolderId: string
    origin?: unknown
  }): Promise<MoveDecksResult> {
    const [deck] = await db
      .select({ id: decks.id, folderId: decks.folderId })
      .from(decks)
      .where(eq(decks.id, args.deckId))
      .limit(1)
    if (!deck) throw notFound('Deck not found')
    if (deck.folderId === null) throw badRequest('The deck is not in a folder')
    if (deck.folderId === args.destFolderId) return { movedCount: 0, tokens: [] }
    return moveDecks({
      userId: args.userId,
      sourceFolderId: deck.folderId,
      deckIds: [args.deckId],
      destFolderId: args.destFolderId,
      origin: args.origin,
    })
  }

  async function activeEditors(args: {
    userId: string
    folderId: string
  }): Promise<ActiveEditorsEntry[]> {
    // Folder ownership; anything else is "not found" (no existence oracle).
    const [owned] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(
          eq(folders.id, args.folderId),
          inArray(folders.ownerUserId, ownerIdsFor(args.userId, deps.bypass)),
        ),
      )
      .limit(1)
    if (!owned) throw notFound('Folder not found')

    const folderDecks = await db
      .select({ id: decks.id })
      .from(decks)
      .where(eq(decks.folderId, args.folderId))
    const snapshot = activeEditorsByDeck(folderDecks.map((d) => d.id))

    // Enrich each user id with display fields (one IN-list lookup over the union).
    const uniqueSubs = Array.from(new Set(snapshot.flatMap((s) => s.userIds)))
    const usersList = await listUsersBySubs(db, uniqueSubs)
    const usersBySub = new Map(usersList.map((u) => [u.sub, u]))
    return snapshot.map((s) => ({
      deckId: s.deckId,
      users: s.userIds.map((sub) => {
        const u = usersBySub.get(sub)
        return { userId: sub, email: u?.email ?? null, name: u?.name ?? null }
      }),
    }))
  }

  async function listFonts(args: { deckId: string }) {
    const rows = await listDeckFontAssets(db, args.deckId)
    return Promise.all(rows.map(fontFaceInfo))
  }

  return {
    list,
    listPage,
    get,
    create,
    duplicate,
    rename,
    delete: remove,
    moveDecks,
    moveDeck,
    activeEditors,
    listFonts,
    prepareObjectInsert: (args) => stageObjectInsert(deps, args),
  }
}
