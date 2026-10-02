/**
 * services/deckInsert.ts
 *
 * `deck.insertFrom` with another Narrative deck as the source: copy slides —
 * objects, animations, speaker notes, transition, background, name — into a
 * target deck at an index, as one write.
 *
 * Staging (asynchronous, before the target document is touched):
 *
 *   1. The caller must be an editor (or owner) of the source deck — the
 *      rule for exporting it (`deck.exportPptx`), because copying slides
 *      into a deck of one's own is an export by other means: a viewer who
 *      could copy could take the whole deck, media included, somewhere its
 *      owner never shared it. A deck they cannot read at all answers "not
 *      found", like one that does not exist; one they can only view answers
 *      "forbidden".
 *   2. The source is read LIVE (liveDocs.ts) into a scratch copy; every
 *      rewrite below happens in that copy, never in the source.
 *   3. Media is deck-scoped (a slide may only show assets whose row belongs
 *      to its deck), so every asset the copied slides reference is copied:
 *      the stored object(s) under the target deck's namespace
 *      (`decks/<target>/…`, reaped with the target) and a new
 *      `media_assets` row for the target, and the references in the copied
 *      slides are pointed at the new ids. A finished video keeps its
 *      transcoded outputs; an unfinished one is transcoded again. The
 *      source deck's own fonts (deck-scoped copies of deleted folder fonts)
 *      that the copied text uses come along the same way. The rows are
 *      committed before the document write — the same order as the .pptx
 *      path (pptx/appendDeck.ts), so the worst a crash leaves is rows
 *      nothing references.
 *   4. Links to other slides inside the copied range are pointed at the
 *      copies; links to source slides that were not copied are removed
 *      (they would jump nowhere in the target).
 *   5. Across folders, token references are rebound with the rule of
 *      `deck.moveToFolder` (services/tokenRebind.ts).
 *
 * Applying (synchronous, in the host's one transaction on the target):
 * clone the prepared slide maps with fresh slide ids and insert them at the
 * clamped index. Object ids are kept — they are unique per slide, and the
 * animations that target them stay valid.
 */

import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import { and, eq, inArray } from 'drizzle-orm'
import { CopyObjectCommand } from '@aws-sdk/client-s3'
import {
  createSlideDoc,
  getSlideObjectsCtx,
  hydrateSlideDoc,
  type DeckMutationContext,
  type ObjectsMutationContext,
  readFolderTokens,
} from '@narrative/slide-model'
import {
  applyInsertPlan,
  planInsert,
  sameDocument,
  levelOf,
  normalizeOutline,
  shiftBlockLevels,
  type InsertPlan,
  type ObjectInsertResult,
  type PreparedObjectInsert,
  type PreparedSlideInsert,
  type SlideInsertResult,
} from '@narrative/commands'
import { components, decks, mediaAssets } from '../db/schema.js'
import { resolveDeckAccess, roleAtLeast } from '../auth/permissions.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { extensionFromMimeOrFilename } from '../media/uploadPolicy.js'
import {
  discardDeckMedia,
  discardOwnedMedia,
  registerDeckMedia,
  registerOwnedMedia,
  type StagedDeckMedia,
} from '../pptx/importDeck.js'
import { mediaOriginalPath, mediaOwnerPrefix, type MediaOwner } from '../media/mediaOwner.js'
import { readPlacedMedia, visibleIn, type MediaHolder } from '../media/visibleMedia.js'
import type { ServiceDeps } from './deps.js'
import { badRequest, forbidden, notFound } from './errors.js'
import { readDocCopy, SERVER_EDIT_ORIGIN, writeLiveDoc } from './liveDocs.js'
import { requireComponentRole } from './shared.js'
import { applyTokenRebinding, planTokenRebinding, type RebindCounts } from './tokenRebind.js'
import { spendMediaCopyBudget } from './mediaCopyBudget.js'

type MediaRow = typeof mediaAssets.$inferInsert
const ASSET_KEYS = new Set(['assetId', 'posterAssetId'])

/**
 * The source slides to copy: exactly `slideIds` (every one must exist; taken
 * in source-deck order), else the inclusive `range` (default: all).
 */
