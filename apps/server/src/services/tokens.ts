/**
 * services/tokens.ts — server implementation of `TokenService`
 * (packages/commands/src/services/tokens.ts): a folder's design tokens.
 *
 *   - `usages` (GET /folders/:folderId/tokens/:category/:tokenId/usages and
 *     `token.usages`) reads the stored documents (folder, every deck and
 *     every component master of the folder), batch-loaded per table — no
 *     Hocuspocus connection is opened. A delete-time check, called rarely; a
 *     folder with thousands of slides may take 1–2 s.
 *   - `create` / `update` / `delete` / `seedDefaults` write the folder
 *     document live (services/liveDocs.ts), through slide-model folderDoc.ts.
 *   - `update` then brings what is linked to the token up to date in every
 *     deck and component master of the folder, open or not: each one is
 *     re-styled on a copy first and written only when that changed something,
 *     with `TOKEN_PROPAGATION_ORIGIN` — it mirrors the folder, it is nobody's
 *     edit of the deck, so it is on no undo stack and in no agent run (undoing
 *     a token change is `token.update` back, which propagates the same way).
 *     This used to happen in the browser, and only in a deck someone opened.
 */

import { eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type * as Y from 'yjs'
import {
  MAX_COLORS,
  TOKEN_CATEGORIES,
  addFolderToken,
  deleteFolderToken,
  migrateFolderTokens,
  readFolderTokens,
  scanComponentDoc,
  scanDeckDoc,
  scanFolderDoc,
  seedDefaultTokens,
  updateFolderToken,
  type FolderTokensSnapshot,
  type UsageEntry,
} from '@narrative/slide-model'
import {
  InvalidTokenFields,
  parseNewTokenFields,
  parseTokenPatch,
  propagateTextStyles,
  stylesUsingColor,
  textStyleNameTaken,
  type EditableTokenCategory,
  type TokenCategory,
  type TokenPropagation,
  type TokenService,
  type TokenUsage,
} from '@narrative/commands'
import { components, componentUpdates, decks, deckUpdates, folderUpdates } from '../db/schema.js'
import { replayUpdates } from '../media/replayDoc.js'
import type { ServiceDeps } from './deps.js'
import { badRequest, conflict, notFound } from './errors.js'
import { SERVER_EDIT_ORIGIN, readDocCopy, writeLiveDoc, type DocKind } from './liveDocs.js'
import { requireFolderContentReader, requireFolderRole } from './shared.js'

/**
 * Origin of the server's writes that carry a folder token change into the
 * decks and component masters linked to it (see the module header).
 */
export const TOKEN_PROPAGATION_ORIGIN = Symbol('token-propagation')

/** Ids of new tokens (the editor used the same length). */
const newTokenId = (): string => nanoid(10)

type DocDeps = Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>

/**
 * Give a new folder the default tokens. Failure is logged, not thrown: the
 * folder exists either way, and `token.seedDefaults` completes it later.
 */
export async function seedNewFolder(deps: DocDeps, folderId: string): Promise<void> {
  try {
    await writeLiveDoc(
      deps,
      'folder',
      folderId,
      (doc) => seedDefaultTokens(doc, newTokenId),
      SERVER_EDIT_ORIGIN,
    )
  } catch (err) {
    deps.log.warn({ err, folderId }, 'seeding a new folder with the default tokens failed')
  }
}

/**
 * Seed a folder without colours and text styles, and bring an older seed up
 * to date (slide-model folderDoc.ts). Both are tried on a copy first; the
 * live document is written only when one of them would change it.
 * Returns what happened and the folder's tokens afterwards.
 */
export async function ensureFolderTokens(
  deps: DocDeps,
  folderId: string,
): Promise<{ seeded: boolean; migrated: boolean; tokens: FolderTokensSnapshot }> {
  const copy = await readDocCopy(deps, 'folder', folderId)
  try {
    // Ids made on the copy are thrown away with it.
    const wouldSeed = seedDefaultTokens(copy, newTokenId)
    const wouldMigrate = migrateFolderTokens(copy)
    if (!wouldSeed && !wouldMigrate) {
      return { seeded: false, migrated: false, tokens: readFolderTokens(copy) }
    }
  } finally {
    copy.destroy()
  }
  return writeLiveDoc(
    deps,
    'folder',
    folderId,
    (doc) => {
      const seeded = seedDefaultTokens(doc, newTokenId)
      const migrated = migrateFolderTokens(doc)
      return { seeded, migrated, tokens: readFolderTokens(doc) }
    },
    SERVER_EDIT_ORIGIN,
  )
}

/** The one-slide deck shape both decks and component masters have. */
const deckShape = (doc: Y.Doc) => ({ doc, slides: doc.getArray<Y.Map<unknown>>('slides') })

/**
 * Re-style everything linked to `styleIds` in the folder's decks and
 * component masters. A document is written only when re-styling a copy of
 * it changed something, so unrelated decks are never opened for writing.
 */
export async function propagateToFolder(
  deps: DocDeps,
  folderId: string,
  tokens: FolderTokensSnapshot,
  styleIds: ReadonlySet<string>,
): Promise<TokenPropagation> {
  const result: TokenPropagation = { decks: 0, components: 0, objects: 0, failed: [] }
  if (styleIds.size === 0) return result
  const [deckRows, componentRows] = await Promise.all([
    deps.db.select({ id: decks.id }).from(decks).where(eq(decks.folderId, folderId)),
    deps.db.select({ id: components.id }).from(components).where(eq(components.folderId, folderId)),
  ])
  const targets: Array<{ kind: DocKind; id: string }> = [
    ...deckRows.map((r) => ({ kind: 'deck' as const, id: r.id })),
    ...componentRows.map((r) => ({ kind: 'component' as const, id: r.id })),
  ]
  for (const { kind, id } of targets) {
    try {
      const copy = await readDocCopy(deps, kind, id)
      let wouldChange: number
      try {
        wouldChange = propagateTextStyles(deckShape(copy), tokens, styleIds)
      } finally {
        copy.destroy()
      }
      if (wouldChange === 0) continue
      const changed = await writeLiveDoc(
        deps,
        kind,
        id,
        (doc) => propagateTextStyles(deckShape(doc), tokens, styleIds),
        TOKEN_PROPAGATION_ORIGIN,
      )
      if (changed === 0) continue
      if (kind === 'deck') result.decks++
      else result.components++
      result.objects += changed
    } catch (err) {
      deps.log.warn({ err, folderId, kind, id }, 'carrying a token change into a document failed')
      result.failed.push(`${kind}:${id}`)
    }
  }
  return result
}

/** Propagation requests of one folder waiting for the run in progress to end. */
interface PendingPropagation {
  deps: DocDeps
  styleIds: Set<string>
  waiters: Array<{ resolve: (r: TokenPropagation) => void; reject: (e: unknown) => void }>
}

/** Per folder: whether a propagation runs, and what is waiting for the next one. */
const propagationQueues = new Map<string, { pending: PendingPropagation | null }>()

/**
 * Carry the folder's CURRENT tokens into its decks and component masters
 * for `styleIds` — one run per folder at a time. Requests made while a run
 * is in progress merge into ONE next run (the union of their styles), which
 * reads the folder afresh, so a burst of changes to a folder costs two
 * sweeps, not one per change, and two changes can never leave decks on
 * different "last" values. Resolves with the run that covered the request.
 */
export function queuePropagation(
  deps: DocDeps,
  folderId: string,
  styleIds: ReadonlySet<string>,
): Promise<TokenPropagation> {
  if (styleIds.size === 0)
    return Promise.resolve({ decks: 0, components: 0, objects: 0, failed: [] })
  let queue = propagationQueues.get(folderId)
  const idle = queue === undefined
  if (queue === undefined) {
    queue = { pending: null }
    propagationQueues.set(folderId, queue)
  }
  const pending: PendingPropagation = queue.pending ?? { deps, styleIds: new Set(), waiters: [] }
  pending.deps = deps
  for (const id of styleIds) pending.styleIds.add(id)
  queue.pending = pending
  const done = new Promise<TokenPropagation>((resolve, reject) =>
    pending.waiters.push({ resolve, reject }),
  )
  if (idle) void drainPropagation(folderId, queue)
  return done
}

async function drainPropagation(
  folderId: string,
  queue: { pending: PendingPropagation | null },
): Promise<void> {
  try {
    while (queue.pending !== null) {
      const run = queue.pending
      queue.pending = null
      try {
        const copy = await readDocCopy(run.deps, 'folder', folderId)
        let tokens: FolderTokensSnapshot
        try {
          tokens = readFolderTokens(copy)
        } finally {
          copy.destroy()
        }
        const result = await propagateToFolder(run.deps, folderId, tokens, run.styleIds)
        run.waiters.forEach((w) => w.resolve(result))
      } catch (err) {
        run.waiters.forEach((w) => w.reject(err))
      }
    }
  } finally {
    propagationQueues.delete(folderId)
  }
}

/** Structural equality of stored token values. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return (
    ka.length === kb.length &&
    ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  )
}

/**
 * Text styles are applied by name, so a folder never has two of one name
 * (`conflict`). Checked inside the write, against the live folder.
 */
function requireFreeStyleName(
  category: EditableTokenCategory,
  tokens: FolderTokensSnapshot,
  name: unknown,
  exceptId?: string,
): void {
  if (category !== 'textStyles' || typeof name !== 'string') return
  if (textStyleNameTaken(tokens, name, exceptId))
    throw conflict(`the folder already has a text style named "${name.trim()}"`)
}

/** The fields as a route or a command gave them, validated for the store (`invalid_input` otherwise). */
function validated<T>(parse: () => T): T {
  try {
    return parse()
  } catch (err) {
    if (err instanceof InvalidTokenFields) throw badRequest('Invalid token', { issues: err.issues })
    throw err
  }
}

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
    // Scans every deck in the folder: a folder member's question, not a deck guest's.
    await requireFolderRole(db, folderId, args.userId, 'viewer', { bypass: deps.bypass })

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

  function requireEditable(category: string): asserts category is EditableTokenCategory {
    if (category !== 'colors' && category !== 'textStyles') {
      throw badRequest('Invalid token category. Allowed: colors, textStyles')
    }
  }

  async function list(args: { userId: string; folderId: string }): Promise<FolderTokensSnapshot> {
    // A deck guest reads its folder's tokens too: the deck renders with them.
    await requireFolderContentReader(db, args.folderId, args.userId, { bypass: deps.bypass })
    const copy = await readDocCopy(deps, 'folder', args.folderId)
    try {
      return readFolderTokens(copy)
    } finally {
      copy.destroy()
    }
  }

  async function create(args: {
    userId: string
    folderId: string
    category: EditableTokenCategory
    fields: Record<string, unknown>
  }): Promise<{ tokenId: string }> {
    requireEditable(args.category)
    const fields = validated(() => parseNewTokenFields(args.category, args.fields))
    // Made here, so a later default seed never takes it for one of its own
    // (migrateFolderTokens flags unflagged styles named like a default).
    if (args.category === 'textStyles') fields['builtin'] = false
    await requireFolderRole(db, args.folderId, args.userId, 'editor', { bypass: deps.bypass })
    const tokenId = newTokenId()
    await writeLiveDoc(
      deps,
      'folder',
      args.folderId,
      (doc) => {
        // Checked before the first write: a transaction cannot be rolled back.
        const tokens = readFolderTokens(doc)
        if (args.category === 'colors' && Object.keys(tokens.colors).length >= MAX_COLORS) {
          throw conflict(`a folder holds at most ${MAX_COLORS} colours; delete one first`)
        }
        requireFreeStyleName(args.category, tokens, fields['name'])
        addFolderToken(doc, args.category, tokenId, fields)
      },
      SERVER_EDIT_ORIGIN,
    )
    return { tokenId }
  }

  async function update(args: {
    userId: string
    folderId: string
    category: EditableTokenCategory
    tokenId: string
    patch: Record<string, unknown>
  }): Promise<{ previous: Record<string, unknown>; propagated: TokenPropagation }> {
    requireEditable(args.category)
    const patch = validated(() => parseTokenPatch(args.category, args.patch))
    if (Object.keys(patch).length === 0) throw badRequest('Pass at least one field to change')
    await requireFolderRole(db, args.folderId, args.userId, 'editor', { bypass: deps.bypass })
    const { previous, changed } = await writeLiveDoc(
      deps,
      'folder',
      args.folderId,
      (doc) => {
        const category = readFolderTokens(doc)[args.category] as unknown as Record<
          string,
          Record<string, unknown>
        >
        if (!Object.hasOwn(category, args.tokenId))
          throw notFound(`No ${args.category} token '${args.tokenId}' in this folder`)
        const token = category[args.tokenId]!
        requireFreeStyleName(args.category, readFolderTokens(doc), patch['name'], args.tokenId)
        const previous = Object.fromEntries(Object.keys(patch).map((k) => [k, token[k] ?? null]))
        // Only what differs is written: a repeated change writes nothing and
        // re-styles nothing (a colour-picker drag re-sends the same value).
        const differing = Object.fromEntries(
          Object.entries(patch).filter(([k, v]) => !sameValue(token[k], v)),
        )
        if (Object.keys(differing).length === 0) return { previous, changed: [] as string[] }
        updateFolderToken(doc, args.category, args.tokenId, differing)
        return { previous, changed: Object.keys(differing) }
      },
      SERVER_EDIT_ORIGIN,
    )
    // What the change reaches: a text style its linked text; a colour's new
    // value the text of the styles that use it. A rename reaches nothing.
    const looks = changed.some((k) => k !== 'name')
    let styleIds: string[] = []
    if (looks && args.category === 'textStyles') styleIds = [args.tokenId]
    else if (looks) {
      // The styles that use the colour now (the folder as the queue will read it).
      styleIds = stylesUsingColor(await list(args), args.tokenId)
    }
    const propagated = await queuePropagation(deps, args.folderId, new Set(styleIds))
    return { previous, propagated }
  }

  async function remove(args: {
    userId: string
    folderId: string
    category: TokenCategory
    tokenId: string
  }): Promise<{ deleted: true; token: Record<string, unknown> }> {
    if (!(TOKEN_CATEGORIES as readonly string[]).includes(args.category)) {
      throw badRequest(`Invalid token category. Allowed: ${TOKEN_CATEGORIES.join(', ')}`)
    }
    await requireFolderRole(db, args.folderId, args.userId, 'editor', { bypass: deps.bypass })
    const token = await writeLiveDoc(
      deps,
      'folder',
      args.folderId,
      (doc) => {
        const category = readFolderTokens(doc)[args.category] as unknown as Record<
          string,
          Record<string, unknown>
        >
        if (!Object.hasOwn(category, args.tokenId))
          throw notFound(`No ${args.category} token '${args.tokenId}' in this folder`)
        const existing = category[args.tokenId]!
        if (args.category === 'textStyles' && existing['builtin'] === true)
          throw conflict(
            `"${String(existing['name'])}" is one of the folder's built-in text styles and cannot be deleted`,
          )
        deleteFolderToken(doc, args.category, args.tokenId)
        return existing
      },
      SERVER_EDIT_ORIGIN,
    )
    return { deleted: true, token }
  }

  async function seedDefaults(args: {
    userId: string
    folderId: string
  }): Promise<{ seeded: boolean; migrated: boolean }> {
    await requireFolderRole(db, args.folderId, args.userId, 'editor', { bypass: deps.bypass })
    const { seeded, migrated } = await ensureFolderTokens(deps, args.folderId)
    return { seeded, migrated }
  }

  return { usages, list, create, update, delete: remove, seedDefaults }
}
