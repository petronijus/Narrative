/**
 * commands/src/batchForks.ts — the forks atomic batches run on
 * (`ops.apply`, run.ts `runBatch`; docs/plans/performance.md S3).
 *
 * An atomic batch runs its ops on a FORK of the live document and applies
 * the fork's change to the live document only when every op succeeded, so a
 * failure leaves the live document exactly as it was (a Yjs transaction
 * cannot be rolled back). Forking used to copy the whole document per batch
 * — `encodeStateAsUpdate` + `applyUpdate`, then `encodeStateAsUpdate(fork,
 * stateVector)`, which walks the whole delete set — so on a large deck the
 * copy cost more than the ops.
 *
 * `BatchForks` keeps one fork per live document instead, made on its first
 * batch and kept in step afterwards:
 *   - every update of the live document (people's edits, single commands,
 *     the batch's own change) is queued and replayed onto the fork before
 *     the next batch — Yjs updates are idempotent, so replaying the batch's
 *     own change is a no-op — and the state vectors are compared as a check;
 *     the fork is rebuilt if they differ;
 *   - the batch's change is the fork's own `update` event of the batch's
 *     transaction (its new structs and its delete set), not a diff against
 *     the whole document;
 *   - a batch that fails drops the fork (it holds the failed ops' writes);
 *     the next one makes a new one, so all-or-nothing is unchanged;
 *   - while the live document is inside a transaction that has already
 *     changed it, the replayed updates do not include that change yet, so
 *     such a batch runs on a one-off fork of the document as it is.
 * The fork has a client id of its own for as long as it lives. (A fork that
 * borrowed the live document's id, as before, made Yjs give the FORK a new
 * random id on every copy — the live document had written under that id —
 * so every batch added a client to the document.)
 *
 * Memory: a kept fork is a second copy of its document. It is dropped
 * after `idleMs` without a batch, when its live document is destroyed, when
 * the queue of updates to replay passes `maxPendingBytes` (replaying would
 * cost more than a copy), and beyond `maxForks` documents (least recently
 * used first). Without a `BatchForks` (the editor), `runBatch` makes a
 * one-off fork per batch.
 */

import * as Y from 'yjs'

export interface BatchForksOptions {
  /** Drop a fork after this long without a batch (default 60 s). */
  idleMs?: number
  /** Drop a fork whose queued updates pass this size (default 4 MB). */
  maxPendingBytes?: number
  /** Keep forks of at most this many documents (default 16). */
  maxForks?: number
}

export const DEFAULT_BATCH_FORK_IDLE_MS = 60_000
export const DEFAULT_BATCH_FORK_MAX_PENDING_BYTES = 4 * 1024 * 1024
export const DEFAULT_BATCH_FORK_MAX_FORKS = 16

/** What running ops on a fork gave: the ops' value and the fork's change (null: nothing changed). */
export interface ForkRun<T> {
  value: T
  update: Uint8Array | null
}

interface Entry {
  live: Y.Doc
  fork: Y.Doc
  pending: Uint8Array[]
  pendingBytes: number
  /** The live document's open transaction, while one is open. */
  open: Y.Transaction | null
  idle: ReturnType<typeof setTimeout> | null
  detach(): void
}

function freshFork(live: Y.Doc): Y.Doc {
  const fork = new Y.Doc({ gc: live.gc, gcFilter: live.gcFilter })
  // Never the live document's id (Yjs would re-roll it on the first copy).
  while (fork.clientID === live.clientID) fork.clientID = Math.floor(Math.random() * 2 ** 32)
  Y.applyUpdate(fork, Y.encodeStateAsUpdate(live))
  return fork
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

/** Whether `tr` (an open transaction of `doc`) has already changed the document. */
function hasChanged(doc: Y.Doc, tr: Y.Transaction): boolean {
  if (tr.deleteSet.clients.size > 0) return true
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc)))
    if ((tr.beforeState.get(client) ?? 0) !== clock) return true
  return false
}

/**
 * `fn` on `fork` in ONE transaction; its change is the transaction's
 * update. Throws what `fn` throws (the fork then holds partial writes).
 */
function runOn<T>(fork: Y.Doc, fn: (fork: Y.Doc) => T): ForkRun<T> {
  const updates: Uint8Array[] = []
  const onUpdate = (u: Uint8Array): void => {
    updates.push(u)
  }
  fork.on('update', onUpdate)
  let out!: { value: T }
  try {
    fork.transact(() => {
      out = { value: fn(fork) }
    })
  } finally {
    fork.off('update', onUpdate)
  }
  const update =
    updates.length === 0 ? null : updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates)
  return { value: out.value, update }
}

