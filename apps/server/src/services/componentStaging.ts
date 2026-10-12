/**
 * services/componentStaging.ts
 *
 * Moving objects between a deck and a component master on the server
 * (A2.12b; linked media since folder sharing step 2). A component owns its
 * pictures and videos (`media_assets.component_id`, keys under
 * `components/<id>/`), the same way a deck owns its own. A deck may show
 * the pictures and videos of its folder's components without owning them
 * (media/visibleMedia.ts), so (services/deckInsert.ts `rewriteForTarget`):
 *
 *   promote  deck slide objects → a new master. The deck is read live, the
 *            master built in a scratch document (`promoteToComponent` +
 *            `writeComponentMaster`), the deck's own media it shows copied
 *            into the component (a master must not depend on a deck) and
 *            links to the deck's slides removed. The component row and its
 *            media rows commit in one transaction; only then is the master
 *            written through the sync server. The slide is not changed.
 *   stamp    a master → a slide of a deck in the same folder. The master's
 *            pictures and videos are linked, not copied; the stamp itself
 *            is `stampMaster` (packages/commands), run by the
 *            `component.stamp` command inside the host's transaction or by
 *            `stampComponentIntoDeck` for the editor. A deck that moved to
 *            another folder while the stamp was staged is caught up after
 *            the write (`settle`).
 *
 * Promoting needs the editor role in the deck's folder; stamping a role in
 * it (the rule of the `component:<id>` document) and the deck's editor role.
 *
 * `adoptMasterMedia` brings a master from before this rule under it (the
 * data migration `2026-09-30-component-media`).
 */

import * as Y from 'yjs'
import { eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  getSlideObjectsCtx,
  hydrateSlideDoc,
  promoteToComponent,
  writeComponentMaster,
} from '@narrative/slide-model'
import {
  objectsOf,
  requireObjects,
  resolveSlide,
  stampMaster,
  type ComponentMaster,
  type ComponentRecord,
  type PreparedStamp,
  type PromotedComponent,
  type SlideRef,
  type StampResult,
} from '@narrative/commands'
import { components, decks, folders, mediaAssets } from '../db/schema.js'
import { discardOwnedMedia, registerOwnedMedia } from '../pptx/importDeck.js'
import { purgeComponentBucketPrefix } from '../media/bucketCleanup.js'
import type { ServiceDeps } from './deps.js'
import { ServiceError, badRequest, conflict, forbidden, notFound } from './errors.js'
import { readDocCopy, SERVER_EDIT_ORIGIN, writeLiveDoc } from './liveDocs.js'
import { requireFolderRole } from './shared.js'
import { copyMedia, pointAssetsAt, referencedAssets, rewriteForTarget } from './deckInsert.js'
import { componentRecord, MAX_COMPONENT_NAME } from './components.js'
import { carryLinkedMediaAfterWrite } from './localiseMedia.js'

/**
 * The folder of `deckId`, where the deck's components live and in which the
 * user must be an editor to add one.
 */
async function requireEditableDeckFolder(
  deps: ServiceDeps,
  deckId: string,
  userId: string,
): Promise<string> {
  const [deck] = await deps.db
    .select({ folderId: decks.folderId })
    .from(decks)
    .where(eq(decks.id, deckId))
    .limit(1)
  if (!deck) throw notFound('Deck not found')
  if (deck.folderId === null) {
    throw conflict('The deck is in no folder, which is where components live')
  }
  try {
    await requireFolderRole(deps.db, deck.folderId, userId, 'editor', { bypass: deps.bypass })
  } catch (err) {
    // Say why a component cannot be made here; anything but a refusal passes through.
    if (err instanceof ServiceError && err.code === 'forbidden') {
      throw forbidden(
        "Components belong to the deck's folder; adding one needs the editor role in it",
      )
    }
    throw err
  }
  return deck.folderId
}

/**
 * POST /folders/:folderId/components: a new, empty component of a folder
 * the user is an editor of — its row, then its empty master slide written through the
 * sync server, so the master editor opens a master, not an empty document.
 * The row goes again when the master cannot be written.
 */
