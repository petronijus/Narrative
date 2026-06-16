/**
 * hocuspocus/presence.ts
 *
 * Live snapshot of "who is currently editing which deck", queried
 * directly from the running Hocuspocus server's document/connection
 * registry. Used by the folder view to render avatar bubbles on each
 * deck tile.
 *
 * Why not maintain our own refcount?
 * The previous version tried to track state via onAuthenticate +
 * onDisconnect hooks, but the WebSocket close path is unreliable
 * (route changes, browser navigations, dropped TCP) and stale entries
 * accumulated — decks the user had visited earlier showed up as still
 * being edited. Reading directly from `Hocuspocus.documents` is ground
 * truth: when the WS closes, Hocuspocus removes the connection from
 * the Document; when the doc has no connections it eventually unloads.
 *
 * Single-process only. Multi-instance Hocuspocus would need a Redis
 * pub/sub fan-out, but the public API stays the same.
 */
import type { Hocuspocus } from '@hocuspocus/server'

let serverInstance: Hocuspocus | null = null

/** Wired once at startup so route handlers can query live state. */
export function setHocuspocusInstance(instance: Hocuspocus): void {
  serverInstance = instance
}

/**
 * The live Hocuspocus instance, or null if the sync server has not been
 * created yet (e.g. unit tests that only exercise HTTP routes). Used by
 * connection-teardown helpers that need to enumerate live connections on
 * access revocation (CONN-1).
 */
export function getHocuspocusInstance(): Hocuspocus | null {
  return serverInstance
}

function isTrackable(userId: unknown): userId is string {
  if (typeof userId !== 'string' || userId.length === 0) return false
  // Share-token connections have no stable identity worth surfacing.
  if (userId.startsWith('share:')) return false
  return true
}

/**
 * Resolve a Hocuspocus document name to a deck id. Deck docs use the
 * `deck:<id>` prefix; legacy bare names are treated as deck ids too.
 * Folder / component docs return null.
 */
export function deckIdFromDocName(documentName: string): string | null {
  if (documentName.startsWith('folder:')) return null
  if (documentName.startsWith('component:')) return null
  if (documentName.startsWith('deck:')) return documentName.slice('deck:'.length)
  return documentName
}

/**
 * Snapshot of currently-active user ids per deck, derived from the
 * Hocuspocus server's live `documents` map. Decks with no active
 * editors are omitted.
 */
export function activeEditorsByDeck(
  deckIds: ReadonlyArray<string>,
): Array<{ deckId: string; userIds: string[] }> {
  if (serverInstance === null) return []
  const out: Array<{ deckId: string; userIds: string[] }> = []
  for (const deckId of deckIds) {
    const userIds = new Set<string>()
    // Two possible doc-name shapes: prefixed (`deck:<id>`) and the
    // legacy bare id. Check both — old connections may still use the
    // unprefixed form.
    for (const docName of [`deck:${deckId}`, deckId]) {
      const doc = serverInstance.documents.get(docName)
      if (doc === undefined) continue
      for (const conn of doc.getConnections()) {
        const ctx = conn.context as { userId?: unknown } | undefined
        const uid = ctx?.userId
        if (isTrackable(uid)) userIds.add(uid)
      }
    }
    if (userIds.size > 0) {
      out.push({ deckId, userIds: Array.from(userIds) })
    }
  }
  return out
}
