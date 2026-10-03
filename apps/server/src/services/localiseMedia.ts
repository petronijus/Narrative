/**
 * services/localiseMedia.ts — a deck leaving its folder takes its linked
 * media along (folder sharing, step 2; docs/plans/folder-sharing.md).
 *
 * A deck may show the pictures and videos of its folder's components and of
 * the folder itself without owning them (media/visibleMedia.ts). Moved to
 * another folder it may no longer show them, and nobody of the new folder
 * could load them. So the move copies every such asset the deck references
 * into the deck (deck-owned rows, under its prefix), points the live
 * document at the copies through the sync server and records each pair —
 * the asset, its copy, the folder it came from, who moved the deck — in
 * `deck_moved_media` (`localiseLinkedMedia`, called by `moveDecks` before
 * and after the deck changes folders).
 *
 * Old references can come back after the move: an undo in an editor that
 * had the deck open, or an agent run's revert, restores the asset ids the
 * deck showed before. `repointMovedMedia` — after a revert, and after the
 * sync server stores the deck — points them at the recorded copies again.
 * Its rule, so that neither undo/redo cycles nor a reference a client
 * plants can multiply storage:
 *
 *   - only ids recorded for this deck are touched: an id the deck did not
 *     reference when it moved is never copied (it stays as it is, and the
 *     new folder cannot load it);
 *   - a recorded id is re-pointed at its copy, however often it comes back;
 *     nothing is copied for it;
 *   - a fresh copy is made only when the recorded copy is gone (its row
 *     deleted, or its file), at most once per recorded id (`recopied_at`),
 *     at most `RECOPY_PER_PASS` per pass, on the authority of the person who
 *     moved the deck (they must still read the folder it came from) and
 *     charged to their media copy budget (services/mediaCopyBudget.ts). A
 *     video is copied with its finished outputs or not at all: nothing on
 *     this path queues a transcode.
 *
 * A write that staged linked media for the deck's folder and landed after
 * the deck moved (a stamp, a paste, a slide insert loaded before the move)
 * carries what it linked itself, in its `settle` step
 * (`carryLinkedMediaAfterWrite`): on the writer's authority and budget, and
 * recorded like a move's copies, so a later undo finds them.
 *
 * Every localisation of one deck runs after the previous one has finished
 * (one process holds the documents; see `serialised`) — a move's passes, a
 * store, a revert and a settle never interleave their reads and writes.
 */

import type * as Y from 'yjs'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { deckMovedMedia, decks, mediaAssets, users } from '../db/schema.js'
import {
  linkFolderOf,
  readPlacedMedia,
  visibleIn,
  type MediaHolder,
} from '../media/visibleMedia.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import type { ServiceDeps } from './deps.js'
import { copyMedia, pointAssetsAt, referencedAssets, type CopiedMedia } from './deckInsert.js'
import { ServiceError } from './errors.js'
import { loadedDocument, readDocCopy, SERVER_EDIT_ORIGIN, writeLiveDoc } from './liveDocs.js'
import { discardDeckMedia, registerDeckMedia } from '../pptx/importDeck.js'

/** Fresh copies one repair pass makes at most; the next store continues. */
export const RECOPY_PER_PASS = 10

/** What one localisation did. */
export interface LocaliseReport {
  /** Assets copied into the deck by this pass (its references now point at the copies). */
  copied: number
  /** References pointed at a copy made earlier (nothing copied for them). */
  repointed: number
  /**
   * References left as they were: their asset is gone or another deck's,
   * linked media the person acting may not read (`refused`), an id the move
   * never recorded, a copy that may not be made again. They were broken
   * before, or would only be shown by the folder they came from.
   */
  unresolved: number
  /** Of `unresolved`: linked media the person acting may not read. */
  refused: number
  /** Copies that failed in storage: the asset is fine, trying again may work. */
  copyFailed: number
}

/** A localisation's report, with the asset ids whose references it replaced. */
export interface LocaliseOutcome extends LocaliseReport {
  replaced: ReadonlySet<string>
}

const NOTHING: LocaliseOutcome = {
  copied: 0,
  repointed: 0,
  unresolved: 0,
  refused: 0,
  copyFailed: 0,
  replaced: new Set(),
}

