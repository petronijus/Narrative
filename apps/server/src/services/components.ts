/**
 * services/components.ts — server implementation of `ComponentService`
 * (packages/commands/src/services/components.ts). GET /folders/:id/components,
 * PATCH/DELETE /components/:id and the `component.*` commands call these
 * functions; the agent host uses `access` to open a master (`component:<id>`)
 * for the ordinary document commands. Promoting and stamping move objects
 * and media between a deck and a master (./componentStaging.ts).
 */

import { eq } from 'drizzle-orm'
import type { ComponentMaster, ComponentRecord, ComponentService } from '@narrative/commands'
import { components, decks } from '../db/schema.js'
import { signImgproxyUrl } from '../media/imgproxyUrl.js'
import { listComponentMediaKeys } from '../media/assets.js'
import { purgeComponentBucketPrefix, purgeExplicitKeys } from '../media/bucketCleanup.js'
import { closeConnectionsForDocument } from '../hocuspocus/connections.js'
import type { ServiceDeps } from './deps.js'
import { badRequest, notFound } from './errors.js'
import { iso, requireComponentRole, requireFolderRole } from './shared.js'
import { documentName, readDocState } from './liveDocs.js'
import { prepareComponentStamp, promoteComponent } from './componentStaging.js'

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
    await requireComponentRole(db, args.componentId, args.userId, 'editor', {
      bypass: deps.bypass,
      folderId: args.folderId,
    })
    // The master's own pictures and videos: tus originals are keyed by
    // their upload id, outside the components/<id>/ prefix, so their keys
    // are read before the cascade removes the rows.
    const keys = await listComponentMediaKeys(db, [args.componentId])
    // component_updates and the media rows cascade-delete (FK ON DELETE
    // CASCADE). Stamped copies on slides are detached primitives with
    // deck-owned media and stay as they are.
    await db.delete(components).where(eq(components.id, args.componentId))
    // Nobody keeps the master open (a store that still runs finds its owner
    // gone and stores nothing — hocuspocus/persistence.ts).
    closeConnectionsForDocument(documentName('component', args.componentId))
    await Promise.all([
      purgeComponentBucketPrefix(args.componentId, deps.log),
      purgeExplicitKeys(keys, deps.log),
    ])
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

  async function prepareStamp(args: { userId: string; componentId: string; deckId: string }) {
    return prepareComponentStamp(deps, { ...args, master: await readMaster(args) })
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

  return { list, rename, delete: remove, readMaster, promote, prepareStamp, access }
}