function chooseSlides(
  all: Y.Map<unknown>[],
  args: {
    range?: { from?: number | undefined; to?: number | undefined } | undefined
    slideIds?: readonly string[] | undefined
  },
): Y.Map<unknown>[] {
  if (args.slideIds !== undefined) {
    const wanted = new Set(args.slideIds)
    const present = new Set(all.map((m) => m.get('id') as string))
    const missing = [...wanted].find((id) => !present.has(id))
    if (missing !== undefined) throw notFound(`Slide '${missing}' is not in the source deck`)
    return all.filter((m) => wanted.has(m.get('id') as string))
  }
  const from = args.range?.from ?? 0
  const to = args.range?.to ?? all.length - 1
  if (from < 0 || to < from || to >= all.length) {
    throw badRequest(
      `range ${from}..${to} is outside the source deck (it has ${all.length} slides, indices 0..${all.length - 1})`,
    )
  }
  return all.slice(from, to + 1)
}

/** Clamp an insertion index to the deck's length (omitted = append). */
export function clampInsertIndex(at: number | undefined, length: number): number {
  if (at === undefined) return length
  return Math.max(0, Math.min(Math.trunc(at), length))
}

// ---------------------------------------------------------------------------
// Walking a slide for references
// ---------------------------------------------------------------------------

/** Visit every Y.Map (and plain object) under `root`, depth first. */
function forEachRecord(
  root: Y.Map<unknown>,
  visit: (
    rec: Y.Map<unknown> | Record<string, unknown>,
    set: (k: string, v: unknown) => void,
  ) => void,
): void {
  const walkPlain = (value: unknown, replace: (v: unknown) => void): void => {
    if (Array.isArray(value)) {
      const copy = [...value]
      let changed = false
      copy.forEach((v, i) =>
        walkPlain(v, (nv) => {
          copy[i] = nv
          changed = true
        }),
      )
      if (changed) replace(copy)
      return
    }
    if (value === null || typeof value !== 'object' || value instanceof Y.AbstractType) return
    const copy = { ...(value as Record<string, unknown>) }
    let changed = false
    visit(copy, (k, v) => {
      if (v === undefined) delete copy[k]
      else copy[k] = v
      changed = true
    })
    for (const [k, v] of Object.entries(copy)) {
      walkPlain(v, (nv) => {
        copy[k] = nv
        changed = true
      })
    }
    if (changed) replace(copy)
  }
  const walkY = (value: unknown, replace: (v: unknown) => void): void => {
    if (value instanceof Y.Map) {
      visit(value, (k, v) => (v === undefined ? value.delete(k) : value.set(k, v)))
      for (const [k, v] of [...value.entries()]) walkY(v, (nv) => value.set(k, nv))
    } else if (value instanceof Y.Array) {
      for (let i = 0; i < value.length; i++) {
        walkY(value.get(i), (nv) => {
          value.delete(i, 1)
          value.insert(i, [nv])
        })
      }
    } else if (!(value instanceof Y.AbstractType)) {
      walkPlain(value, replace)
    }
  }
  walkY(root, () => undefined)
}

function getField(rec: Y.Map<unknown> | Record<string, unknown>, key: string): unknown {
  return rec instanceof Y.Map ? rec.get(key) : rec[key]
}

function fieldKeys(rec: Y.Map<unknown> | Record<string, unknown>): string[] {
  return rec instanceof Y.Map ? [...rec.keys()] : Object.keys(rec)
}

/** Asset ids referenced anywhere in the slides. */
export function referencedAssets(slides: ReadonlyArray<Y.Map<unknown>>): Set<string> {
  const ids = new Set<string>()
  for (const slide of slides) {
    forEachRecord(slide, (rec) => {
      for (const k of fieldKeys(rec)) {
        const v = getField(rec, k)
        if (ASSET_KEYS.has(k) && typeof v === 'string' && v !== '') ids.add(v)
      }
    })
  }
  return ids
}

/** Font families the slides' text uses (box fonts and run attributes). */
function referencedFamilies(slides: ReadonlyArray<Y.Map<unknown>>): Set<string> {
  const families = new Set<string>()
  const addRuns = (text: Y.Text) => {
    for (const op of text.toDelta() as Array<{ attributes?: Record<string, unknown> }>) {
      const f = op.attributes?.['fontFamily']
      if (typeof f === 'string' && f !== '') families.add(f)
    }
  }
  for (const slide of slides) {
    forEachRecord(slide, (rec) => {
      const f = getField(rec, 'fontFamily')
      if (typeof f === 'string' && f !== '') families.add(f)
      const text = getField(rec, 'text')
      if (text instanceof Y.Text) addRuns(text)
    })
  }
  return families
}

/**
 * Point every asset reference in `records` that `idMap` names at its new
 * id; returns how many references changed. Call it inside a transaction.
 */
