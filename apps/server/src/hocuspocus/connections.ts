/**
 * hocuspocus/connections.ts
 *
 * CONN-1 — force-close live Hocuspocus WebSocket connections on access
 * revocation.
 *
 * The problem: `onAuthenticate` resolves a connection's role ONCE at connect
 * time and never re-checks. Revoking a share link, downgrading/removing a
 * `deck_permissions` row, or revoking a user's sessions does NOT tear down an
 * already-open WebSocket — the now-unauthorised editor keeps full read-write
 * until they happen to disconnect. These helpers close the affected live
 * connections so the client is forced to reconnect and re-run `onAuthenticate`
 * (which will now reject them, or downgrade them to read-only).
 *
 * How we enumerate connections (@hocuspocus/server 2.15):
 *   server.documents : Map<string, Document>
 *   document.getConnections() : Connection[]
 *   connection.context : the object we populated in onAuthenticate
 *                        ({ userId, deckId, deckIdResolved, role, shareToken })
 *   connection.close(event) : graceful close wrapper around webSocket.close.
 *
 * We deliberately do NOT use the built-in `server.closeConnections(docName)`
 * because it closes EVERY connection on a document — it cannot target a single
 * principal, which would kick innocent co-editors off the deck on any revoke.
 *
 * Targeting (see each helper for coarseness notes):
 *   - share-link revoke → match `context.shareToken === token` on that deck.
 *   - permission revoke/downgrade → match `context.userId === userId` on that
 *     deck (owner-level structural change can close ALL deck connections).
 *   - session revoke → match `context.userId === userId` across ALL docs.
 *
 * Single-process only — like presence.ts, multi-instance would need a Redis
 * fan-out, but the public API stays the same.
 */

import { getHocuspocusInstance } from './presence.js'
import { subsystemLogger } from '../observability/logger.js'

const log = subsystemLogger('hocuspocus')

/**
 * Close-event sent to revoked connections. 4403 mirrors Hocuspocus'
 * `Forbidden` close code (a 4xxx application close, distinct from the 4205
 * `ResetConnection` used for a benign re-sync). The client treats this as a
 * terminal auth failure rather than a transient reconnect.
 *
 * Inlined rather than imported from `@hocuspocus/common` so we don't couple to
 * that package's deep export path.
 */
const REVOKED_CLOSE_EVENT = { code: 4403, reason: 'Access revoked' } as const

/** Shape of the context we set in onAuthenticate (see hocuspocus/index.ts). */
interface ConnContext {
  userId?: unknown
  deckId?: unknown
  deckIdResolved?: unknown
  role?: unknown
  shareToken?: unknown
}

/**
 * Resolve a Hocuspocus document name to a bare deck id. Mirrors
 * presence.deckIdFromDocName but kept local to avoid a cross-import cycle of
 * intent — folder/component docs are not deck-scoped and return null.
 */
function deckIdOf(documentName: string): string | null {
  if (documentName.startsWith('folder:')) return null
  if (documentName.startsWith('component:')) return null
  if (documentName.startsWith('deck:')) return documentName.slice('deck:'.length)
  return documentName
}

/**
 * Core enumerator: close every live connection for which `predicate` returns
 * true. Returns the number of connections closed. No-op (returns 0) if the
 * Hocuspocus server has not been wired yet (e.g. HTTP-only unit tests).
 */
export function closeConnectionsWhere(
  predicate: (ctx: ConnContext, documentName: string) => boolean,
): number {
  const server = getHocuspocusInstance()
  if (server === null) return 0

  let closed = 0
  // Snapshot the connection list first — closing mutates document.connections.
  const toClose: Array<{ close: (event: typeof REVOKED_CLOSE_EVENT) => void }> = []
  for (const [documentName, doc] of server.documents) {
    for (const conn of doc.getConnections()) {
      const ctx = (conn.context ?? {}) as ConnContext
      if (predicate(ctx, documentName)) {
        toClose.push(conn)
      }
    }
  }
  for (const conn of toClose) {
    try {
      conn.close(REVOKED_CLOSE_EVENT)
      closed++
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'failed to close revoked connection',
      )
    }
  }
  return closed
}

/**
 * Close live connections on a deck.
 *
 * @param deckId   bare deck id (no `deck:` prefix)
 * @param opts.userId      close only this principal's connections on the deck
 * @param opts.shareToken  close only connections that authed via this share token
 *
 * With no opts → closes ALL connections on the deck. Use that only for
 * owner-level structural changes (e.g. deck deletion / ownership transfer)
 * where every editor's access basis may have changed.
 *
 * Coarseness note: a single user may legitimately hold both an authenticated
 * session AND a share-token connection on the same deck. Passing `userId`
 * targets the authenticated one; passing `shareToken` targets the share one.
 * They are independent — revoking a share link must not kick the user's
 * authenticated editor session, and vice versa.
 */
export function closeDeckConnections(
  deckId: string,
  opts?: { userId?: string; shareToken?: string },
): number {
  return closeConnectionsWhere((ctx, documentName) => {
    if (deckIdOf(documentName) !== deckId) return false
    if (opts?.shareToken !== undefined) {
      return ctx.shareToken === opts.shareToken
    }
    if (opts?.userId !== undefined) {
      return ctx.userId === opts.userId
    }
    // No selector → every connection on the deck.
    return true
  })
}

/**
 * Close every live connection belonging to a user across ALL documents (decks,
 * folders, components). Used on session revocation / allowlist removal, where
 * the principal must lose access everywhere at once.
 *
 * Share-token connections are never matched here — they carry a `share:<8>`
 * display userId, not a real user sub, so revoking a user's sessions correctly
 * leaves anonymous share-link viewers untouched.
 */
export function closeUserConnections(userId: string): number {
  return closeConnectionsWhere((ctx) => ctx.userId === userId)
}

/**
 * Close every live connection on a specific Hocuspocus document (by its full
 * document name, e.g. `deck:abc` / `folder:xyz`). Used by the DOS-1 size cap
 * to disconnect the editor(s) flooding an over-limit document.
 */
export function closeConnectionsForDocument(documentName: string): number {
  return closeConnectionsWhere((_ctx, name) => name === documentName)
}
