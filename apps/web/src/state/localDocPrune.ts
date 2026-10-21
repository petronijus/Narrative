/**
 * state/localDocPrune.ts — deleting local document copies the user can no
 * longer open (ADR 0017, security review L1).
 *
 * A refused connection deletes a copy when the user opens its document
 * again; a copy of a document they never open again stayed until the 30-day
 * limit. When the home page has the user's folders, the copies are checked
 * against what the server says they reach:
 *
 *   - `folder:<id>` copies against the folder list itself;
 *   - `component:<id>` copies against the components of those folders (one
 *     list per folder, only when there are component copies; any failed
 *     list keeps them all);
 *   - deck copies one by one (`GET /decks/:id`) — a deck is reached through
 *     its folder, a grant or a share, and only the server knows which.
 *
 * Only a refusal (403) or a missing document (404) deletes; an error of any
 * other kind (offline, a server error) keeps the copy. Once per page load, at
 * idle, sequentially — at most 64 copies (the store's cap).
 */

import type { ApiClient } from '../api/client.js'
import { localCopyUser } from './localDocCopy.js'
import { deleteLocalDoc, indexedLocalDocs } from './localDocStore.js'

type PruneApi = Pick<ApiClient, 'getDeck' | 'listComponents'>

let prunedThisPage = false

/** The HTTP status of a failed API call (`HTTP 403`), or null. */
function statusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status
  if (typeof status === 'number') return status
  const match = err instanceof Error ? /HTTP (\d{3})/.exec(err.message) : null
  return match === null ? null : Number(match[1])
}

const gone = (err: unknown): boolean => {
  const status = statusOf(err)
  return status === 403 || status === 404
}

/**
 * Check the signed-in user's copies against what they reach (see the module
 * comment) and delete the rest. Returns the document names deleted.
 */
export async function pruneLocalCopies(
  api: PruneApi,
  folders: ReadonlyArray<{ id: string }>,
): Promise<string[]> {
  const user = localCopyUser()
  if (user === null) return []
  const names = indexedLocalDocs(user)
  if (names.length === 0) return []
  const deleted: string[] = []
  const drop = async (name: string): Promise<void> => {
    // Signed out (or someone else) meanwhile: their copies are gone already.
    if (localCopyUser() !== user) return
    await deleteLocalDoc(user, name)
    deleted.push(name)
  }

  const folderIds = new Set(folders.map((f) => f.id))
  for (const name of names) {
    if (name.startsWith('folder:') && !folderIds.has(name.slice('folder:'.length))) await drop(name)
  }

  const componentNames = names.filter((n) => n.startsWith('component:'))
  if (componentNames.length > 0) {
    const reached = new Set<string>()
    let complete = true
    for (const folder of folders) {
      try {
        for (const c of await api.listComponents(folder.id)) reached.add(c.id)
      } catch {
        complete = false
        break
      }
    }
    if (complete) {
      for (const name of componentNames) {
        if (!reached.has(name.slice('component:'.length))) await drop(name)
      }
    }
  }

  for (const name of names) {
    if (name.startsWith('folder:') || name.startsWith('component:')) continue
    try {
      await api.getDeck(name)
    } catch (err) {
      if (gone(err)) await drop(name)
    }
  }
  return deleted
}

/** {@link pruneLocalCopies} once per page load, when the page is idle. */
export function pruneLocalCopiesOnce(api: PruneApi, folders: ReadonlyArray<{ id: string }>): void {
  if (prunedThisPage) return
  prunedThisPage = true
  const run = (): void => {
    void pruneLocalCopies(api, folders).catch(() => undefined)
  }
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 10_000 })
  } else {
    window.setTimeout(run, 0)
  }
}

/** @internal Tests. */
export function __resetLocalCopyPruneForTests(): void {
  prunedThisPage = false
}
