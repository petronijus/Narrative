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
} from '@narrative/slide-model'
import {
  applyInsertPlan,
  planInsert,
  levelOf,
  normalizeOutline,
  shiftBlockLevels,
  type InsertPlan,
  type ObjectInsertResult,
  type PreparedObjectInsert,
  type PreparedSlideInsert,
  type SlideInsertResult,
} from '@narrative/commands'
import { decks, mediaAssets } from '../db/schema.js'
import { resolveDeckAccess, roleAtLeast } from '../auth/permissions.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { extensionFromMimeOrFilename } from '../media/uploadPolicy.js'
import { discardDeckMedia, registerDeckMedia, type StagedDeckMedia } from '../pptx/importDeck.js'
import type { ServiceDeps } from './deps.js'
import { badRequest, forbidden, notFound } from './errors.js'
import { readDocCopy, SERVER_EDIT_ORIGIN, writeLiveDoc } from './liveDocs.js'
import {
  applyTokenRebinding,
  planTokenRebinding,
  tokensSnapshot,
  type RebindCounts,
} from './tokenRebind.js'

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
function referencedAssets(slides: ReadonlyArray<Y.Map<unknown>>): Set<string> {
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
      sourceDeckId: args.sourceDeckId,
      sourceFolderId: args.sourceFolderId,
      targetDeckId: args.targetDeckId,
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
 * and fonts they use into the target deck's namespace, and rebind token
 * references when the folders differ. Nothing is registered and no real
 * document is touched; on failure the copied media is discarded (the caller
 * destroys the scratch).
 */
async function rewriteForTarget(
  deps: ServiceDeps,
  args: {
    userId: string
    scratch: Y.Doc
    records: Y.Map<unknown>[]
    sourceDeckId: string
    sourceFolderId: string | null
    targetDeckId: string
    targetFolderId: string | null
    /** Every slide id of the source deck: a link to one that was not copied is removed. */
    sourceSlideIds: ReadonlySet<string>
    /** Copied slides: source id → the copy's id. */
    slideIdMap: ReadonlyMap<string, string>
  },
): Promise<Rewritten> {
  const { userId, scratch, records, sourceDeckId, targetDeckId } = args
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

    // 3. Media under the target deck's namespace.
    if (sourceDeckId !== targetDeckId) {
      const staged = await copyMedia(deps, {
        userId,
        sourceDeckId,
        targetDeckId,
        assetIds: referencedAssets(records),
        families: referencedFamilies(records),
      })
      media.mediaAssetRows = staged.rows
      media.videoTranscodeJobs = staged.videoJobs
      skippedImages = staged.failed
      if (staged.idMap.size > 0) {
        scratch.transact(() => {
          for (const record of records) {
            forEachRecord(record, (rec, set) => {
              for (const k of fieldKeys(rec)) {
                const v = getField(rec, k)
                if (!ASSET_KEYS.has(k) || typeof v !== 'string') continue
                const to = staged.idMap.get(v)
                if (to !== undefined) set(k, to)
              }
            })
          }
        })
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
        const plan = planTokenRebinding(tokensSnapshot(srcFolder), tokensSnapshot(dstFolder))
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
    await discardDeckMedia({ db: deps.db, deckId: targetDeckId, media, log: deps.log })
    throw err
  }
}

/**
 * `object.insertFromDeck`: objects read from `sourceDeckId` (already
 * validated and planned by the command) staged for `targetDeckId`. They are
 * built in a scratch document and rewritten there like copied slides —
 * links into the source's slides removed, the media and fonts they use
 * copied into the target, token references rebound across folders — and
 * the media rows are registered; `apply` then clones them onto a slide of
 * the target, in the host's one transaction.
 */
export async function stageObjectInsert(
  deps: ServiceDeps,
  args: { userId: string; sourceDeckId: string; targetDeckId: string; plan: InsertPlan },
): Promise<PreparedObjectInsert> {
  const { db, log } = deps
  const { userId, sourceDeckId, targetDeckId, plan } = args
  if (sourceDeckId === targetDeckId) {
    // Links into the "source" would be links into this deck, and its media is here already.
    throw badRequest('The objects come from this deck: paste them with object.insert')
  }

  await requireCopyAccess(deps, userId, sourceDeckId)
  const rows = await db
    .select({ id: decks.id, folderId: decks.folderId })
    .from(decks)
    .where(inArray(decks.id, [sourceDeckId, targetDeckId]))
  const source = rows.find((r) => r.id === sourceDeckId)
  const target = rows.find((r) => r.id === targetDeckId)
  if (!source) throw notFound(`Source deck '${sourceDeckId}' not found`)
  if (!target) throw notFound('Deck not found')

  // The source's slide ids, read live: a link to one of them would jump
  // nowhere in the target.
  const sourceDoc = await readDocCopy(deps, 'deck', sourceDeckId)
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
      sourceDeckId,
      sourceFolderId: source.folderId,
      targetDeckId,
      targetFolderId: target.folderId,
      sourceSlideIds,
      slideIdMap: new Map(),
    })
  } catch (err) {
    scratch.destroy()
    throw err
  }

  try {
    await registerDeckMedia({
      db,
      deckId: targetDeckId,
      ownerUserId: userId,
      media: staged.media,
      log,
    })
  } catch (err) {
    scratch.destroy()
    await discardDeckMedia({ db, deckId: targetDeckId, media: staged.media, log })
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
      await discardDeckMedia({ db, deckId: targetDeckId, media: staged.media, log })
    },
  }
}

