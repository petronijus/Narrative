/**
 * services/decks.ts — server implementation of `DeckService`
 * (packages/commands/src/services/decks.ts). The /decks routes, the
 * /folders/:id/{move-decks,active-editors} routes, GET /api/decks/:id/fonts
 * and the `deck.*` commands all call these functions, so the route and the
 * agent command cannot drift apart.
 */

import { nanoid } from 'nanoid'
import * as Y from 'yjs'
import { and, desc, eq, inArray, sql, TransactionRollbackError, type SQL } from 'drizzle-orm'
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
  MovedDeckMedia,
  TokenRebindReport,
} from '@narrative/commands'
import {
  decks,
  deckPermissions,
  deckUpdates,
  folderPermissions,
  mediaAssets,
} from '../db/schema.js'
import {
  higherRole,
  resolveDeckAccess,
  resolveFolderAccess,
  roleAtLeast,
} from '../auth/permissions.js'
import { listUsersBySubs } from '../auth/users.js'
import { signImgproxyUrl } from '../media/imgproxyUrl.js'
import {
  purgeDeckBucketPrefix,
  purgeUnreferencedKeys,
  sweepAgainAfterGrace,
} from '../media/bucketCleanup.js'
import { listDeckFontAssets } from '../media/assets.js'
import { activeEditorsByDeck } from '../hocuspocus/presence.js'
import { closeConnectionsForDocument, closeDeckConnections } from '../hocuspocus/connections.js'
import type { ServiceDeps } from './deps.js'
import { badRequest, conflict, failed, forbidden, notFound } from './errors.js'
import {
  containsIgnoringCase,
  fontFaceInfo,
  iso,
  isoOrNull,
  bypassAliases,
  ownerIdsFor,
  requireFolderRole,
  validPageLimit,
} from './shared.js'
import { getOrProvisionDrafts } from './folders.js'
import { readDocCopy, writeLiveDoc } from './liveDocs.js'
import { applyTokenRebinding, planTokenRebinding } from './tokenRebind.js'
import { copyStoredObject, stageDeckCopy, stageObjectInsert } from './deckInsert.js'
import { localiseLinkedMedia } from './localiseMedia.js'
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

  /** A folder filter must name a folder the caller is a member of (404 / 403 otherwise). */
  async function requireFilterFolder(userId: string, folderId: string): Promise<void> {
    await requireFolderRole(db, folderId, userId, 'viewer', { bypass: deps.bypass })
  }

  /**
   * What makes a deck visible to a signed-in user (not BYPASS_AUTH): their
   * own deck_permissions row, or their membership of the deck's folder —
   * folder sharing shows every deck in the folder. Left-join `deckGrant` and
   * `folderGrant`, filter by `visible`, select `roles` and read the role
   * with `listedRole`. At most one row of each per deck (both are keyed by
   * user), so a deck appears once.
   */
  function accessJoins(userId: string) {
    return {
      deckGrant: and(eq(deckPermissions.deckId, decks.id), eq(deckPermissions.userId, userId)),
      folderGrant: and(
        eq(folderPermissions.folderId, decks.folderId),
        eq(folderPermissions.userId, userId),
      ),
      visible: sql`(${deckPermissions.role} IS NOT NULL OR ${folderPermissions.role} IS NOT NULL)`,
      roles: { deckRole: deckPermissions.role, folderRole: folderPermissions.role },
    }
  }

  /** The user's role on a listed deck: the higher of their deck grant and folder role (`visible` guarantees one). */
  function listedRole(r: { deckRole: DeckRole | null; folderRole: DeckRole | null }): DeckRole {
    return higherRole(r.deckRole, r.folderRole) ?? 'viewer'
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

    // Decks the user may see: a deck grant or the deck's folder (accessJoins),
    // in one query that also yields both roles — no N+1.
    const access = accessJoins(userId)
    const rows = await db
      .select({ deck: decks, ...access.roles })
      .from(decks)
      .leftJoin(deckPermissions, access.deckGrant)
      .leftJoin(folderPermissions, access.folderGrant)
      .where(
        filterFolderId !== null
          ? and(access.visible, eq(decks.folderId, filterFolderId))
          : access.visible,
      )
      .orderBy(decks.createdAt)
    return rows.map((r) => ({ ...deckRecord(r.deck), viewerRole: listedRole(r) }))
  }

  /**
   * `list` as a keyset-paged, filtered list of lean items, newest change
   * first: ORDER BY last change DESC, id DESC, and a page continues with
   * `(last change, id) < (key, id)`. Fetches `limit + 1` rows to know whether
   * another page follows. Access is `list`'s: a deck grant or membership of
   * the deck's folder (accessJoins, which also yield the role), or in
   * BYPASS_AUTH dev mode the decks of dev-user and the legacy demo-user
   * (role owner).
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

    // BYPASS_AUTH=true dev fallback: the decks of dev-user and the legacy demo-user, as owner.
    async function bypassPage() {
      const found = await db
        .select(columns)
        .from(decks)
        .leftJoin(lastStore, eq(lastStore.deckId, decks.id))
        .where(and(inArray(decks.ownerUserId, ['dev-user', 'demo-user']), ...filters))
        .orderBy(...order)
        .limit(limit + 1)
      return found.map((r) => ({ ...r, role: 'owner' as DeckRole }))
    }

    async function accessiblePage(userId: string) {
      const access = accessJoins(userId)
      const found = await db
        .select({ ...columns, ...access.roles })
        .from(decks)
        .leftJoin(lastStore, eq(lastStore.deckId, decks.id))
        .leftJoin(deckPermissions, access.deckGrant)
        .leftJoin(folderPermissions, access.folderGrant)
        .where(and(access.visible, ...filters))
        .orderBy(...order)
        .limit(limit + 1)
      return found.map((r) => ({ ...r, role: listedRole(r) }))
    }

    const rows = deps.bypass === true ? await bypassPage() : await accessiblePage(args.userId)

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

    // The target folder: one the user may change (editor) when named, else
    // Drafts (auto-provisioned for a brand-new user).
    let targetFolderId: string
    if (args.folderId) {
      targetFolderId = (
        await requireFolderRole(db, args.folderId, ownerUserId, 'editor', { bypass: deps.bypass })
      ).id
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

    // Where the copy goes: the named folder (editor needed), else the
    // source's folder when the user may add decks to it, else their Drafts.
    let targetFolderId: string
    if (args.folderId !== undefined) {
      targetFolderId = (
        await requireFolderRole(db, args.folderId, args.userId, 'editor', { bypass: deps.bypass })
      ).id
    } else {
      const sourceRole =
        source.folderId === null
          ? null
          : await resolveFolderAccess(db, {
              folderId: source.folderId,
              userId: args.userId,
              alsoAs: bypassAliases(deps.bypass),
            })
      targetFolderId =
        source.folderId !== null && sourceRole !== null && roleAtLeast(sourceRole.role, 'editor')
          ? source.folderId
          : await getOrProvisionDrafts(deps, args.userId)
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

    const [deleted] = await db
      .delete(decks)
      .where(eq(decks.id, id))
      .returning({ id: decks.id, folderId: decks.folderId })
    if (!deleted) throw notFound('Deck not found')
    // Nobody may keep the deck open, and its guests read its folder's token
    // document through it: close both, so everyone else reconnects and is
    // authorised again.
    closeDeckConnections(id)
    if (deleted.folderId !== null) closeConnectionsForDocument(`folder:${deleted.folderId}`)

    const explicitKeys = assetRows.flatMap((r) =>
      [r.storageKey, r.playbackKey, r.posterKey, r.thumbnailKey].filter(
        (k): k is string => typeof k === 'string' && k !== '',
      ),
    )
    // Pass 1: sweep decks/<id>/ (thumbnail, worker video outputs, exports).
    // Pass 2: explicit keys (tus originals + their .info sidecars).
    // Neither deletes a file another media row still names (a pre-0009
    // folder font stored under this deck's prefix, say). Both loss-tolerant:
    // errors are logged and swallowed.
    await Promise.all([
      purgeDeckBucketPrefix(db, id, deps.log),
      purgeUnreferencedKeys(db, explicitKeys, deps.log),
    ])
    // What was too young to sweep (a transcode or a copy still writing).
    sweepAgainAfterGrace(() => purgeDeckBucketPrefix(db, id, deps.log), deps.log, { deckId: id })
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

    // Moving a deck changes who sees it (folder sharing): editor in both
    // folders, and the owner role on every deck moved.
    const source = await requireFolderRole(db, sourceFolderId, userId, 'editor', {
      bypass: deps.bypass,
      notFoundMessage: 'Source folder not found',
    })
    await requireFolderRole(db, destFolderId, userId, 'editor', {
      bypass: deps.bypass,
      notFoundMessage: 'Destination folder not found',
    })

    const deckRows = await db
      .select({ id: decks.id, folderId: decks.folderId })
      .from(decks)
      .where(inArray(decks.id, ids))
    const notInSrc = deckRows.filter((d) => d.folderId !== sourceFolderId)
    if (notInSrc.length > 0) {
      throw badRequest('Some decks are not in the source folder', { count: notInSrc.length })
    }
    if (deckRows.length !== ids.length) throw badRequest('Some deck ids not found')

    // The deck role is the higher of the deck grant and the source folder's
    // role (resolveDeckAccess): the folder's owner owns every deck in it, an
    // editor only those they hold an owner grant on — one query for all.
    const moved = deckRows.map((d) => d.id)
    if (source.role !== 'owner') {
      const owned = await db
        .select({ deckId: deckPermissions.deckId })
        .from(deckPermissions)
        .where(
          and(
            inArray(deckPermissions.deckId, moved),
            inArray(deckPermissions.userId, ownerIdsFor(userId, deps.bypass)),
            eq(deckPermissions.role, 'owner'),
          ),
        )
      const ownedIds = new Set(owned.map((o) => o.deckId))
      if (moved.some((id) => !ownedIds.has(id))) {
        throw forbidden('Forbidden: moving a deck needs the owner role on it')
      }
    }

    // The pictures and videos the decks link from the source folder (its
    // components', its own) cannot be shown in the destination: copy them
    // into the decks first, point each deck at its copies and record the
    // pairs, so no reader ever meets a reference it cannot load and a later
    // undo is re-pointed rather than copied again (services/localiseMedia.ts).
    // A copy that fails or is refused stops the move before any deck changes
    // folders. Decks handled earlier in this loop may already show their own
    // copies by then: that changes nothing a reader sees (same pictures),
    // and a retry reuses the recorded copies — re-pointing is idempotent.
    // References that were broken already (`unresolved`) do not stop it.
    const crosses = sourceFolderId !== destFolderId
    const localise = (deckId: string) =>
      localiseLinkedMedia(deps, {
        userId,
        deckId,
        fromFolderId: sourceFolderId,
        toFolderId: destFolderId,
      })
    const takenBefore = new Map<string, number>()
    if (crosses) {
      for (const id of moved) {
        const first = await localise(id)
        if (first.refused > 0) {
          throw forbidden(
            `Moving deck '${id}': ${first.refused} of the pictures and videos it links from its folder ` +
              'may not be copied by you, so no deck changed folders.',
          )
        }
        if (first.copyFailed > 0) {
          throw failed(
            `Moving deck '${id}': ${first.copyFailed} of the pictures and videos it links from its folder ` +
              'could not be copied into it, so no deck changed folders. Try again (copies already made are ' +
              'reused); if it keeps failing, the media storage is unavailable.',
            503,
          )
        }
        takenBefore.set(id, first.copied + first.repointed)
      }
    }

    // Only decks still in the source folder move, all or none: a deck moved
    // away since the checks above fails the whole move.
    const result = await db
      .transaction(async (tx) => {
        const rows = await tx
          .update(decks)
          .set({ folderId: destFolderId, updatedAt: new Date() })
          .where(and(inArray(decks.id, moved), eq(decks.folderId, sourceFolderId)))
          .returning({ id: decks.id })
        if (rows.length !== moved.length) {
          tx.rollback()
        }
        return rows
      })
      .catch((err: unknown) => {
        if (err instanceof TransactionRollbackError) {
          throw conflict('Some decks left the source folder while they were being moved')
        }
        throw err
      })

    // Who may open the moved decks changed: close every live connection on
    // them, and on the source folder's token document (the moved decks'
    // guests read it through them), so each reconnects and is authorised
    // again — the members of the new folder in, anyone else out.
    for (const r of result) closeDeckConnections(r.id)
    closeConnectionsForDocument(`folder:${sourceFolderId}`)

    // A collaborator may have linked another picture of the source folder
    // while the decks moved: catch it up (usually there is nothing left).
    // The deck has moved by now; what this pass cannot copy is reported.
    const media: MovedDeckMedia[] = []
    if (crosses) {
      for (const r of result) {
        const copied = takenBefore.get(r.id) ?? 0
        try {
          const after = await localise(r.id)
          media.push({
            deckId: r.id,
            copied: copied + after.copied,
            unresolved: after.unresolved,
            copyFailed: after.copyFailed,
          })
          if (after.copyFailed > 0) {
            deps.log.warn(
              { deckId: r.id, copyFailed: after.copyFailed },
              'move-decks: linked media a collaborator added during the move could not be copied',
            )
          }
        } catch (err) {
          deps.log.warn({ err, deckId: r.id }, 'move-decks: catching up linked media failed')
          media.push({
            deckId: r.id,
            copied,
            unresolved: 0,
            copyFailed: 0,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    const tokens = await rebindTokens(
      result.map((r) => r.id),
      sourceFolderId,
      destFolderId,
      args.origin,
    )
    return { movedCount: result.length, tokens, media }
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
    if (deck.folderId === args.destFolderId) return { movedCount: 0, tokens: [], media: [] }
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
    // Folder membership; anything else is "not found" (no existence oracle).
    const member = await resolveFolderAccess(db, {
      folderId: args.folderId,
      userId: args.userId,
      alsoAs: bypassAliases(deps.bypass),
    })
    if (!member) throw notFound('Folder not found')

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
