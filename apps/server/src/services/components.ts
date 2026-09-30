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
import type { Database } from '../db/client.js'
import { components, decks } from '../db/schema.js'
import { signImgproxyUrl } from '../media/imgproxyUrl.js'
import { listComponentMediaKeys } from '../media/assets.js'
import { purgeComponentBucketPrefix, purgeExplicitKeys } from '../media/bucketCleanup.js'
import type { ServiceDeps } from './deps.js'
import { badRequest, forbidden, notFound } from './errors.js'
import { iso, requireOwnedFolder } from './shared.js'
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

/**
 * The component, whose folder the user must own. A component that exists
 * in someone else's folder answers 403 (as the routes always did); with
 * `folderId` given, a component of another folder answers 404.
 */
async function requireOwnedComponent(
  db: Database,
  componentId: string,
  userId: string,
  folderId?: string,
): Promise<ComponentRow> {
  const [row] = await db.select().from(components).where(eq(components.id, componentId)).limit(1)
  if (!row || (folderId !== undefined && row.folderId !== folderId)) {
    throw notFound('Component not found')
  }
  try {
    await requireOwnedFolder(db, row.folderId, userId)
  } catch {
    throw forbidden()
  }
  return row
}

export function createComponentsService(deps: ServiceDeps): ComponentService {
  const { db } = deps

  async function list(args: { userId: string; folderId: string }): Promise<ComponentRecord[]> {
    await requireOwnedFolder(db, args.folderId, args.userId)
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
    await requireOwnedComponent(db, args.componentId, args.userId, args.folderId)
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
    await requireOwnedComponent(db, args.componentId, args.userId, args.folderId)
    // The master's own pictures and videos: tus originals are keyed by
    // their upload id, outside the components/<id>/ prefix, so their keys
    // are read before the cascade removes the rows.
    const keys = await listComponentMediaKeys(db, [args.componentId])
    // component_updates and the media rows cascade-delete (FK ON DELETE
    // CASCADE). Stamped copies on slides are detached primitives with
    // deck-owned media and stay as they are.
    await db.delete(components).where(eq(components.id, args.componentId))
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
    const row = await requireOwnedComponent(db, args.componentId, args.userId, expectedFolder)
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
    const row = await requireOwnedComponent(db, args.componentId, args.userId)
    return {
      componentId: row.id,
      folderId: row.folderId,
      role: 'owner' as const,
      documentName: documentName('component', row.id),
    }
  }

  return { list, rename, delete: remove, readMaster, promote, prepareStamp, access }
}