export function pointAssetsAt(
  records: ReadonlyArray<Y.Map<unknown>>,
  idMap: ReadonlyMap<string, string>,
): number {
  let changed = 0
  for (const record of records) {
    forEachRecord(record, (rec, set) => {
      for (const k of fieldKeys(rec)) {
        const v = getField(rec, k)
        if (!ASSET_KEYS.has(k) || typeof v !== 'string') continue
        const to = idMap.get(v)
        if (to !== undefined && to !== v) {
          set(k, to)
          changed++
        }
      }
    })
  }
  return changed
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * The caller may copy slides out of `sourceDeckId`: editor (or owner) of it,
 * the rule for exporting it (see the file header). A deck they cannot read
 * answers "not found", one they can only view "forbidden".
 */
async function requireCopyAccess(
  deps: ServiceDeps,
  userId: string,
  sourceDeckId: string,
): Promise<void> {
  const access = await resolveDeckAccess(deps.db, {
    deckId: sourceDeckId,
    userId,
    shareToken: null,
  })
  if (!access) throw notFound(`Source deck '${sourceDeckId}' not found`)
  if (!roleAtLeast(access.role, 'editor')) {
    throw forbidden(
      `Copying from deck '${sourceDeckId}' needs editor access to it (the same as exporting it); you can only view it`,
    )
  }
}

/** Slides of the source, rewritten in a scratch copy for their new deck. */
interface StagedCopy {
  /** The detached source copy the slides live in; the caller destroys it. */
  scratch: Y.Doc
  chosen: Y.Map<unknown>[]
  /** The id each chosen slide takes in the target, in order. */
  newSlideIds: string[]
  /** Media copied into the target's namespace, not yet registered. */
  media: Pick<StagedDeckMedia, 'mediaAssetRows' | 'videoTranscodeJobs'>
  skippedImages: number
  tokens: RebindCounts | undefined
  droppedLinks: number
}

/**
 * Steps 2–5 of the file header for `chosen` slides of the source: read it
 * live, point slide links at the copies (or drop them), copy the media they
 * show into the target deck's namespace and rebind token references when
 * the folders differ. Nothing is registered and the target is not touched;
 * on failure the copied objects are discarded and the scratch destroyed.
 */
async function stageCopy(
  deps: ServiceDeps,
  args: {
    userId: string
    sourceDeckId: string
    sourceFolderId: string | null
    targetDeckId: string
    targetFolderId: string | null
    choose: (all: Y.Map<unknown>[]) => Y.Map<unknown>[]
    /** New ids for the copies (inserting into a deck), or keep the source ids (a new deck). */
    freshSlideIds: boolean
  },
): Promise<StagedCopy> {
  const scratch = await readDocCopy(deps, 'deck', args.sourceDeckId)
  try {
    const all = hydrateSlideDoc(scratch).slides.toArray()
    const chosen = args.choose(all)
    const newSlideIds = chosen.map((m) => (args.freshSlideIds ? nanoid() : (m.get('id') as string)))
    const rewritten = await rewriteForTarget(deps, {
      userId: args.userId,
      scratch,
      records: chosen,
      source: { deckId: args.sourceDeckId },
      sourceFolderId: args.sourceFolderId,
      target: { deckId: args.targetDeckId },
      targetFolderId: args.targetFolderId,
      sourceSlideIds: new Set(all.map((m) => m.get('id') as string)),
      slideIdMap: new Map(chosen.map((m, i) => [m.get('id') as string, newSlideIds[i]!])),
    })
    return { scratch, chosen, newSlideIds, ...rewritten }
  } catch (err) {
    scratch.destroy()
    throw err
  }
}

/** What `rewriteForTarget` did to the copied records. */
interface Rewritten {
  /** Media copied into the target's namespace, not yet registered. */
  media: Pick<StagedDeckMedia, 'mediaAssetRows' | 'videoTranscodeJobs'>
  skippedImages: number
  tokens: RebindCounts | undefined
  droppedLinks: number
}

/**
 * Steps 3–5 of the file header, on `records` (slides, or a scratch slide of
 * objects) in `scratch`, a detached document: point slide links at copied
 * slides (`slideIdMap`) or remove those into the source deck, copy the media
 * and fonts they use into the target's namespace, and rebind token
 * references when the folders differ. The source and the target are decks
 * or component masters (a promote copies deck media into a component, a
 * stamp copies it back out). Nothing is registered and no real document is
 * touched; on failure the copied media is discarded (the caller destroys
 * the scratch).
 */
export async function rewriteForTarget(
  deps: ServiceDeps,
  args: {
    userId: string
    scratch: Y.Doc
    records: Y.Map<unknown>[]
    source: MediaOwner
    sourceFolderId: string | null
    target: MediaOwner
    targetFolderId: string | null
    /** Every slide id of the source deck: a link to one that was not copied is removed. */
    sourceSlideIds: ReadonlySet<string>
    /** Copied slides: source id → the copy's id. */
    slideIdMap: ReadonlyMap<string, string>
  },
): Promise<Rewritten> {
  const { userId, scratch, records, source, target } = args
  const media: Rewritten['media'] = { mediaAssetRows: [], videoTranscodeJobs: [] }
  try {
    let droppedLinks = 0
    let tokens: RebindCounts | undefined
    let skippedImages = 0

    scratch.transact(() => {
      // 4. Slide links: into the copies, or removed when they point at an uncopied source slide.
      for (const record of records) {
        forEachRecord(record, (rec, set) => {
          const link = getField(rec, 'hyperlink') as
            | { kind?: unknown; slideId?: unknown }
            | undefined
          if (link === undefined || link === null || link.kind !== 'slide') return
          const to =
            typeof link.slideId === 'string' ? args.slideIdMap.get(link.slideId) : undefined
          if (to !== undefined) {
            if (to !== link.slideId) set('hyperlink', { ...link, slideId: to })
          } else if (typeof link.slideId === 'string' && args.sourceSlideIds.has(link.slideId)) {
            set('hyperlink', undefined)
            droppedLinks++
          }
        })
      }
    })

    // 3. Media under the target's namespace.
    if (!sameDocument(source, target)) {
      const staged = await copyMedia(deps, {
        userId,
        source,
        sourceFolderId: args.sourceFolderId,
        target,
        targetFolderId: args.targetFolderId,
        assetIds: referencedAssets(records),
        families: referencedFamilies(records),
      })
      media.mediaAssetRows = staged.rows
      media.videoTranscodeJobs = staged.videoJobs
      skippedImages = staged.failed
      if (staged.idMap.size > 0) {
        scratch.transact(() => pointAssetsAt(records, staged.idMap))
      }
    }

    // 5. Token references across folders.
    if (
      args.sourceFolderId !== null &&
      args.targetFolderId !== null &&
      args.sourceFolderId !== args.targetFolderId
    ) {
      const [srcFolder, dstFolder] = await Promise.all([
        readDocCopy(deps, 'folder', args.sourceFolderId),
        readDocCopy(deps, 'folder', args.targetFolderId),
      ])
      try {
        const plan = planTokenRebinding(readFolderTokens(srcFolder), readFolderTokens(dstFolder))
        scratch.transact(() => {
          tokens = applyTokenRebinding(scratch, plan, records)
        })
      } finally {
        srcFolder.destroy()
        dstFolder.destroy()
      }
    }

    return { media, skippedImages, tokens, droppedLinks }
  } catch (err) {
    await discardOwnedMedia({ db: deps.db, owner: target, media, log: deps.log })
    throw err
  }
}

/** The folder a deck or a component lives in (null: a deck in no folder), or not found. */
async function folderOf(deps: ServiceDeps, doc: MediaOwner): Promise<string | null> {
  if ('deckId' in doc) {
    const [row] = await deps.db
      .select({ folderId: decks.folderId })
      .from(decks)
      .where(eq(decks.id, doc.deckId))
      .limit(1)
    if (!row) throw notFound('Deck not found')
    return row.folderId
  }
  const [row] = await deps.db
    .select({ folderId: components.folderId })
    .from(components)
    .where(eq(components.id, doc.componentId))
    .limit(1)
  if (!row) throw notFound('Component not found')
  return row.folderId
}

/**
 * `object.insertFromDeck`: objects read from `source` (already validated
 * and planned by the command) staged for `target` — each a deck or a
 * component master. They are built in a scratch document and rewritten
 * there like copied slides — links into the source's slides removed, the
 * media they use copied into the target (and, between decks, the source's
 * own fonts), token references rebound across folders — and the media rows
 * are registered; `apply` then clones them onto a slide of the target, in
 * the host's one transaction.
 */
export async function stageObjectInsert(
  deps: ServiceDeps,
  args: { userId: string; source: MediaOwner; target: MediaOwner; plan: InsertPlan },
): Promise<PreparedObjectInsert> {
  const { db, log } = deps
  const { userId, source, target, plan } = args
  if (sameDocument(source, target)) {
    // Links into the "source" would be links into this document, and its media is here already.
    throw badRequest('The objects come from this document: paste them with object.insert')
  }

  const [sourceFolderId, targetFolderId] = await Promise.all([
    folderOf(deps, source),
    folderOf(deps, target),
  ])
  if ('deckId' in source) await requireCopyAccess(deps, userId, source.deckId)
  else {
    // Inside its folder a master is read by any member (a paste within the
    // folder); copying it into another folder takes it out, which — like
    // copying a deck (requireCopyAccess) — needs the editor role.
    const required = sourceFolderId === targetFolderId ? 'viewer' : 'editor'
    await requireComponentRole(deps.db, source.componentId, userId, required, {
      bypass: deps.bypass,
      unseen: 'not_found',
    })
  }
  // A deck target is authorised by the caller (the host, the route's role
  // check); a master is its folder editors'. A master the caller cannot see
  // answers "not found", like one that does not exist.
  if ('componentId' in target) {
    await requireComponentRole(deps.db, target.componentId, userId, 'editor', {
      bypass: deps.bypass,
      unseen: 'not_found',
    })
  }

  // The source's slide ids, read live: a link to one of them would jump
  // nowhere in the target.
  const sourceDoc = await readDocCopy(
    deps,
    'deckId' in source ? 'deck' : 'component',
    'deckId' in source ? source.deckId : source.componentId,
  )
  let sourceSlideIds: Set<string>
  try {
    sourceSlideIds = new Set(
      hydrateSlideDoc(sourceDoc)
        .slides.toArray()
        .map((m) => m.get('id') as string),
    )
  } finally {
    sourceDoc.destroy()
  }

  // A scratch deck with one slide holding the planned objects.
  const scratchDeck = createSlideDoc()
  const scratch = scratchDeck.doc
  let staged: Rewritten
  let holder: ObjectsMutationContext
  try {
    const slideId = scratchDeck.slides.get(0).get('id') as string
    const ctx = getSlideObjectsCtx(scratchDeck, slideId)
    if (ctx === null) throw new Error('object insert: the scratch slide has no objects')
    holder = ctx
    applyInsertPlan(holder, plan)
    staged = await rewriteForTarget(deps, {
      userId,
      scratch,
      records: [scratchDeck.slides.get(0)],
      source,
      sourceFolderId,
      target,
      targetFolderId,
      sourceSlideIds,
      slideIdMap: new Map(),
    })
  } catch (err) {
    scratch.destroy()
    throw err
  }

  try {
    await registerOwnedMedia({ db, owner: target, ownerUserId: userId, media: staged.media, log })
  } catch (err) {
    scratch.destroy()
    await discardOwnedMedia({ db, owner: target, media: staged.media, log })
    throw err
  }

  let settled = false
  return {
    apply(objects: ObjectsMutationContext): ObjectInsertResult {
      if (settled) throw new Error('object insert: already applied or discarded')
      settled = true
      try {
        const copies = holder.objects.toArray().map((m) => m.clone())
        objects.objects.push(copies)
        const result: ObjectInsertResult = {
          objectIds: copies.map((m) => m.get('id') as string),
          mediaRegistered: staged.media.mediaAssetRows.length,
          skippedImages: staged.skippedImages,
          droppedLinks: staged.droppedLinks,
        }
        if (staged.tokens !== undefined) result.tokens = staged.tokens
        return result
      } finally {
        scratch.destroy()
      }
    },
    async discard() {
      if (settled) return
      settled = true
      scratch.destroy()
      await discardOwnedMedia({ db, owner: target, media: staged.media, log })
    },
  }
}

/**
 * The editor's cross-document object paste (`POST /decks/:id/insert-objects`,
 * `POST /components/:id/insert-objects`): `object.insertFromDeck` run as one
 * server write onto slide `slideId` of `target`. Invalid objects fail before
 * anything is staged (a CommandError with the offending field); the write
 * reaches open editors as a remote change.
 */
export async function insertObjectsFrom(
  deps: ServiceDeps,
  args: {
    userId: string
    source: MediaOwner
    target: MediaOwner
    slideId: string
    objects: readonly Record<string, unknown>[]
    offset?: { x: number; y: number } | undefined
    at?: { x: number; y: number } | undefined
  },
): Promise<ObjectInsertResult> {
  const plan = planInsert(args.objects, { offset: args.offset, at: args.at })
  const prepared = await stageObjectInsert(deps, {
    userId: args.userId,
    source: args.source,
    target: args.target,
    plan,
  })
  const touched = { value: false }
  try {
    return await writeLiveDoc(
      deps,
      'deckId' in args.target ? 'deck' : 'component',
      'deckId' in args.target ? args.target.deckId : args.target.componentId,
      (doc) => {
        // A deck nobody opened yet gets its first slide, as the editor would
        // seed it; a master is never seeded — its one slide is written with
        // the component, and a missing one is refused before any write.
        const deck =
          'deckId' in args.target
            ? hydrateSlideDoc(doc)
            : { doc, slides: doc.getArray<Y.Map<unknown>>('slides') }
        const objects = getSlideObjectsCtx(deck, args.slideId)
        if (objects === null) throw notFound(`Slide '${args.slideId}' not found`)
        return prepared.apply(objects)
      },
      SERVER_EDIT_ORIGIN,
      touched,
    )
  } catch (err) {
    // Untouched: nothing references the staged media, so it goes.
    if (!touched.value) await prepared.discard()
    throw err
  }
}

export async function stageDeckInsert(
  deps: ServiceDeps,
  args: {
    userId: string
    sourceDeckId: string
    targetDeckId: string
    range?: { from?: number | undefined; to?: number | undefined } | undefined
    /** Exactly these source slides, in source-deck order (instead of `range`). */
    slideIds?: readonly string[] | undefined
  },
): Promise<PreparedSlideInsert> {
  const { db, log } = deps
  const { userId, sourceDeckId, targetDeckId } = args

  await requireCopyAccess(deps, userId, sourceDeckId)
  const rows = await db
    .select({ id: decks.id, folderId: decks.folderId })
    .from(decks)
    .where(inArray(decks.id, [sourceDeckId, targetDeckId]))
  const source = rows.find((r) => r.id === sourceDeckId)
  const target = rows.find((r) => r.id === targetDeckId)
  if (!source) throw notFound(`Source deck '${sourceDeckId}' not found`)
  if (!target) throw notFound('Deck not found')

  const staged = await stageCopy(deps, {
    userId,
    sourceDeckId,
    sourceFolderId: source.folderId,
    targetDeckId,
    targetFolderId: target.folderId,
    choose: (all) => chooseSlides(all, args),
    freshSlideIds: true,
  })
  const { scratch, chosen, newSlideIds, media, skippedImages, tokens, droppedLinks } = staged

  // Rows committed (and transcodes enqueued) before anything reaches the target document.
  try {
    await registerDeckMedia({ db, deckId: targetDeckId, ownerUserId: userId, media, log })
  } catch (err) {
    scratch.destroy()
    await discardDeckMedia({ db, deckId: targetDeckId, media, log })
    throw err
  }

  let settled = false
  return {
    slideCount: chosen.length,
    apply(deck: DeckMutationContext, at?: number): SlideInsertResult {
      if (settled) throw new Error('deck insert: already applied or discarded')
      settled = true
      try {
        const insertedAt = clampInsertIndex(at, deck.slides.length)
        const copies = chosen.map((m, i) => {
          const copy = m.clone()
          copy.set('id', newSlideIds[i]!)
          return copy
        })
        const objectsCreated = countObjects(chosen)
        deck.slides.insert(insertedAt, copies)
        // The copies keep their relative outline levels, shifted so the
        // first fits under the slide it landed below (slide.copyTo's rule).
        const levels = copies.map((m) => levelOf(m))
        const above = insertedAt > 0 ? levelOf(deck.slides.get(insertedAt - 1)) : undefined
        shiftBlockLevels(levels, levels[0] ?? 0, above).forEach((level, i) => {
          const copy = copies[i]!
          if (level > 0) copy.set('indent', level)
          else copy.delete('indent')
        })
        normalizeOutline(deck)
        return {
          slideIds: newSlideIds,
          insertedAt,
          objectsCreated,
          mediaRegistered: media.mediaAssetRows.length,
          skipped: { images: skippedImages, unknownShapes: 0 },
          ignoredElements: [],
          ...(tokens !== undefined ? { tokens } : {}),
          droppedLinks,
        }
      } finally {
        scratch.destroy()
      }
    },
    async discard(): Promise<void> {
      if (settled) return
      settled = true
      scratch.destroy()
      await discardDeckMedia({ db, deckId: targetDeckId, media, log })
    },
  }
}

function countObjects(slides: ReadonlyArray<Y.Map<unknown>>): number {
  return slides.reduce((n, m) => {
    const objects = m.get('objects')
    return n + (objects instanceof Y.Array ? objects.length : 0)
  }, 0)
}

/** A whole deck, copied for a new deck that does not exist yet (`deck.duplicate`). */
export interface StagedDeckCopy {
  /** The new deck's first document state: every slide and the deck guides. */
  state: Uint8Array
  slideCount: number
  objectsCreated: number
  /** Media copied into the new deck's namespace; register once its row exists. */
  media: Pick<StagedDeckMedia, 'mediaAssetRows' | 'videoTranscodeJobs'>
  skippedImages: number
  tokens?: RebindCounts
}

/**
 * Copy the whole of `sourceDeckId` for a new deck `targetDeckId` in
 * `targetFolderId`: every slide (ids kept — it is a deck of its own, and its
 * slide links stay valid), the deck guides, the media the slides show
 * (copied into the new deck's namespace) and, across folders, rebound token
 * references. Returns the new document state; the caller creates the deck
 * row with it and then registers `media` (the rows reference the deck), or
 * discards `media` if it cannot.
 */
export async function stageDeckCopy(
  deps: ServiceDeps,
  args: {
    userId: string
    sourceDeckId: string
    sourceFolderId: string | null
    targetDeckId: string
    targetFolderId: string
  },
): Promise<StagedDeckCopy> {
  await requireCopyAccess(deps, args.userId, args.sourceDeckId)
  const staged = await stageCopy(deps, { ...args, choose: (all) => all, freshSlideIds: false })
  const doc = new Y.Doc()
  try {
    const guides = staged.scratch.getArray<Y.Map<unknown>>('guides').toArray()
    doc.transact(() => {
      doc.getArray<Y.Map<unknown>>('slides').insert(
        0,
        staged.chosen.map((m) => m.clone()),
      )
      if (guides.length > 0)
        doc.getArray<Y.Map<unknown>>('guides').insert(
          0,
          guides.map((g) => g.clone()),
        )
    })
    return {
      state: Y.encodeStateAsUpdate(doc),
      slideCount: staged.chosen.length,
      objectsCreated: countObjects(staged.chosen),
      media: staged.media,
      skippedImages: staged.skippedImages,
      ...(staged.tokens !== undefined ? { tokens: staged.tokens } : {}),
    }
  } finally {
    doc.destroy()
    staged.scratch.destroy()
  }
}

// ---------------------------------------------------------------------------
// Media copy
// ---------------------------------------------------------------------------

function copySource(key: string): string {
  return `${MEDIA_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`
}

/** Copy one stored object of the media bucket to another key (server side, no download). */
export async function copyStoredObject(fromKey: string, toKey: string): Promise<void> {
  await buildS3Client().send(
    new CopyObjectCommand({ Bucket: MEDIA_BUCKET, Key: toKey, CopySource: copySource(fromKey) }),
  )
}

function basename(key: string): string {
  return key.split('/').pop() ?? 'file'
}

/**
 * Copy into `target`'s namespace the media of `assetIds` the target may not
 * show (media/visibleMedia.ts) — the source's own, or the linked media of
 * the source's folder when the target is in another folder — and, deck to
 * deck only, the source deck's own fonts in `families`: stored objects
 * copied server side, new rows staged (not inserted) for the target.
 *
 *   - Media the target may already show is kept as it is (`idMap` leaves it
 *     out): a stamp or a paste out of a master within its folder links the
 *     master's pictures instead of copying them.
 *   - Media the source may not show either (another deck's, deleted) cannot
 *     be copied: its references stay unresolved and are counted (`failed`).
 *
 * A component master has no fonts of its own (its folder's fonts cover it),
 * so no font crosses between a deck and a component.
 */
export async function copyMedia(
  deps: ServiceDeps,
  args: {
    userId: string
    source: MediaOwner
    /** The source's folder (null: a deck in no folder). */
    sourceFolderId: string | null
    target: MediaOwner
    /** The target's folder (null: a deck in no folder). */
    targetFolderId: string | null
    assetIds: ReadonlySet<string>
    families: ReadonlySet<string>
    /**
     * Spend the caller's media copy budget (mediaCopyBudget.ts) when there is
     * something to copy. Off only for the server's own one-time migrations.
     */
    budgeted?: boolean
  },
): Promise<{
  idMap: Map<string, string>
  rows: MediaRow[]
  videoJobs: StagedDeckMedia['videoTranscodeJobs']
  failed: number
}> {
  const { db, log } = deps
  const { source, target } = args
  const idMap = new Map<string, string>()
  const rows: MediaRow[] = []
  const videoJobs: StagedDeckMedia['videoTranscodeJobs'] = []
  let failed = 0

  const ownedBy = (owner: MediaOwner) =>
    'deckId' in owner
      ? eq(mediaAssets.deckId, owner.deckId)
      : eq(mediaAssets.componentId, owner.componentId)
  const from: MediaHolder = { owner: source, folderId: args.sourceFolderId }
  const to: MediaHolder = { owner: target, folderId: args.targetFolderId }
  const placed = await readPlacedMedia(db, [...args.assetIds])
  // Already visible in the target: linked, kept as it is.
  const kept = new Set(placed.filter((r) => visibleIn(r, to)).map((r) => r.id))
  // Visible in the source but not in the target: copied. A font is not
  // copied into a component master (its folder's fonts cover it).
  let referenced: MediaRow[] = placed
    .filter((r) => !kept.has(r.id) && visibleIn(r, from))
    .map(({ componentFolderId: _folder, ...row }) => row)
  if ('componentId' in target) referenced = referenced.filter((r) => r.kind !== 'font')
  // The rest — another deck's, deleted, or a font a master cannot take —
  // stays unresolved, and is counted as such.
  const resolved = new Set([...kept, ...referenced.map((r) => r.id)])
  failed += [...args.assetIds].filter((id) => !resolved.has(id)).length
  // The source deck's own fonts that the copied text uses, unless the target
  // already has a deck font of the same face.
  const families = 'deckId' in source && 'deckId' in target ? [...args.families] : []
  const fonts =
    families.length === 0
      ? []
      : (
          await db
            .select()
            .from(mediaAssets)
            .where(
              and(
                ownedBy(source),
                eq(mediaAssets.kind, 'font'),
                inArray(mediaAssets.fontFamily, families),
              ),
            )
        ).filter((f) => !args.assetIds.has(f.id))
  const targetFaces = new Set(
    fonts.length === 0
      ? []
      : (
          await db
            .select({ ps: mediaAssets.fontPostscriptName })
            .from(mediaAssets)
            .where(and(ownedBy(target), eq(mediaAssets.kind, 'font')))
        ).map((r) => r.ps),
  )

  const copy = copyStoredObject
  const toCopy = [...referenced, ...fonts.filter((f) => !targetFaces.has(f.fontPostscriptName))]
  // Refused before the first copy: nothing is left half done.
  if (args.budgeted !== false && toCopy.length > 0) spendMediaCopyBudget(args.userId)

  for (const row of toCopy) {
    const newId = nanoid(16)
    const ext = extensionFromMimeOrFilename(row.mimeType, row.originalFilename ?? undefined)
    const storageKey = mediaOriginalPath(
      target,
      row.kind === 'font' ? 'fonts' : 'uploads',
      newId,
      ext,
    )
    try {
      await copy(row.storageKey, storageKey)
      const outputs: Partial<MediaRow> = {}
      let transcodeStatus = row.transcodeStatus
      if (row.kind === 'video') {
        if (row.transcodeStatus === 'done') {
          for (const key of ['playbackKey', 'posterKey', 'thumbnailKey'] as const) {
            const from = row[key]
            if (typeof from !== 'string' || from === '') continue
            const to = `${mediaOwnerPrefix(target)}/videos/${newId}/${basename(from)}`
            await copy(from, to)
            outputs[key] = to
          }
        } else {
          transcodeStatus = 'pending'
          videoJobs.push({ assetId: newId, storageKey, mimeType: row.mimeType })
        }
      }
      rows.push({
        id: newId,
        deckId: 'deckId' in target ? target.deckId : null,
        componentId: 'componentId' in target ? target.componentId : null,
        folderId: null,
        uploaderUserId: args.userId,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        storageKey,
        originalFilename: row.originalFilename,
        width: row.width,
        height: row.height,
        kind: row.kind,
        durationSec: row.durationSec,
        transcodeStatus,
        transcodeError: transcodeStatus === 'failed' ? row.transcodeError : null,
        fontFamily: row.fontFamily,
        fontWeight: row.fontWeight,
        fontStyle: row.fontStyle,
        fontPostscriptName: row.fontPostscriptName,
        ...outputs,
      })
      if (args.assetIds.has(row.id)) idMap.set(row.id, newId)
    } catch (err) {
      failed++
      log.warn(
        { err, assetId: row.id, source, target },
        'media copy: copying an asset failed; its references stay unresolved in the target',
      )
    }
  }
  return { idMap, rows, videoJobs, failed }
}