/** A one-off fork of `live` as it is now, for one batch. */
export function runOnOneOffFork<T>(live: Y.Doc, fn: (fork: Y.Doc) => T): ForkRun<T> {
  const fork = freshFork(live)
  try {
    return runOn(fork, fn)
  } finally {
    fork.destroy()
  }
}

export class BatchForks {
  private readonly idleMs: number
  private readonly maxPendingBytes: number
  private readonly maxForks: number
  /** Insertion order = least recently used first. */
  private readonly entries = new Map<Y.Doc, Entry>()
  private closed = false

  constructor(opts: BatchForksOptions = {}) {
    this.idleMs = opts.idleMs ?? DEFAULT_BATCH_FORK_IDLE_MS
    this.maxPendingBytes = opts.maxPendingBytes ?? DEFAULT_BATCH_FORK_MAX_PENDING_BYTES
    this.maxForks = opts.maxForks ?? DEFAULT_BATCH_FORK_MAX_FORKS
  }

  /** How many documents have a fork kept (tests, metrics). */
  get size(): number {
    return this.entries.size
  }

  /**
   * Run `fn` on a fork equal to `live` now, in one transaction of the fork.
   * Throws what `fn` throws; the fork is then dropped. The caller applies
   * `update` to `live` (once all ops succeeded).
   */
  run<T>(live: Y.Doc, fn: (fork: Y.Doc) => T): ForkRun<T> {
    if (this.closed) return runOnOneOffFork(live, fn)
    let entry = this.entries.get(live) ?? null
    if (entry !== null && entry.open !== null && hasChanged(live, entry.open)) {
      // The open transaction's change is in no update yet: fork the document as it is.
      return runOnOneOffFork(live, fn)
    }
    if (entry !== null && !this.catchUp(entry)) {
      this.drop(entry)
      entry = null
    }
    if (entry === null) {
      // Without a kept fork, the open-transaction check needs the transaction:
      // a fresh copy of the document as it is now is exact either way.
      entry = this.create(live)
    }
    // Most recently used last.
    this.entries.delete(live)
    this.entries.set(live, entry)
    try {
      const out = runOn(entry.fork, fn)
      this.armIdle(entry)
      return out
    } catch (e) {
      this.drop(entry)
      throw e
    }
  }

  /** Drop every fork (shutdown). Later batches use one-off forks. */
  close(): void {
    this.closed = true
    for (const entry of [...this.entries.values()]) this.drop(entry)
  }

  /** Replay what the live document did since the last batch; false = out of step. */
  private catchUp(entry: Entry): boolean {
    if (entry.pending.length > 0) {
      const pending = entry.pending
      entry.pending = []
      entry.pendingBytes = 0
      try {
        Y.applyUpdate(entry.fork, pending.length === 1 ? pending[0]! : Y.mergeUpdates(pending))
      } catch {
        return false
      }
    }
    return sameBytes(Y.encodeStateVector(entry.fork), Y.encodeStateVector(entry.live))
  }

  private create(live: Y.Doc): Entry {
    const entry: Entry = {
      live,
      fork: freshFork(live),
      pending: [],
      pendingBytes: 0,
      open: null,
      idle: null,
      detach: () => undefined,
    }
    const onUpdate = (u: Uint8Array): void => {
      entry.pending.push(u)
      entry.pendingBytes += u.byteLength
      if (entry.pendingBytes > this.maxPendingBytes) this.drop(entry)
    }
    const onBefore = (tr: Y.Transaction): void => {
      entry.open = tr
    }
    const onAfter = (): void => {
      entry.open = null
    }
    const onDestroy = (): void => this.drop(entry)
    live.on('update', onUpdate)
    live.on('beforeTransaction', onBefore)
    live.on('afterTransaction', onAfter)
    live.on('destroy', onDestroy)
    entry.detach = () => {
      live.off('update', onUpdate)
      live.off('beforeTransaction', onBefore)
      live.off('afterTransaction', onAfter)
      live.off('destroy', onDestroy)
    }
    this.entries.set(live, entry)
    for (const [doc, other] of this.entries) {
      if (this.entries.size <= this.maxForks) break
      if (doc !== live) this.drop(other)
    }
    return entry
  }

  private armIdle(entry: Entry): void {
    if (entry.idle !== null) clearTimeout(entry.idle)
    entry.idle = setTimeout(() => this.drop(entry), this.idleMs)
    ;(entry.idle as { unref?: () => void }).unref?.()
  }

  private drop(entry: Entry): void {
    if (this.entries.get(entry.live) === entry) this.entries.delete(entry.live)
    if (entry.idle !== null) clearTimeout(entry.idle)
    entry.idle = null
    entry.detach()
    entry.pending = []
    entry.pendingBytes = 0
    entry.fork.destroy()
  }
}
