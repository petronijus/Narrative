/**
 * hocuspocus/documentEpoch.ts — the epoch of a Yjs document (ADR 0017).
 *
 * Browsers keep a local copy of the state the server confirmed
 * (apps/web state/localDocCopy.ts). Every server-side change to a document
 * today is a CRDT edit through the sync server (services/liveDocs.ts), so a
 * copy from before it merges harmlessly: the server's state carries the
 * deletions. When the server's state goes BACK instead — one document
 * replaced (restored, rebuilt by an operator, a "restore version" that
 * writes old bytes), or the whole database restored from a backup — a copy
 * from before holds items the server no longer knows, and the next sync
 * would add them back.
 *
 * So what the server hands out is stamped `<generation>.<docEpoch>`
 * (`@narrative/shared` documentEpoch.ts):
 *
 *   - `docEpoch` — `decks.doc_epoch`, `folders.doc_epoch`,
 *     `components.doc_epoch` (migration 0041); {@link bumpDocumentEpoch}
 *     advances one document's;
 *   - `generation` — the instance's restore generation (migration 0042,
 *     ./instanceGeneration.ts), which a restore cannot roll back unnoticed.
 *
 * A connection claims the epoch of the content its Y.Doc holds in the auth
 * frame's token; `onAuthenticate` refuses ({@link StaleDocumentError}, close
 * reason `stale-document`) a claim whose `docEpoch` is not the document's or
 * whose `generation` is outside [floor, generation], before any of the
 * connection's messages is processed. Once a connection is established it is
 * told the current epoch ({@link documentEpochExtension}).
 *
 * Whatever replaces ONE document's state must, in this order: unload the live
 * document (close its connections — `closeConnectionsForDocument`), replace
 * the rows, and call {@link bumpDocumentEpoch} in the same database
 * transaction as the rows. A restore of the database is
 * ./instanceGeneration.ts's (and the runbook's, docs/deploy.md).
 */

import { eq, sql } from 'drizzle-orm'
import type { Extension, connectedPayload } from '@hocuspocus/server'
import {
  DOCUMENT_EPOCH_MESSAGE_TYPE,
  STALE_DOCUMENT_REASON,
  formatDocumentEpoch,
  isDocumentEpoch,
  type DocumentEpochMessage,
  type DocumentEpochParts,
} from '@narrative/shared'
import type { Database } from '../db/client.js'
import { components, decks, folders, instanceGeneration } from '../db/schema.js'

type DbOrTx = Pick<Database, 'select' | 'update'>

/** The owner table and id of a sync-server document name (as the persistence routes them). */
function ownerOf(documentName: string): { kind: 'deck' | 'folder' | 'component'; id: string } {
  if (documentName.startsWith('folder:')) {
    return { kind: 'folder', id: documentName.slice('folder:'.length) }
  }
  if (documentName.startsWith('component:')) {
    return { kind: 'component', id: documentName.slice('component:'.length) }
  }
  const id = documentName.startsWith('deck:') ? documentName.slice('deck:'.length) : documentName
  return { kind: 'deck', id }
}

/** What a connection is checked against: the document's epoch and the instance's generation. */
export interface CurrentEpoch {
  docEpoch: number
  generation: number
  /** The lowest generation still accepted (raised past everything by a restore). */
  floor: number
}

/**
 * The document's epoch with the instance's generation and floor (one
 * query), or null when the document's owner row does not exist.
 */
