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
import { hydrateSlideDoc, type DeckMutationContext } from '@narrative/slide-model'
import type { PreparedSlideInsert, SlideInsertResult } from '@narrative/commands'
import { decks, mediaAssets } from '../db/schema.js'
import { resolveDeckAccess, roleAtLeast } from '../auth/permissions.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { extensionFromMimeOrFilename } from '../media/uploadPolicy.js'
import { discardDeckMedia, registerDeckMedia, type StagedDeckMedia } from '../pptx/importDeck.js'
import type { ServiceDeps } from './deps.js'
import { badRequest, forbidden, notFound } from './errors.js'
import { readDocCopy } from './liveDocs.js'
import {
  applyTokenRebinding,
  planTokenRebinding,
  tokensSnapshot,
  type RebindCounts,
} from './tokenRebind.js'

type MediaRow = typeof mediaAssets.$inferInsert
const ASSET_KEYS = new Set(['assetId', 'posterAssetId'])

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

export async function stageDeckInsert(
  deps: ServiceDeps,
  args: {
    userId: string
    sourceDeckId: string
    targetDeckId: string
    range?: { from?: number | undefined; to?: number | undefined } | undefined
  },
): Promise<PreparedSlideInsert> {
  const { db, log } = deps
  const { userId, sourceDeckId, targetDeckId } = args

  const access = await resolveDeckAccess(db, { deckId: sourceDeckId, userId, shareToken: null })
  if (!access) throw notFound(`Source deck '${sourceDeckId}' not found`)
  if (!roleAtLeast(access.role, 'editor')) {
    throw forbidden(
      `Copying slides from deck '${sourceDeckId}' needs editor access to it (the same as exporting it); you can only view it`,
    )
  }
  const rows = await db
    .select({ id: decks.id, folderId: decks.folderId })
    .from(decks)
    .where(inArray(decks.id, [sourceDeckId, targetDeckId]))
  const source = rows.find((r) => r.id === sourceDeckId)
  const target = rows.find((r) => r.id === targetDeckId)
  if (!source) throw notFound(`Source deck '${sourceDeckId}' not found`)
  if (!target) throw notFound('Deck not found')

  const scratch = await readDocCopy(deps, 'deck', sourceDeckId)
  let handedOver = false
  try {
    const all = hydrateSlideDoc(scratch).slides.toArray()
    const from = args.range?.from ?? 0
    const to = args.range?.to ?? all.length - 1
    if (from < 0 || to < from || to >= all.length) {
      throw badRequest(
        `range ${from}..${to} is outside the source deck (it has ${all.length} slides, indices 0..${all.length - 1})`,
      )
    }
    const chosen = all.slice(from, to + 1)
    const newSlideIds = chosen.map(() => nanoid())
    const idBySource = new Map(chosen.map((m, i) => [m.get('id') as string, newSlideIds[i]!]))
    const sourceSlideIds = new Set(all.map((m) => m.get('id') as string))

    let droppedLinks = 0
    let tokens: RebindCounts | undefined
    const media: Pick<StagedDeckMedia, 'mediaAssetRows' | 'videoTranscodeJobs'> = {
      mediaAssetRows: [],
      videoTranscodeJobs: [],
    }
    let skippedImages = 0

    scratch.transact(() => {
      // 4. Slide links: into the copies, or removed when they point at an uncopied source slide.
      for (const slide of chosen) {
        forEachRecord(slide, (rec, set) => {
          const link = getField(rec, 'hyperlink') as
            | { kind?: unknown; slideId?: unknown }
            | undefined
          if (link === undefined || link === null || link.kind !== 'slide') return
          const to = typeof link.slideId === 'string' ? idBySource.get(link.slideId) : undefined
          if (to !== undefined) set('hyperlink', { ...link, slideId: to })
          else if (typeof link.slideId === 'string' && sourceSlideIds.has(link.slideId)) {
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
        assetIds: referencedAssets(chosen),
        families: referencedFamilies(chosen),
      })
      media.mediaAssetRows = staged.rows
      media.videoTranscodeJobs = staged.videoJobs
      skippedImages = staged.failed
      if (staged.idMap.size > 0) {
        scratch.transact(() => {
          for (const slide of chosen) {
            forEachRecord(slide, (rec, set) => {
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
      source.folderId !== null &&
      target.folderId !== null &&
      source.folderId !== target.folderId
    ) {
      const [srcFolder, dstFolder] = await Promise.all([
        readDocCopy(deps, 'folder', source.folderId),
        readDocCopy(deps, 'folder', target.folderId),
      ])
      try {
        const plan = planTokenRebinding(tokensSnapshot(srcFolder), tokensSnapshot(dstFolder))
        scratch.transact(() => {
          tokens = applyTokenRebinding(scratch, plan, chosen)
        })
      } finally {
        srcFolder.destroy()
        dstFolder.destroy()
      }
    }

    // Rows committed (and transcodes enqueued) before anything reaches the target document.
    try {
      await registerDeckMedia({ db, deckId: targetDeckId, ownerUserId: userId, media, log })
    } catch (err) {
      await discardDeckMedia({ db, deckId: targetDeckId, media, log })
      throw err
    }

    let settled = false
    handedOver = true
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
          const objectsCreated = chosen.reduce((n, m) => {
            const objects = m.get('objects')
            return n + (objects instanceof Y.Array ? objects.length : 0)
          }, 0)
          deck.slides.insert(insertedAt, copies)
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
  } finally {
    if (!handedOver) scratch.destroy()
  }
}

// ---------------------------------------------------------------------------
// Media copy
// ---------------------------------------------------------------------------

function copySource(key: string): string {
  return `${MEDIA_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`
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

  const s3 = buildS3Client()
  const copy = async (from: string, to: string): Promise<void> => {
    await s3.send(
      new CopyObjectCommand({ Bucket: MEDIA_BUCKET, Key: to, CopySource: copySource(from) }),
    )
  }

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