export async function createEmptyComponent(
  deps: ServiceDeps,
  args: { userId: string; folderId: string; name: string },
): Promise<ComponentRecord> {
  const { db } = deps
  await requireFolderRole(db, args.folderId, args.userId, 'editor', { bypass: deps.bypass })
  const name = args.name.trim()
  if (name.length > MAX_COMPONENT_NAME) {
    throw badRequest(`name too long (max ${MAX_COMPONENT_NAME})`)
  }
  const now = new Date()
  const [row] = await db
    .insert(components)
    .values({
      id: nanoid(12),
      folderId: args.folderId,
      name: name.length > 0 ? name : 'Untitled component',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new Error('creating the component row failed')
  const written = { value: false }
  try {
    await writeLiveDoc(
      deps,
      'component',
      row.id,
      (doc) => {
        written.value = writeComponentMaster(doc, [], [])
      },
      SERVER_EDIT_ORIGIN,
    )
  } catch (err) {
    if (!written.value) await db.delete(components).where(eq(components.id, row.id))
    throw err
  }
  return componentRecord(row)
}

/** Every slide id of a deck document. */
function slideIdsOf(doc: Y.Doc): Set<string> {
  return new Set(
    doc
      .getArray<Y.Map<unknown>>('slides')
      .toArray()
      .map((m) => m.get('id') as string),
  )
}

/**
 * `component.promote` (POST /decks/:id/promote-component): a new component
 * of the deck's folder, made from `objects` on `slide`. See the file header.
 */
export async function promoteComponent(
  deps: ServiceDeps,
  args: {
    userId: string
    deckId: string
    slide: SlideRef
    objects: readonly string[]
    name: string
  },
): Promise<PromotedComponent> {
  const { db, log } = deps
  const { userId, deckId } = args
  const name = args.name.trim()
  if (name.length === 0) throw badRequest('name is required')
  if (name.length > MAX_COMPONENT_NAME) {
    throw badRequest(`name too long (max ${MAX_COMPONENT_NAME})`)
  }
  const folderId = await requireEditableDeckFolder(deps, deckId, userId)

  // The master, built from a live copy of the deck in a scratch document.
  const source = await readDocCopy(deps, 'deck', deckId)
  const master = new Y.Doc()
  let componentId: string
  let objectCount: number
  let staged: Awaited<ReturnType<typeof rewriteForTarget>>
  try {
    const deck = hydrateSlideDoc(source)
    const slide = resolveSlide(deck, args.slide)
    requireObjects(objectsOf(deck, slide), args.objects, slide.id)
    const plan = promoteToComponent(deck, slide.id, [...args.objects], folderId)
    componentId = plan.componentId
    objectCount = plan.masterTree.length
    writeComponentMaster(master, plan.masterTree, plan.masterAnimations)
    staged = await rewriteForTarget(deps, {
      userId,
      scratch: master,
      records: master.getArray<Y.Map<unknown>>('slides').toArray(),
      source: { deckId },
      sourceFolderId: folderId,
      target: { componentId },
      targetFolderId: folderId,
      // A master has no slides: every link to one of the deck's is removed.
      sourceSlideIds: slideIdsOf(source),
      slideIdMap: new Map(),
    })
  } catch (err) {
    master.destroy()
    throw err
  } finally {
    source.destroy()
  }

  // The component row and the media it owns commit together.
  const now = new Date()
  let row: typeof components.$inferSelect | undefined
  try {
    row = await registerOwnedMedia({
      db,
      owner: { componentId },
      ownerUserId: userId,
      media: staged.media,
      log,
      alongside: async (tx) => {
        const [created] = await tx
          .insert(components)
          .values({ id: componentId, folderId, name, createdAt: now, updatedAt: now })
          .returning()
        return created
      },
    })
  } catch (err) {
    master.destroy()
    await discardOwnedMedia({ db, owner: { componentId }, media: staged.media, log })
    // Copied video outputs live under the prefix, not in the rows' keys.
    await purgeComponentBucketPrefix(db, componentId, log)
    throw err
  }
  if (row === undefined) throw new Error('promote: the component row was not created')

  // Then the master document, through the sync server.
  const written = { value: false }
  try {
    const slides = master.getArray<Y.Map<unknown>>('slides').toArray()
    await writeLiveDoc(
      deps,
      'component',
      componentId,
      (doc) => {
        const target = doc.getArray<Y.Map<unknown>>('slides')
        if (target.length > 0) throw conflict('The new component already has a master')
        written.value = true
        target.push(slides.map((m) => m.clone()))
      },
      SERVER_EDIT_ORIGIN,
    )
  } catch (err) {
    if (!written.value) {
      // Nothing holds the component yet: it goes, with the media it owns
      // (the rows' keys, then the prefix with the copied video outputs).
      await discardOwnedMedia({ db, owner: { componentId }, media: staged.media, log })
      await db.delete(components).where(eq(components.id, componentId))
      await purgeComponentBucketPrefix(db, componentId, log)
    }
    throw err
  } finally {
    master.destroy()
  }

  return {
    component: componentRecord(row),
    objectCount,
    mediaCopied: staged.media.mediaAssetRows.length,
    skippedImages: staged.skippedImages,
    droppedLinks: staged.droppedLinks,
  }
}

/**
 * `component.stamp`'s load phase: `master` (read with the deck's rule — a
 * component of the deck's folder, in which the user is a member) staged for
 * the deck. Its pictures and videos are linked: the deck may show its
 * folder's component media, so nothing is copied (only what the deck could
 * not show otherwise would be, and registered before the deck is touched).
 * `discard` removes such copies when the stamp is not written.
 *
 * The deck can move to another folder between this and the write. Checked
 * here (the deck must still be in the master's folder, else 409) and again
 * in `settle`, after the write: a deck that has moved by then gets the
 * pictures the stamp linked copied in (services/localiseMedia.ts
 * `carryLinkedMedia`), on the stamper's authority and copy budget, and
 * recorded like a move's copies. Checking only before the write would leave
 * a window between the check and the write; checking after it closes the
 * race by construction — a move that commits later still has its own
 * catch-up pass to come, which then reads a document holding the stamp
 * (services/decks.ts moveDecks).
 */
export async function prepareComponentStamp(
  deps: ServiceDeps,
  args: {
    userId: string
    componentId: string
    deckId: string
    master: ComponentMaster
    /** What the master is staged for (the refusal says it); default a stamp. */
    purpose?: 'stamp' | 'restamp' | undefined
  },
): Promise<PreparedStamp> {
  const { db, log } = deps
  const { userId, componentId, deckId, master } = args
  const folderId = master.component.folderId
  // The folder the stamp is staged for is the deck's, read now.
  const [deck] = await db
    .select({ folderId: decks.folderId })
    .from(decks)
    .where(eq(decks.id, deckId))
    .limit(1)
  if (!deck) throw notFound('Deck not found')
  if (deck.folderId !== folderId) {
    throw conflict(
      args.purpose === 'restamp'
        ? "The deck moved to another folder while its stamps were being restamped; it restamps only its new folder's components"
        : "The deck moved to another folder while the component was being stamped; stamp one of its new folder's components",
    )
  }

  const scratch = new Y.Doc()
  let staged: Awaited<ReturnType<typeof rewriteForTarget>>
  let state: Uint8Array
  try {
    Y.applyUpdate(scratch, master.state)
    staged = await rewriteForTarget(deps, {
      userId,
      scratch,
      records: scratch.getArray<Y.Map<unknown>>('slides').toArray(),
      source: { componentId },
      sourceFolderId: folderId,
      target: { deckId },
      targetFolderId: folderId,
      sourceSlideIds: new Set(),
      slideIdMap: new Map(),
    })
    state = Y.encodeStateAsUpdate(scratch)
  } finally {
    scratch.destroy()
  }

  // Registered before the deck is touched: a stamp never shows a picture
  // whose row does not exist yet.
  try {
    await registerOwnedMedia({
      db,
      owner: { deckId },
      ownerUserId: userId,
      media: staged.media,
      log,
    })
  } catch (err) {
    await discardOwnedMedia({ db, owner: { deckId }, media: staged.media, log })
    throw err
  }

  let discarded = false
  let settled = false
  return {
    master: { component: master.component, state },
    mediaRegistered: staged.media.mediaAssetRows.length,
    skippedImages: staged.skippedImages,
    async discard() {
      if (discarded) return
      discarded = true
      await discardOwnedMedia({ db, owner: { deckId }, media: staged.media, log })
    },
    async settle() {
      if (settled) return
      settled = true
      // The stamp linked the master's pictures for the deck's folder as it
      // was at staging; a deck that moved since gets them carried along.
      await carryLinkedMediaAfterWrite(deps, {
        userId,
        deckId,
        assetIds: staged.linked,
        stagedFolderId: folderId,
        what: `stamp of component ${componentId}`,
      })
    },
  }
}

/**
 * The editor's stamp (POST /decks/:id/stamp-component): `component.stamp`
 * as one server write onto slide `slideId`. The slide is looked up first,
 * so a stale slide costs nothing; then `prepare` (the component service's
 * `prepareStamp`) stages the master for the deck. The stamp reaches open
 * editors as a remote change, like a paste from another deck; staged copies
 * are discarded when the deck was not touched, and the stamp is settled
 * once written (a deck that moved meanwhile gets its linked media copied).
 */
export async function stampComponentIntoDeck(
  deps: ServiceDeps,
  args: {
    deckId: string
    componentId: string
    slideId: string
    at?: { x: number; y: number } | undefined
    prepare: () => Promise<PreparedStamp>
  },
): Promise<StampResult> {
  const current = await readDocCopy(deps, 'deck', args.deckId)
  try {
    if (getSlideObjectsCtx(hydrateSlideDoc(current), args.slideId) === null) {
      throw notFound(`Slide '${args.slideId}' not found`)
    }
  } finally {
    current.destroy()
  }
  const prepared = await args.prepare()
  const wrote = { value: false }
  let stamped: StampResult
  try {
    stamped = await writeLiveDoc(
      deps,
      'deck',
      args.deckId,
      (doc) =>
        stampMaster(
          hydrateSlideDoc(doc),
          prepared.master,
          { componentId: args.componentId, slide: args.slideId, at: args.at },
          wrote,
        ),
      SERVER_EDIT_ORIGIN,
    )
  } catch (err) {
    if (!wrote.value) await prepared.discard()
    throw err
  }
  await prepared.settle()
  return stamped
}

/**
 * Bring one master under the rule that a component owns its media: the
 * pictures and videos it shows that belong to a deck of the component's own
 * folder — every master promoted before A2.12b points at the promoting
 * deck's assets, and a deck promotes only into its folder — are copied into
 * the component, and the master is re-pointed at the copies through the
 * sync server. Media of a deck in another folder is never copied (a master
 * can hold any asset id someone typed into it; copying it would hand the
 * folder owner a picture they could not see), nor is a reference to media
 * that no longer exists: both stay as they are and are counted. Idempotent:
 * a master showing only its own media is not written.
 */
export async function adoptMasterMedia(
  deps: Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>,
  componentId: string,
): Promise<{ copied: number; unresolved: number }> {
  const { db, log } = deps
  const [owner] = await db
    .select({ userId: folders.ownerUserId, folderId: components.folderId })
    .from(components)
    .innerJoin(folders, eq(folders.id, components.folderId))
    .where(eq(components.id, componentId))
    .limit(1)
  if (!owner) return { copied: 0, unresolved: 0 }

  const copy = await readDocCopy(deps, 'component', componentId)
  let refs: Set<string>
  try {
    refs = referencedAssets(copy.getArray<Y.Map<unknown>>('slides').toArray())
  } finally {
    copy.destroy()
  }
  if (refs.size === 0) return { copied: 0, unresolved: 0 }

  const rows = await db
    .select({
      id: mediaAssets.id,
      deckId: mediaAssets.deckId,
      componentId: mediaAssets.componentId,
      deckFolderId: decks.folderId,
    })
    .from(mediaAssets)
    .leftJoin(decks, eq(decks.id, mediaAssets.deckId))
    .where(inArray(mediaAssets.id, [...refs]))
  let unresolved = refs.size - rows.length
  const byDeck = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.componentId === componentId) continue
    if (row.deckId === null || row.deckFolderId !== owner.folderId) {
      unresolved++
      continue
    }
    const ids = byDeck.get(row.deckId) ?? new Set<string>()
    ids.add(row.id)
    byDeck.set(row.deckId, ids)
  }
  if (byDeck.size === 0) return { copied: 0, unresolved }

  const target = { componentId }
  const idMap = new Map<string, string>()
  const media: Parameters<typeof registerOwnedMedia>[0]['media'] = {
    mediaAssetRows: [],
    videoTranscodeJobs: [],
  }
  try {
    for (const [deckId, assetIds] of byDeck) {
      const staged = await copyMedia(deps, {
        userId: owner.userId,
        // The decks are the component's folder's (filtered above).
        source: { deckId },
        sourceFolderId: owner.folderId,
        target,
        targetFolderId: owner.folderId,
        assetIds,
        families: new Set(),
        // A one-time server migration, not a person's copy.
        budgeted: false,
      })
      for (const [from, to] of staged.idMap) idMap.set(from, to)
      media.mediaAssetRows.push(...staged.rows)
      media.videoTranscodeJobs.push(...staged.videoJobs)
      unresolved += staged.unresolved + staged.copyFailed
    }
    if (idMap.size === 0) return { copied: 0, unresolved }
    await registerOwnedMedia({ db, owner: target, ownerUserId: owner.userId, media, log })
  } catch (err) {
    await discardOwnedMedia({ db, owner: target, media, log })
    throw err
  }

  const touched = { value: false }
  try {
    await writeLiveDoc(
      deps,
      'component',
      componentId,
      (doc) => pointAssetsAt(doc.getArray<Y.Map<unknown>>('slides').toArray(), idMap),
      SERVER_EDIT_ORIGIN,
      touched,
    )
  } catch (err) {
    if (!touched.value) await discardOwnedMedia({ db, owner: target, media, log })
    throw err
  }
  return { copied: idMap.size, unresolved }
}
