/**
 * services/tokens.ts — server implementation of `TokenService`
 * (packages/commands/src/services/tokens.ts). GET
 * /folders/:folderId/tokens/:category/:tokenId/usages and the `token.usages`
 * command call `usages`.
 *
 * Reads the stored documents (folder, every deck and every component master
 * of the folder), batch-loaded per table — no Hocuspocus connection is
 * opened. It is a delete-time check, called rarely; a folder with thousands
 * of slides may take 1–2 s.
 */

import { eq, inArray } from 'drizzle-orm'
import {
  scanComponentDoc,
  scanDeckDoc,
  scanFolderDoc,
  type UsageEntry,
} from '@narrative/slide-model'
import type { TokenCategory, TokenService, TokenUsage } from '@narrative/commands'
import { components, componentUpdates, decks, deckUpdates, folderUpdates } from '../db/schema.js'
import { replayUpdates } from '../media/replayDoc.js'
import type { ServiceDeps } from './deps.js'
import { badRequest } from './errors.js'
import { requireOwnedFolder } from './shared.js'

export const TOKEN_CATEGORIES: readonly TokenCategory[] = ['colors', 'textStyles', 'effectStyles']

function groupRows<K extends string>(
  rows: ReadonlyArray<{ update: Uint8Array } & Record<K, string>>,
  key: K,
): Map<string, Array<{ update: Uint8Array }>> {
  const byId = new Map<string, Array<{ update: Uint8Array }>>()
  for (const row of rows) {
    const arr = byId.get(row[key])
    if (arr) arr.push({ update: row.update })
    else byId.set(row[key], [{ update: row.update }])
  }
  return byId
}

export function createTokensService(deps: ServiceDeps): TokenService {
  const { db } = deps

  async function usages(args: {
    userId: string
    folderId: string
    category: TokenCategory
    tokenId: string
  }): Promise<{ usages: TokenUsage[] }> {
    const { folderId, category, tokenId } = args
    // Whitelist the category: anything else would silently scan for a
    // fabricated token key and report nothing.
    if (!(TOKEN_CATEGORIES as readonly string[]).includes(category)) {
      throw badRequest(`Invalid token category. Allowed: ${TOKEN_CATEGORIES.join(', ')}`)
    }
    await requireOwnedFolder(db, folderId, args.userId)

    const tokenKey = `${category}.${tokenId}`
    const found: UsageEntry[] = []

    // 1. The folder document — text styles whose colour uses a colour token.
    if (category === 'colors') {
      const folderRows = await db
        .select({ update: folderUpdates.update })
        .from(folderUpdates)
        .where(eq(folderUpdates.folderId, folderId))
        .orderBy(folderUpdates.id)
      if (folderRows.length > 0) {
        const folderDoc = replayUpdates(folderRows)
        try {
          found.push(...scanFolderDoc(folderDoc, tokenKey))
        } finally {
          folderDoc.destroy()
        }
      }
    }

    // 2. Every deck in the folder — all updates in one query, grouped in memory.
    const deckRows = await db
      .select({ id: decks.id, title: decks.title })
      .from(decks)
      .where(eq(decks.folderId, folderId))
      .orderBy(decks.createdAt)
    if (deckRows.length > 0) {
      const allDeckUpdates = await db
        .select({ deckId: deckUpdates.deckId, id: deckUpdates.id, update: deckUpdates.update })
        .from(deckUpdates)
        .where(
          inArray(
            deckUpdates.deckId,
            deckRows.map((d) => d.id),
          ),
        )
        .orderBy(deckUpdates.deckId, deckUpdates.id)
      const updatesByDeck = groupRows(allDeckUpdates, 'deckId')
      for (const deck of deckRows) {
        const rows = updatesByDeck.get(deck.id)
        if (!rows || rows.length === 0) continue
        const deckDoc = replayUpdates(rows)
        try {
          found.push(...scanDeckDoc(deckDoc, deck.id, deck.title, tokenKey))
        } finally {
          deckDoc.destroy()
        }
      }
    }

    // 3. Every component master in the folder — the same batched load.
    const componentRows = await db
      .select({ id: components.id, name: components.name })
      .from(components)
      .where(eq(components.folderId, folderId))
      .orderBy(components.createdAt)
    if (componentRows.length > 0) {
      const allComponentUpdates = await db
        .select({
          componentId: componentUpdates.componentId,
          id: componentUpdates.id,
          update: componentUpdates.update,
        })
        .from(componentUpdates)
        .where(
          inArray(
            componentUpdates.componentId,
            componentRows.map((c) => c.id),
          ),
        )
        .orderBy(componentUpdates.componentId, componentUpdates.id)
      const updatesByComponent = groupRows(allComponentUpdates, 'componentId')
      for (const component of componentRows) {
        const rows = updatesByComponent.get(component.id)
        if (!rows || rows.length === 0) continue
        const componentDoc = replayUpdates(rows)
        try {
          found.push(...scanComponentDoc(componentDoc, component.id, component.name, tokenKey))
        } finally {
          componentDoc.destroy()
        }
      }
    }

    return { usages: found }
  }

  return { usages }
}