export async function readDocumentEpoch(
  db: DbOrTx,
  documentName: string,
): Promise<CurrentEpoch | null> {
  const { kind, id } = ownerOf(documentName)
  const g = { generation: instanceGeneration.generation, floor: instanceGeneration.floor }
  const rows =
    kind === 'folder'
      ? await db
          .select({ docEpoch: folders.docEpoch, ...g })
          .from(folders)
          .innerJoin(instanceGeneration, eq(instanceGeneration.id, 1))
          .where(eq(folders.id, id))
      : kind === 'component'
        ? await db
            .select({ docEpoch: components.docEpoch, ...g })
            .from(components)
            .innerJoin(instanceGeneration, eq(instanceGeneration.id, 1))
            .where(eq(components.id, id))
        : await db
            .select({ docEpoch: decks.docEpoch, ...g })
            .from(decks)
            .innerJoin(instanceGeneration, eq(instanceGeneration.id, 1))
            .where(eq(decks.id, id))
  const row = rows[0]
  return row === undefined
    ? null
    : { docEpoch: row.docEpoch, generation: Number(row.generation), floor: Number(row.floor) }
}

/** Whether a connection claiming `claimed` may go on with the document at `current`. */
export function claimIsCurrent(claimed: DocumentEpochParts, current: CurrentEpoch): boolean {
  return (
    claimed.docEpoch === current.docEpoch &&
    claimed.generation >= current.floor &&
    claimed.generation <= current.generation
  )
}

/**
 * Advance the document's epoch, so every local copy and every open Y.Doc of
 * it from before is refused instead of merged. Returns the new epoch (null:
 * no such document). Run it in the transaction that replaces the rows.
 */
export async function bumpDocumentEpoch(db: DbOrTx, documentName: string): Promise<number | null> {
  const { kind, id } = ownerOf(documentName)
  const rows =
    kind === 'folder'
      ? await db
          .update(folders)
          .set({ docEpoch: sql`${folders.docEpoch} + 1` })
          .where(eq(folders.id, id))
          .returning({ epoch: folders.docEpoch })
      : kind === 'component'
        ? await db
            .update(components)
            .set({ docEpoch: sql`${components.docEpoch} + 1` })
            .where(eq(components.id, id))
            .returning({ epoch: components.docEpoch })
        : await db
            .update(decks)
            .set({ docEpoch: sql`${decks.docEpoch} + 1` })
            .where(eq(decks.id, id))
            .returning({ epoch: decks.docEpoch })
  return rows[0]?.epoch ?? null
}

/**
 * Thrown by `onAuthenticate` for a connection whose claimed epoch is not the
 * document's. Hocuspocus sends `reason` as the refusal's reason and drops
 * the connection's queued messages, so nothing of the stale state is applied.
 */
export class StaleDocumentError extends Error {
  readonly reason = STALE_DOCUMENT_REASON
  constructor(
    readonly documentName: string,
    readonly claimed: DocumentEpochParts,
    readonly current: CurrentEpoch,
  ) {
    super(
      `stale document: claimed ${claimed.generation}.${claimed.docEpoch}, current ` +
        `${current.generation}.${current.docEpoch} (floor ${current.floor})`,
    )
    this.name = 'StaleDocumentError'
  }
}

/** The context key `onAuthenticate` stores the epoch to tell the connection under. */
export const DOC_EPOCH_CONTEXT_KEY = 'docEpoch'

/** The epoch to tell a connection whose document is at `current`. */
export function epochToTell(current: CurrentEpoch): string {
  return formatDocumentEpoch({ generation: current.generation, docEpoch: current.docEpoch })
}

/** The message for a connection, or null when its context holds no epoch. */
export function documentEpochMessageFor(
  documentName: string,
  context: unknown,
): DocumentEpochMessage | null {
  const epoch = ((context ?? {}) as Record<string, unknown>)[DOC_EPOCH_CONTEXT_KEY]
  if (!isDocumentEpoch(epoch)) return null
  return { type: DOCUMENT_EPOCH_MESSAGE_TYPE, documentName, epoch }
}

/** Tells every established connection its document's epoch (read by `onAuthenticate`). */
export function documentEpochExtension(): Extension {
  return {
    async connected({ documentName, context, connection }: connectedPayload): Promise<void> {
      const message = documentEpochMessageFor(documentName, context)
      if (message !== null) connection.sendStateless(JSON.stringify(message))
    },
  }
}