const NO_COPIES: CopiedMedia = {
  idMap: new Map(),
  rows: [],
  videoJobs: [],
  linked: new Set(),
  unresolved: 0,
  refused: 0,
  copyFailed: 0,
}

// ---------------------------------------------------------------------------
// One localisation per deck at a time
// ---------------------------------------------------------------------------

/**
 * Per database, the tail of each deck's queue of localisations and the decks
 * whose store-time check is running — keyed by the database so that two
 * worlds in one process (tests) never share a queue.
 */
interface DeckQueues {
  tails: Map<string, Promise<unknown>>
  checks: Map<string, { again: boolean }>
}
const queuesByDb = new WeakMap<object, DeckQueues>()

function queuesOf(deps: Pick<ServiceDeps, 'db'>): DeckQueues {
  let queues = queuesByDb.get(deps.db)
  if (queues === undefined) {
    queues = { tails: new Map(), checks: new Map() }
    queuesByDb.set(deps.db, queues)
  }
  return queues
}

/**
 * Run `fn` after every localisation of `deckId` queued before it has
 * settled. `fn` must not queue another localisation of the same deck (it
 * would wait for itself): the exported entry points queue, the `…Now`
 * functions they wrap do not.
 */
function serialised<T>(deps: ServiceDeps, deckId: string, fn: () => Promise<T>): Promise<T> {
  const { tails } = queuesOf(deps)
  const before = tails.get(deckId) ?? Promise.resolve()
  const run = before.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  tails.set(deckId, tail)
  void tail.then(() => {
    if (tails.get(deckId) === tail) tails.delete(deckId)
  })
  return run
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

/** The asset ids the deck references now: from the live document when it is loaded, else stored. */
async function currentReferences(deps: ServiceDeps, deckId: string): Promise<Set<string>> {
  const live = loadedDocument(deps, 'deck', deckId)
  if (live !== null) return referencedAssets(live.getArray<Y.Map<unknown>>('slides').toArray())
  const copy = await readDocCopy(deps, 'deck', deckId)
  try {
    return referencedAssets(copy.getArray<Y.Map<unknown>>('slides').toArray())
  } finally {
    copy.destroy()
  }
}

/** Whether a stored object exists: false only when storage says it does not. */
async function storedObjectMissing(deps: ServiceDeps, key: string): Promise<boolean> {
  try {
    await buildS3Client().send(new HeadObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }))
    return false
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    if (status === 404 || (err as { name?: string }).name === 'NotFound') return true
    // Storage cannot say: the copy's row still stands, and no reason to copy again.
    deps.log.warn({ err, key }, 'localise media: checking a copy in storage failed')
    return false
  }
}

/**
 * The recorded copies among `copyIds` that still serve the deck: a row the
 * deck owns whose stored original exists.
 */
async function livingCopies(
  deps: ServiceDeps,
  deckId: string,
  copyIds: readonly string[],
): Promise<Set<string>> {
  if (copyIds.length === 0) return new Set()
  const rows = await deps.db
    .select({ id: mediaAssets.id, storageKey: mediaAssets.storageKey })
    .from(mediaAssets)
    .where(and(inArray(mediaAssets.id, [...copyIds]), eq(mediaAssets.deckId, deckId)))
  const alive = new Set<string>()
  for (const row of rows) {
    if (!(await storedObjectMissing(deps, row.storageKey))) alive.add(row.id)
  }
  return alive
}

interface MovedPair {
  sourceAssetId: string
  copyAssetId: string
  fromFolderId: string | null
  movedBy: string
}

/**
 * Record (or replace) the copies a move or a settle made. The mover is
 * stored only when they have a `users` row (a BYPASS_AUTH dev principal has
 * none; such a row can be re-pointed but never copied again).
 */
