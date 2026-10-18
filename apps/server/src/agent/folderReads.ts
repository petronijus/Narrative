/**
 * agent/folderReads.ts — what one command's folder readers share, and what
 * one run keeps of its folder's document between commands
 * (docs/plans/performance.md S3).
 *
 * The folder context a command declares (`readsFolderTokens`,
 * `readsStylePack`, `readsFolderFonts`) used to cost, per reader and per
 * command, a lookup of the target's folder and — for tokens and the style
 * pack — a read and decode of the folder document. An agent's build calls
 * such commands hundreds of times on one deck.
 *
 * Per command (`FolderReadScope`): the target's folder is looked up once,
 * however many readers ask. It is never kept longer: a deck can move to
 * another folder between two commands.
 *
 * Per run (`FolderDocumentCache`): what the readers derived from a folder
 * document (its tokens, its style pack), by folder id, valid only while the
 * document's VERSION is the one it was derived from:
 *   - a loaded document (live in the sync server) — its instance and the
 *     number of updates it has had since this process first looked at it;
 *     every change, from an editor or the server, is an update;
 *   - a document nobody has loaded — the id of its newest stored row: every
 *     store inserts a row with a higher id (hocuspocus/persistence.ts), and a
 *     document changes only while loaded (AGENTS.md: documents are written
 *     through the sync server), so an unchanged id is an unchanged document.
 * The version is taken BEFORE the document is read, so a change racing the
 * read leaves an entry under the older version, which the next command no
 * longer matches: a stale entry can be missed, never served. A source that
 * cannot give a version is read every time.
 *
 * Who sees an entry: the cache belongs to one run — one user, one agent
 * session, one target — and is consulted only after the host has checked
 * that user's access to the target for the command at hand (serverHost.ts
 * step 2), with the folder looked up for that command. It is never shared
 * across runs, users or folders, and it dies with the run. A hit returns a
 * copy, so a command cannot change what the next one sees.
 *
 * Fonts are not kept: a folder's font faces are rows of `media_assets`,
 * written from several places, and telling whether they changed costs the
 * query that reads them (a handful of small rows).
 */

import type * as Y from 'yjs'
import type { CommandTarget } from '@narrative/commands'

/** A folder document's version; see the module header. */
export type FolderDocumentVersion = string

/** Where folder documents come from (production: services/liveDocs.ts and the database). */
export interface FolderDocumentSources {
  /** The folder the target belongs to, or null. */
  folderOf(target: CommandTarget): Promise<string | null>
  /** A detached copy of the folder document; the reader destroys it. */
  readFolder(folderId: string): Promise<Y.Doc>
  /**
   * The document's current version (module header), or null when it cannot
   * tell — the readers then read the document every time.
   */
  version?(folderId: string): Promise<FolderDocumentVersion | null>
}

/** What a run keeps of folder documents: derived values by folder, kind and version. */
export class FolderDocumentCache {
  private readonly entries = new Map<
    string,
    { version: FolderDocumentVersion; values: Map<string, unknown> }
  >()

  /** A copy of the value derived as `kind` from `folderId` at `version`, if kept. */
  get(folderId: string, version: FolderDocumentVersion, kind: string): { value: unknown } | null {
    const entry = this.entries.get(folderId)
    if (entry === undefined || entry.version !== version || !entry.values.has(kind)) return null
    return { value: structuredClone(entry.values.get(kind)) }
  }

  /** Keep a copy of `value`; an entry of another version of the folder is replaced. */
  set(folderId: string, version: FolderDocumentVersion, kind: string, value: unknown): void {
    let entry = this.entries.get(folderId)
    if (entry === undefined || entry.version !== version) {
      entry = { version, values: new Map() }
      this.entries.set(folderId, entry)
    }
    entry.values.set(kind, structuredClone(value))
  }
}

/** The readers of ONE command: the folder lookup they share, and the run's cache (if any). */
export interface FolderReadScope {
  /** The target's folder, looked up at most once for this command. */
  folderOf(
    target: CommandTarget,
    lookup: (t: CommandTarget) => Promise<string | null>,
  ): Promise<string | null>
  /** The run's cache; null for an invocation outside a run (it reads every time). */
  readonly documents: FolderDocumentCache | null
}

/** A scope for one command; `documents` is its run's cache. */
export function createFolderReadScope(documents: FolderDocumentCache | null): FolderReadScope {
  // One command has one target, so one lookup answers every reader.
  let folder: Promise<string | null> | null = null
  return {
    folderOf(target, lookup) {
      folder ??= lookup(target)
      return folder
    },
    documents,
  }
}

/** The target's folder, through the scope when there is one. */
export function scopedFolderOf(
  sources: Pick<FolderDocumentSources, 'folderOf'>,
  target: CommandTarget,
  scope: FolderReadScope | undefined,
): Promise<string | null> {
  return scope === undefined
    ? sources.folderOf(target)
    : scope.folderOf(target, (t) => sources.folderOf(t))
}

/**
 * `derive` applied to the folder's document — from the run's cache when the
 * document's version is the one the kept value was derived from.
 */
export async function readFolderDerived<T>(
  sources: FolderDocumentSources,
  folderId: string,
  kind: string,
  scope: FolderReadScope | undefined,
  derive: (doc: Y.Doc) => T,
): Promise<T> {
  const cache = scope?.documents ?? null
  // Before the read: a change that races it leaves the entry under the older version.
  const version =
    cache === null || sources.version === undefined ? null : await sources.version(folderId)
  if (cache !== null && version !== null) {
    const hit = cache.get(folderId, version, kind)
    if (hit !== null) return hit.value as T
  }
  const doc = await sources.readFolder(folderId)
  try {
    const value = derive(doc)
    if (cache !== null && version !== null) cache.set(folderId, version, kind, value)
    return value
  } finally {
    doc.destroy()
  }
}

// ---------------------------------------------------------------------------
// The version of a loaded document
// ---------------------------------------------------------------------------

let nextInstance = 0
const liveVersions = new WeakMap<Y.Doc, { instance: number; updates: number }>()

/**
 * The version of a LOADED document: its instance (a reloaded document is
 * another) and how many updates it has had since this was first asked.
 * The listener counting them lives as long as the document.
 */
export function liveDocumentVersion(doc: Y.Doc): FolderDocumentVersion {
  let entry = liveVersions.get(doc)
  if (entry === undefined) {
    const created = { instance: nextInstance++, updates: 0 }
    doc.on('update', () => {
      created.updates += 1
    })
    liveVersions.set(doc, created)
    entry = created
  }
  return `live:${entry.instance}:${entry.updates}`
}