/**
 * The editor's cross-deck object paste (`POST /decks/:id/insert-objects`):
 * `object.insertFromDeck` run as one server write onto slide `slideId`.
 * Invalid objects fail before anything is staged (a CommandError with the
 * offending field); the write reaches open editors as a remote change.
 */
export async function insertObjectsFromDeck(
  deps: ServiceDeps,
  args: {
    userId: string
    deckId: string
    sourceDeckId: string
    slideId: string
    objects: readonly Record<string, unknown>[]
    offset?: { x: number; y: number } | undefined
    at?: { x: number; y: number } | undefined
  },
): Promise<ObjectInsertResult> {
  const plan = planInsert(args.objects, { offset: args.offset, at: args.at })
  const prepared = await stageObjectInsert(deps, {
    userId: args.userId,
    sourceDeckId: args.sourceDeckId,
    targetDeckId: args.deckId,
    plan,
  })
  const touched = { value: false }
  try {
    return await writeLiveDoc(
      deps,
      'deck',
      args.deckId,
      (doc) => {
        const objects = getSlideObjectsCtx(hydrateSlideDoc(doc), args.slideId)
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

async function copyMedia(
  deps: ServiceDeps,
  args: {
    userId: string
    sourceDeckId: string
    targetDeckId: string
    assetIds: ReadonlySet<string>
    families: ReadonlySet<string>
  },
): Promise<{
  idMap: Map<string, string>
  rows: MediaRow[]
  videoJobs: StagedDeckMedia['videoTranscodeJobs']
  failed: number
}> {
  const { db, log } = deps
  const { sourceDeckId, targetDeckId } = args
  const idMap = new Map<string, string>()
  const rows: MediaRow[] = []
  const videoJobs: StagedDeckMedia['videoTranscodeJobs'] = []
  let failed = 0

  const referenced =
    args.assetIds.size === 0
      ? []
      : await db
          .select()
          .from(mediaAssets)
          .where(
            and(inArray(mediaAssets.id, [...args.assetIds]), eq(mediaAssets.deckId, sourceDeckId)),
          )
  // A reference to media the source deck does not own (another deck's, or
  // deleted) cannot be copied: it stays unresolved, and is counted as such.
  const owned = new Set(referenced.map((r) => r.id))
  failed += [...args.assetIds].filter((id) => !owned.has(id)).length
  // The source deck's own fonts that the copied text uses, unless the target
  // already has a deck font of the same face.
  const families = [...args.families]
  const fonts =
    families.length === 0
      ? []
      : (
          await db
            .select()
            .from(mediaAssets)
            .where(
              and(
                eq(mediaAssets.deckId, sourceDeckId),
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
            .where(and(eq(mediaAssets.deckId, targetDeckId), eq(mediaAssets.kind, 'font')))
        ).map((r) => r.ps),
  )

  const copy = copyStoredObject

  for (const row of [
    ...referenced,
    ...fonts.filter((f) => !targetFaces.has(f.fontPostscriptName)),
  ]) {
    const newId = nanoid(16)
    const ext = extensionFromMimeOrFilename(row.mimeType, row.originalFilename ?? undefined)
    const folder = row.kind === 'font' ? 'fonts' : 'uploads'
    const storageKey = `decks/${targetDeckId}/${folder}/${newId}/original.${ext}`
    try {
      await copy(row.storageKey, storageKey)
      const outputs: Partial<MediaRow> = {}
      let transcodeStatus = row.transcodeStatus
      if (row.kind === 'video') {
        if (row.transcodeStatus === 'done') {
          for (const key of ['playbackKey', 'posterKey', 'thumbnailKey'] as const) {
            const from = row[key]
            if (typeof from !== 'string' || from === '') continue
            const to = `decks/${targetDeckId}/videos/${newId}/${basename(from)}`
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
        deckId: targetDeckId,
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
        { err, assetId: row.id, sourceDeckId, targetDeckId },
        'deck insert: copying an asset failed; its references stay unresolved in the target',
      )
    }
  }
  return { idMap, rows, videoJobs, failed }
}