async function recordPairs(deps: ServiceDeps, deckId: string, pairs: MovedPair[]): Promise<void> {
  if (pairs.length === 0) return
  const now = new Date()
  await deps.db
    .insert(deckMovedMedia)
    .values(
      pairs.map((p) => ({
        deckId,
        sourceAssetId: p.sourceAssetId,
        copyAssetId: p.copyAssetId,
        fromFolderId: p.fromFolderId,
        movedByUserId: sql<
          string | null
        >`(select ${users.sub} from ${users} where ${users.sub} = ${p.movedBy})`,
        movedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [deckMovedMedia.deckId, deckMovedMedia.sourceAssetId],
      set: {
        copyAssetId: sql`excluded.copy_asset_id`,
        fromFolderId: sql`excluded.from_folder_id`,
        movedByUserId: sql`excluded.moved_by_user_id`,
        movedAt: sql`excluded.moved_at`,
      },
    })
}

/**
 * Register the staged copies for the deck (each batch under the person it
 * was copied for), then point the live document at `idMap` — new copies
 * and reused ones alike — in one server write. When the write never
 * started, the staged copies are discarded again.
 */
async function pointDeckAt(
  deps: ServiceDeps,
  args: {
    deckId: string
    staged: ReadonlyArray<{ ownerUserId: string; copies: CopiedMedia }>
    idMap: ReadonlyMap<string, string>
    /** Set once the write started: the document may show the copies even if this throws. */
    touched?: { value: boolean }
  },
): Promise<void> {
  const { db, log } = deps
  const { deckId } = args
  const registered: Array<{ mediaAssetRows: CopiedMedia['rows'] }> = []
  const discardAll = async () => {
    for (const media of registered) await discardDeckMedia({ db, deckId, media, log })
  }
  try {
    for (const { ownerUserId, copies } of args.staged) {
      if (copies.rows.length === 0) continue
      const media = { mediaAssetRows: copies.rows, videoTranscodeJobs: copies.videoJobs }
      registered.push(media)
      await registerDeckMedia({ db, deckId, ownerUserId, media, log })
    }
  } catch (err) {
    await discardAll()
    throw err
  }
  const touched = args.touched ?? { value: false }
  try {
    await writeLiveDoc(
      deps,
      'deck',
      deckId,
      (doc) => pointAssetsAt(doc.getArray<Y.Map<unknown>>('slides').toArray(), args.idMap),
      SERVER_EDIT_ORIGIN,
      touched,
    )
  } catch (err) {
    // Touched: the document may already show the copies; they stay.
    if (!touched.value) await discardAll()
    throw err
  }
}

/**
 * Take the media `deckId` links from `fromFolderId` along into the deck, as
 * a deck in `toFolderId`: of the ids it references (only those in `only`,
 * when given) that it may not show in `toFolderId`, a recorded copy that
 * still serves is reused, anything else is copied on `userId`'s authority
 * (copyMedia: they must read its folder), and every new pair is recorded.
 * Runs inside the deck's queue.
 */
async function takeAlongNow(
  deps: ServiceDeps,
  args: {
    userId: string
    deckId: string
    fromFolderId: string
    toFolderId: string | null
    only?: ReadonlySet<string>
    budgeted: boolean
  },
): Promise<LocaliseOutcome> {
  const { db } = deps
  const { deckId } = args
  const refs = await currentReferences(deps, deckId)
  const ids = [...refs].filter((id) => args.only === undefined || args.only.has(id))
  if (ids.length === 0) return NOTHING

  // What the deck may not show in the destination and has a copy of already.
  const to: MediaHolder = { owner: { deckId }, folderId: args.toFolderId }
  const placed = new Map((await readPlacedMedia(db, ids)).map((r) => [r.id, r]))
  const notShown = ids.filter((id) => {
    const row = placed.get(id)
    return row === undefined || !visibleIn(row, to)
  })
  const recorded =
    notShown.length === 0
      ? []
      : await db
          .select({ source: deckMovedMedia.sourceAssetId, copy: deckMovedMedia.copyAssetId })
          .from(deckMovedMedia)
          .where(
            and(eq(deckMovedMedia.deckId, deckId), inArray(deckMovedMedia.sourceAssetId, notShown)),
          )
  const alive = await livingCopies(
    deps,
    deckId,
    recorded.map((r) => r.copy).filter((c): c is string => c !== null),
  )
  const idMap = new Map<string, string>()
  for (const r of recorded) if (r.copy !== null && alive.has(r.copy)) idMap.set(r.source, r.copy)
  const repointed = idMap.size

  const rest = new Set(ids.filter((id) => !idMap.has(id)))
  const staged =
    rest.size === 0
      ? NO_COPIES
      : await copyMedia(deps, {
          userId: args.userId,
          // The same deck before and after: what it may show in the old
          // folder but not in the new one — its folder's linked media — is
          // copied; its own media is visible in both and stays.
          source: { deckId },
          sourceFolderId: args.fromFolderId,
          target: { deckId },
          targetFolderId: args.toFolderId,
          assetIds: rest,
          families: new Set(),
          budgeted: args.budgeted,
        })
  for (const [from, copy] of staged.idMap) idMap.set(from, copy)
  const report = {
    copied: staged.idMap.size,
    repointed,
    unresolved: staged.unresolved,
    refused: staged.refused,
    copyFailed: staged.copyFailed,
  }
  if (idMap.size === 0) return { ...report, replaced: new Set() }

  const pairs = [...staged.idMap].map(([sourceAssetId, copyAssetId]) => ({
    sourceAssetId,
    copyAssetId,
    fromFolderId: linkFolderOf(placed.get(sourceAssetId)!) ?? args.fromFolderId,
    movedBy: args.userId,
  }))
  const touched = { value: false }
  try {
    await pointDeckAt(deps, {
      deckId,
      staged: [{ ownerUserId: args.userId, copies: staged }],
      idMap,
      touched,
    })
  } catch (err) {
    // Written, then failed (the store): the copies stand — record them.
    if (touched.value) await recordPairs(deps, deckId, pairs)
    throw err
  }
  await recordPairs(deps, deckId, pairs)
  return { ...report, replaced: new Set(idMap.keys()) }
}

// ---------------------------------------------------------------------------
// Moving a deck
// ---------------------------------------------------------------------------

/**
 * Copy the media of `fromFolderId` that the deck links into the deck (or
 * point it at the copies an earlier pass made), point the deck at them and
 * record each pair, on `userId`'s authority — the person moving the deck,
 * an editor of both folders. Unbudgeted, like the move itself. Idempotent:
 * a deck that links nothing of that folder is read and left alone.
 */
export function localiseLinkedMedia(
  deps: ServiceDeps,
  args: { userId: string; deckId: string; fromFolderId: string; toFolderId: string | null },
): Promise<LocaliseOutcome> {
  return serialised(deps, args.deckId, () => takeAlongNow(deps, { ...args, budgeted: false }))
}

// ---------------------------------------------------------------------------
// A write that landed after the deck moved
// ---------------------------------------------------------------------------

/**
 * After a write that staged `assetIds` as linked media of `stagedFolderId`
 * (the deck's folder when the write was staged): if the deck has changed
 * folders since, carry those of them it still references into the deck —
 * on `userId`'s authority (copyMedia: they must read the folder) and budget,
 * recorded like a move's copies. Null when there was nothing to do (the
 * common case: the deck did not move — one query).
 */
export function carryLinkedMedia(
  deps: ServiceDeps,
  args: {
    userId: string
    deckId: string
    assetIds: ReadonlySet<string>
    stagedFolderId: string | null
  },
): Promise<LocaliseReport | null> {
  if (args.assetIds.size === 0 || args.stagedFolderId === null) return Promise.resolve(null)
  const fromFolderId = args.stagedFolderId
  return serialised(deps, args.deckId, async () => {
    const [deck] = await deps.db
      .select({ folderId: decks.folderId })
      .from(decks)
      .where(eq(decks.id, args.deckId))
      .limit(1)
    if (deck === undefined || deck.folderId === fromFolderId) return null
    return takeAlongNow(deps, {
      userId: args.userId,
      deckId: args.deckId,
      fromFolderId,
      toFolderId: deck.folderId,
      only: args.assetIds,
      budgeted: true,
    })
  })
}

/**
 * `carryLinkedMedia` for a command's or a route's `settle` step: best
 * effort, never throws — the write stands, and what could not be carried is
 * logged (it stays unresolved in the new folder).
 */
export async function carryLinkedMediaAfterWrite(
  deps: ServiceDeps,
  args: {
    userId: string
    deckId: string
    assetIds: ReadonlySet<string>
    stagedFolderId: string | null
    /** What wrote, for the log ("stamp", "slide insert", …). */
    what: string
  },
): Promise<void> {
  const { what, ...carry } = args
  try {
    const report = await carryLinkedMedia(deps, carry)
    if (report !== null && (report.copied > 0 || report.repointed > 0 || report.unresolved > 0)) {
      deps.log.info(
        { deckId: args.deckId, from: args.stagedFolderId, ...report },
        `${what}: the deck changed folders while it was written; its linked media was carried along`,
      )
    }
  } catch (err) {
    deps.log.warn(
      { err, deckId: args.deckId, from: args.stagedFolderId },
      `${what}: carrying linked media into a deck that changed folders failed`,
    )
  }
}

// ---------------------------------------------------------------------------
// Old references an undo or a revert brought back
// ---------------------------------------------------------------------------

type MovedRow = typeof deckMovedMedia.$inferSelect

/**
 * Point the references to recorded source assets that the deck may not
 * show where it is now at their recorded copies; copy once more what lost
 * its copy, under the rule of the file header. Null when there was nothing
 * to do: the deck never took media along, or references none of it now.
 */
export function repointMovedMedia(
  deps: ServiceDeps,
  deckId: string,
): Promise<LocaliseReport | null> {
  return serialised(deps, deckId, () => repointNow(deps, deckId))
}

async function repointNow(deps: ServiceDeps, deckId: string): Promise<LocaliseReport | null> {
  const { db, log } = deps
  // One indexed query per store for every deck that never moved.
  const recorded = await db.select().from(deckMovedMedia).where(eq(deckMovedMedia.deckId, deckId))
  if (recorded.length === 0) return null
  const refs = await currentReferences(deps, deckId)
  const candidates = recorded.filter((r) => refs.has(r.sourceAssetId))
  if (candidates.length === 0) return null
  const [deck] = await db
    .select({ folderId: decks.folderId })
    .from(decks)
    .where(eq(decks.id, deckId))
    .limit(1)
  if (deck === undefined) return null

  // What the deck may show where it is now (it moved back) stays as it is.
  const holder: MediaHolder = { owner: { deckId }, folderId: deck.folderId }
  const placed = new Map(
    (
      await readPlacedMedia(
        db,
        candidates.map((r) => r.sourceAssetId),
      )
    ).map((r) => [r.id, r]),
  )
  const due = candidates.filter((r) => {
    const row = placed.get(r.sourceAssetId)
    return row === undefined || !visibleIn(row, holder)
  })
  if (due.length === 0) return null

  const alive = await livingCopies(
    deps,
    deckId,
    due.map((r) => r.copyAssetId).filter((c): c is string => c !== null),
  )
  const idMap = new Map<string, string>()
  const gone: MovedRow[] = []
  for (const r of due) {
    if (r.copyAssetId !== null && alive.has(r.copyAssetId))
      idMap.set(r.sourceAssetId, r.copyAssetId)
    else gone.push(r)
  }
  const report: LocaliseReport = {
    copied: 0,
    repointed: idMap.size,
    unresolved: 0,
    refused: 0,
    copyFailed: 0,
  }

  // The copy is gone: copy once more — never twice for one row, never an
  // unfinished video, only while the mover may still read its folder.
  const eligible = gone.filter((r) => {
    const row = placed.get(r.sourceAssetId)
    return (
      r.recopiedAt === null &&
      r.movedByUserId !== null &&
      r.fromFolderId !== null &&
      row !== undefined &&
      linkFolderOf(row) === r.fromFolderId &&
      (row.kind !== 'video' || row.transcodeStatus === 'done')
    )
  })
  const batch = eligible.slice(0, RECOPY_PER_PASS)
  report.unresolved += gone.length - batch.length
  const claimed = await claimRecopies(
    deps,
    deckId,
    batch.map((r) => r.sourceAssetId),
  )
  const groups = new Map<string, { movedBy: string; fromFolderId: string; ids: Set<string> }>()
  for (const r of batch) {
    if (!claimed.has(r.sourceAssetId)) {
      report.unresolved++
      continue
    }
    const key = `${r.movedByUserId}\u0000${r.fromFolderId}`
    const group = groups.get(key) ?? {
      movedBy: r.movedByUserId!,
      fromFolderId: r.fromFolderId!,
      ids: new Set<string>(),
    }
    group.ids.add(r.sourceAssetId)
    groups.set(key, group)
  }

  const recopied = new Map<string, string>()
  const staged: Array<{ ownerUserId: string; copies: CopiedMedia }> = []
  const touched = { value: false }
  try {
    for (const group of groups.values()) {
      let copies: CopiedMedia
      try {
        copies = await copyMedia(deps, {
          userId: group.movedBy,
          source: { deckId },
          sourceFolderId: group.fromFolderId,
          target: { deckId },
          targetFolderId: deck.folderId,
          assetIds: group.ids,
          families: new Set(),
          budgeted: true,
          transcodes: false,
        })
      } catch (err) {
        // The mover's copy budget is spent: nothing was copied; a later store tries again.
        if (err instanceof ServiceError && err.status === 429) {
          log.warn(
            { deckId, movedBy: group.movedBy, assets: group.ids.size },
            "old folder media: the mover's media copy budget is spent; copying again later",
          )
          report.unresolved += group.ids.size
          continue
        }
        throw err
      }
      staged.push({ ownerUserId: group.movedBy, copies })
      for (const [from, copy] of copies.idMap) recopied.set(from, copy)
      report.unresolved += copies.unresolved
      report.refused += copies.refused
      report.copyFailed += copies.copyFailed
    }
    // Claimed but not copied (budget, read refused, storage): not spent.
    await releaseRecopies(
      deps,
      deckId,
      [...claimed].filter((id) => !recopied.has(id)),
    )
    if (idMap.size === 0 && recopied.size === 0) return report
    for (const [from, copy] of recopied) idMap.set(from, copy)
    await pointDeckAt(deps, { deckId, staged, idMap, touched })
  } catch (err) {
    // Not written: the claims are not spent. Written (the store after it
    // failed): the copies stand and are recorded below like a success.
    if (!touched.value) {
      await releaseRecopies(deps, deckId, [...claimed])
      throw err
    }
    log.warn({ err, deckId }, 'old folder media: the re-pointing write reported a failure')
  }
  for (const [sourceAssetId, copyAssetId] of recopied) {
    await db
      .update(deckMovedMedia)
      .set({ copyAssetId })
      .where(
        and(eq(deckMovedMedia.deckId, deckId), eq(deckMovedMedia.sourceAssetId, sourceAssetId)),
      )
  }
  report.copied = recopied.size
  log.info({ deckId, ...report }, 'old folder media an undo brought back was re-pointed')
  return report
}

/** Mark rows as copied once more; returns the source ids this pass got (not already spent). */
async function claimRecopies(
  deps: ServiceDeps,
  deckId: string,
  sourceIds: readonly string[],
): Promise<Set<string>> {
  if (sourceIds.length === 0) return new Set()
  const rows = await deps.db
    .update(deckMovedMedia)
    .set({ recopiedAt: new Date() })
    .where(
      and(
        eq(deckMovedMedia.deckId, deckId),
        inArray(deckMovedMedia.sourceAssetId, [...sourceIds]),
        isNull(deckMovedMedia.recopiedAt),
      ),
    )
    .returning({ source: deckMovedMedia.sourceAssetId })
  return new Set(rows.map((r) => r.source))
}

/** Give claims back that made no copy. */
async function releaseRecopies(
  deps: ServiceDeps,
  deckId: string,
  sourceIds: readonly string[],
): Promise<void> {
  if (sourceIds.length === 0) return
  await deps.db
    .update(deckMovedMedia)
    .set({ recopiedAt: null })
    .where(
      and(eq(deckMovedMedia.deckId, deckId), inArray(deckMovedMedia.sourceAssetId, [...sourceIds])),
    )
}

/**
 * `repointMovedMedia` after the sync server stored the deck, off the
 * store's path: at most one check per deck at a time, and one more when
 * stores arrived while it ran (a debounced store per editing burst). Errors
 * are logged; the next store tries again.
 */
export function checkMovedMediaAfterStore(deps: ServiceDeps, deckId: string): void {
  const { checks } = queuesOf(deps)
  const running = checks.get(deckId)
  if (running !== undefined) {
    running.again = true
    return
  }
  const state = { again: false }
  checks.set(deckId, state)
  void (async () => {
    try {
      do {
        state.again = false
        await repointMovedMedia(deps, deckId)
      } while (state.again)
    } catch (err) {
      deps.log.warn({ err, deckId }, 're-pointing old folder media in a stored deck failed')
    } finally {
      checks.delete(deckId)
    }
  })()
}

/** Wait for the deck's queued localisations and store-time checks (tests). */
export async function localisationsSettled(deps: ServiceDeps, deckId: string): Promise<void> {
  const { tails, checks } = queuesOf(deps)
  while (checks.has(deckId) || tails.has(deckId)) {
    await (tails.get(deckId) ?? new Promise((r) => setTimeout(r, 5)))
  }
}
