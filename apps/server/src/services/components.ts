/**
 * services/components.ts — server implementation of `ComponentService`
 * (packages/commands/src/services/components.ts). GET/POST /folders/:id/components,
 * PATCH/DELETE /components/:id and the `component.*` commands call these
 * functions; the agent host uses `access` to open a master (`component:<id>`)
 * for the ordinary document commands. Promoting and stamping move objects
 * and media between a deck and a master (./componentStaging.ts).
 */

import { eq } from 'drizzle-orm'
import type { ComponentMaster, ComponentRecord, ComponentService } from '@narrative/commands'
import { components, decks, mediaAssets } from '../db/schema.js'
import { signImgproxyUrl } from '../media/imgproxyUrl.js'
import {
  purgeComponentBucketPrefix,
  purgeUnreferencedKeys,
  sweepAgainAfterGrace,
} from '../media/bucketCleanup.js'
import { isStorageSafeId, mediaOwnerPrefix } from '../media/mediaOwner.js'
import { closeConnectionsForDocument } from '../hocuspocus/connections.js'
import type { ServiceDeps } from './deps.js'
import { badRequest, conflict, notFound } from './errors.js'
import { iso, requireComponentRole, requireFolderRole } from './shared.js'
import { documentName, readDocState } from './liveDocs.js'
import {
  createEmptyComponent,
  prepareComponentStamp,
  promoteComponent,
} from './componentStaging.js'

/** Why a deck cannot restamp stamps of a component in another folder. */
export const RESTAMP_ELSEWHERE =
  "These stamps come from a component of another folder (the deck moved, or they were copied from a deck there); a deck restamps only its own folder's components"

/** Longest component name the API accepts. */
export const MAX_COMPONENT_NAME = 200

interface ComponentRow {
  id: string
  folderId: string
  name: string
  thumbnailKey: string | null
  createdAt: Date | string
  updatedAt: Date | string
}

/** A component row as the API returns it, with its signed thumbnail URL (null until one was rendered). */
export function componentRecord(row: ComponentRow): ComponentRecord {
  return {
    id: row.id,
    folderId: row.folderId,
    name: row.name,
    thumbnailKey: row.thumbnailKey ?? null,
    thumbnailUrl:
      row.thumbnailKey === null || row.thumbnailKey === undefined
        ? null
        : signImgproxyUrl({ storageKey: row.thumbnailKey, variant: 'thumb', extension: 'jpg' }),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

export function createComponentsService(deps: ServiceDeps): ComponentService {
  const { db } = deps

  async function list(args: { userId: string; folderId: string }): Promise<ComponentRecord[]> {
    await requireFolderRole(db, args.folderId, args.userId, 'viewer', { bypass: deps.bypass })
    const rows = await db
      .select()
      .from(components)
      .where(eq(components.folderId, args.folderId))
      .orderBy(components.createdAt)
    return rows.map(componentRecord)
  }

  async function create(args: {
    userId: string
    folderId: string
    name: string
  }): Promise<ComponentRecord> {
    return createEmptyComponent(deps, args)
  }

  async function rename(args: {
    userId: string
    componentId: string
    name: string
    folderId?: string | undefined
  }): Promise<ComponentRecord> {
    await requireComponentRole(db, args.componentId, args.userId, 'editor', {
      bypass: deps.bypass,
      folderId: args.folderId,
    })
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (name.length === 0) throw badRequest('name is required')
    if (name.length > MAX_COMPONENT_NAME) {
      throw badRequest(`name too long (max ${MAX_COMPONENT_NAME})`)
    }
    const [updated] = await db
      .update(components)
      .set({ name, updatedAt: new Date() })
      .where(eq(components.id, args.componentId))
      .returning()
    if (!updated) throw notFound('Component not found')
    return componentRecord(updated)
  }

  async function remove(args: {
    userId: string
    componentId: string
    folderId?: string | undefined
  }): Promise<void> {
    const row = await requireComponentRole(db, args.componentId, args.userId, 'editor', {
      bypass: deps.bypass,
      folderId: args.folderId,
    })
    // The master's pictures and videos go to its folder, in the same
    // transaction as the delete (the foreign key would cascade them away):
    // the slides it was stamped on link them (media/visibleMedia.ts) and
    // keep showing them. They are folder-owned from now on; the folder's
    // deletion removes them. component_updates cascade-delete.
    await db.transaction(async (tx) => {
      await tx
        .update(mediaAssets)
        .set({ componentId: null, folderId: row.folderId })
        .where(eq(mediaAssets.componentId, args.componentId))
      await tx.delete(components).where(eq(components.id, args.componentId))
    })
    // Nobody keeps the master open (a store that still runs finds its owner
    // gone and stores nothing — hocuspocus/persistence.ts).
    closeConnectionsForDocument(documentName('component', args.componentId))
    // Its media's files stay under components/<id>/, named by the rows the
    // folder now owns; everything else there goes — the thumbnail, outputs
    // of media deleted earlier, leftovers of failed copies. The sweep keeps
    // any key a media row names, a video's outputs its row does not name yet
    // and anything younger than the grace window (media/bucketCleanup.ts);
    // it runs once more after the window.
    await purgeComponentBucketPrefix(db, args.componentId, deps.log)
    sweepAgainAfterGrace(
      () => purgeComponentBucketPrefix(db, args.componentId, deps.log),
      deps.log,
      { componentId: args.componentId },
    )
    // A thumbnail outside that prefix (an id that cannot name storage keys
    // is not swept at all) goes by its key.
    if (
      row.thumbnailKey !== null &&
      !(
        isStorageSafeId(args.componentId) &&
        row.thumbnailKey.startsWith(`${mediaOwnerPrefix({ componentId: args.componentId })}/`)
      )
    ) {
      await purgeUnreferencedKeys(db, [row.thumbnailKey], deps.log)
    }
  }

  async function readMaster(args: {
    userId: string
    componentId: string
    folderId?: string | undefined
    deckId?: string | undefined
  }): Promise<ComponentMaster> {
    let expectedFolder = args.folderId
    if (args.deckId !== undefined) {
      const [deck] = await db
        .select({ folderId: decks.folderId })
        .from(decks)
        .where(eq(decks.id, args.deckId))
        .limit(1)
      if (!deck || deck.folderId === null) throw notFound('Component not found')
      expectedFolder = deck.folderId
    }
    const row = await requireComponentRole(db, args.componentId, args.userId, 'viewer', {
      bypass: deps.bypass,
      folderId: expectedFolder,
    })
    return {
      component: componentRecord(row),
      state: await readDocState(deps, 'component', row.id),
    }
  }

  async function promote(args: Parameters<ComponentService['promote']>[0]) {
    return promoteComponent(deps, args)
  }

  async function prepareStamp(args: Parameters<ComponentService['prepareStamp']>[0]) {
    if (args.purpose === 'restamp') await requireRestampableHere(args)
    return prepareComponentStamp(deps, { ...args, master: await readMaster(args) })
  }

  /**
   * A restamp re-applies a component to stamps already on the deck; those
   * can come from a component of another folder — the deck moved, or the
   * stamps were copied from a deck elsewhere. Say so, rather than "not
   * found", to someone who can see that component; a deck restamps only its
   * own folder's components, as it stamps only those.
   */
  async function requireRestampableHere(args: {
    userId: string
    componentId: string
    deckId: string
  }): Promise<void> {
    const [deck] = await db
      .select({ folderId: decks.folderId })
      .from(decks)
      .where(eq(decks.id, args.deckId))
      .limit(1)
    if (!deck) throw notFound('Deck not found')
    const row = await requireComponentRole(db, args.componentId, args.userId, 'viewer', {
      bypass: deps.bypass,
      unseen: 'not_found',
    })
    if (row.folderId !== deck.folderId) throw conflict(RESTAMP_ELSEWHERE)
  }

  async function access(args: { userId: string; componentId: string }) {
    const row = await requireComponentRole(db, args.componentId, args.userId, 'viewer', {
      bypass: deps.bypass,
    })
    return {
      componentId: row.id,
      folderId: row.folderId,
      role: row.role,
      documentName: documentName('component', row.id),
    }
  }

  return { list, create, rename, delete: remove, readMaster, promote, prepareStamp, access }
}
