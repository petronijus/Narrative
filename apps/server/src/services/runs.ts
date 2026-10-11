/**
 * services/runs.ts — server implementation of `AgentRunService`
 * (packages/commands/src/services/runs.ts), plus the run bookkeeping the
 * agent host relies on (plan §6, ADR 0011 points 3–4).
 *
 * What a run is
 *   One agent session's work on one target: a deck, a component master, or
 *   the account (deck/folder CRUD and other work outside any document). The
 *   host opens one implicitly on the session's first write to a target;
 *   `agent.startRun` opens one explicitly per user request; a run is closed
 *   after 10 minutes without activity, when the session ends, when the
 *   session starts a new run on the same target, or when it is reverted.
 *
 * Per-run revert
 *   Every write of a run carries `agentOrigin(runId)`. On the run's first
 *   write to a document, a `Y.UndoManager` is attached to THAT live Y.Doc
 *   (the one Hocuspocus holds and every editor is synced to), scoped to the
 *   deck's `slides` + `guides` and tracking only the run's origin — so
 *   undoing it removes the run's changes and nothing people did meanwhile.
 *   The document as it was just then is kept beside it (`stateBefore`, the
 *   "before" of query.render's compare), for as long as the history.
 *   `captureTimeout: Infinity` plus `stopCapturing()` after every op makes
 *   each op (a command, or an `ops.apply` batch) exactly one stack item, so
 *   "the last N changes" is the last N stack items. A revert runs all its
 *   undo steps inside ONE transaction, so editors receive one update.
 *
 * Limits (honest, reported through `notRevertibleReason`)
 *   - The undo history lives in server memory on the loaded document. An
 *     open run holds a document lease, so the document stays loaded while
 *     the agent works; after the run closes, it stays loaded only while
 *     someone has it open. Unload or restart → `unloaded`. Durable revert
 *     needs version history (M18).
 *   - Memory is bounded: per document only the most recent
 *     `maxUndoRunsPerDocument` runs, and none older than `undoMaxAgeMs`,
 *     keep their history → `expired`. (An UndoManager pins every item it
 *     could restore, so an unbounded history would pin deleted content
 *     forever.)
 *   - Single process: runs, history and presence are per server process.
 */

import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import type { Document } from '@hocuspocus/server'
import type { FastifyBaseLogger } from 'fastify'
import {
  CommandError,
  type AgentRunService,
  type AgentRunSummary,
  type AgentSessionInfo,
  type AnyCommandDef,
  type CommandRegistry,
  type NotRevertibleReason,
  type RevertRunResult,
  type RunDocument,
} from '@narrative/commands'
import { agentOrigin, releaseAgentOrigin } from '@narrative/slide-model'
import type { ServiceDeps } from './deps.js'
import type { AgentDocuments, DocumentLease } from '../agent/documents.js'
import type { AgentPresence } from '../agent/presence.js'
import type { Touched } from '../agent/touched.js'
import type { OpRecord, RunRecord, RunStatus, RunStore } from '../agent/runStore.js'
import { redactForAudit } from '../agent/opRedaction.js'

type Log = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

/** A run is split after this long without activity (plan §6). */
export const RUN_IDLE_MS = 10 * 60_000
export const MAX_UNDO_RUNS_PER_DOCUMENT = 20
/**
 * Open runs one user may have at once (across sessions and targets). Every
 * open run of a document keeps that document loaded, so without a bound one
 * token could keep hundreds of decks in memory for 10 idle minutes each;
 * past the cap the user's least recently active run is closed.
 */
export const MAX_OPEN_RUNS_PER_USER = 20
export const UNDO_MAX_AGE_MS = 24 * 60 * 60_000
/** Results larger than this are logged as a size note, not verbatim. */
export const MAX_LOGGED_RESULT_BYTES = 16 * 1024
const MAX_TOMBSTONES = 2_000

export type RunTarget =
  | { kind: 'deck'; deckId: string }
  | { kind: 'component'; componentId: string }
  | { kind: 'account' }

export function runTargetKey(target: RunTarget): string {
  switch (target.kind) {
    case 'deck':
      return `deck:${target.deckId}`
    case 'component':
      return `component:${target.componentId}`
    case 'account':
      return 'account'
  }
}

/** A run that is open in this process. */
export interface ActiveRun {
  readonly id: string
  readonly userId: string
  /** The user's display name, for the agent's presence peer (never the sub). */
  readonly userName: string | null
  readonly session: AgentSessionInfo
  readonly target: RunTarget
  readonly targetKey: string
  readonly request: string | null
  readonly createdAt: Date
  lastActivityAt: Date
  status: RunStatus
  /** Last assigned op sequence number (ops are numbered from 1). */
  seq: number
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Keeps the run's document loaded while the run is open. */
  lease: DocumentLease | null
}

/** A run's "before" state larger than this is not kept (query.render's compare refuses it). */
export const MAX_BEFORE_STATE_BYTES = 8 * 1024 * 1024
/**
 * The "before" states of all runs together, in this process: past it, the
 * oldest are let go (their compare answers "history gone"); the undo
 * histories themselves are not touched.
 */
export const BEFORE_STATES_BUDGET_BYTES = 128 * 1024 * 1024

interface UndoEntry {
  runId: string
  documentName: string
  document: Document
  manager: Y.UndoManager
  lastActivity: number
  /**
   * The document as it was just before the run's first write (query.render's
   * compare). It goes with the history, or earlier: null when it was over
   * `MAX_BEFORE_STATE_BYTES`, or let go under `BEFORE_STATES_BUDGET_BYTES`.
   */
  before: Uint8Array | null
}

/** Yjs origin of a revert's transaction: deliberately not tracked by any run's UndoManager. */
export interface AgentRevertOrigin {
  readonly kind: 'agent-revert'
  readonly runId: string
}

/** Is this command a write (for implicit run creation and change counts)? */
export function isWriteCommand(def: Pick<AnyCommandDef, 'undo'>): boolean {
  return def.undo !== 'n/a'
}

export interface RunManagerOptions {
  store: RunStore
  documents: AgentDocuments
  presence: AgentPresence
  registry: CommandRegistry
  log: Log
  now?: () => Date
  newRunId?: () => string
  idleMs?: number
  maxUndoRunsPerDocument?: number
  maxOpenRunsPerUser?: number
  undoMaxAgeMs?: number
  /** The kept "before" states together (default `BEFORE_STATES_BUDGET_BYTES`). */
  beforeStatesBudgetBytes?: number
  /**
   * After a revert of a run on a deck changed its document. A revert can
   * bring back references to media of a folder the deck has left since; the
   * server points them at the deck's copies here (services/localiseMedia.ts
   * `repointMovedMedia`). Awaited before `revertRun` returns;
   * its failure is logged, the revert stands.
   */
  afterDeckRevert?: (deckId: string) => Promise<void>
}

export interface OpToRecord {
  command: string
  input: unknown
  target: Record<string, string>
  result?: unknown
  error?: { code: string; message: string; issues?: unknown; opIndex?: number }
  /** Hosts the op's downloads contacted (agent_ops.fetched_hosts). */
  fetchedHosts?: string[]
}

function boundedResult(result: unknown): unknown {
  if (result === undefined) return undefined
  // Redact first (inline bytes shrink to a digest), then bound the size.
  const redacted = redactForAudit(result)
  let json: string
  try {
    json = JSON.stringify(redacted) ?? 'null'
  } catch {
    return { unserialisable: true }
  }
  const bytes = Buffer.byteLength(json, 'utf8')
  return bytes > MAX_LOGGED_RESULT_BYTES ? { truncated: true, bytes } : redacted
}

export class RunManager implements AgentRunService {
  private readonly store: RunStore
  private readonly documents: AgentDocuments
  private readonly presence: AgentPresence
  private readonly registry: CommandRegistry
  private readonly log: Log
  private readonly now: () => Date
  private readonly newRunId: () => string
  private readonly idleMs: number
  private readonly maxUndoRunsPerDocument: number
  private readonly maxOpenRunsPerUser: number
  private readonly undoMaxAgeMs: number
  private readonly beforeStatesBudgetBytes: number
  private readonly afterDeckRevert: ((deckId: string) => Promise<void>) | undefined

  /** Open runs of this process, by id. */
  private readonly open = new Map<string, ActiveRun>()
  /** The current open run of each session on each target: `${session}|${target}` → run id. */
  private readonly current = new Map<string, string>()
  /** Live undo histories, by run id (outlive their run until unload / expiry / revert). */
  private readonly undo = new Map<string, UndoEntry>()
  /** Why a history is gone, for runs whose history this process dropped. */
  private readonly tombstones = new Map<string, NotRevertibleReason>()
  /** Documents we listen to for `destroy` (one listener each). */
  private readonly watched = new WeakSet<Document>()
  private shuttingDown = false

  constructor(opts: RunManagerOptions) {
    this.store = opts.store
    this.documents = opts.documents
    this.presence = opts.presence
    this.registry = opts.registry
    this.log = opts.log
    this.now = opts.now ?? (() => new Date())
    this.newRunId = opts.newRunId ?? (() => `run_${nanoid(16)}`)
    this.idleMs = opts.idleMs ?? RUN_IDLE_MS
    this.maxUndoRunsPerDocument = opts.maxUndoRunsPerDocument ?? MAX_UNDO_RUNS_PER_DOCUMENT
    this.beforeStatesBudgetBytes = opts.beforeStatesBudgetBytes ?? BEFORE_STATES_BUDGET_BYTES
    this.maxOpenRunsPerUser = opts.maxOpenRunsPerUser ?? MAX_OPEN_RUNS_PER_USER
    this.undoMaxAgeMs = opts.undoMaxAgeMs ?? UNDO_MAX_AGE_MS
    this.afterDeckRevert = opts.afterDeckRevert
  }

  // -------------------------------------------------------------------------
  // Run lifecycle (host-facing)
  // -------------------------------------------------------------------------

  private currentKey(session: AgentSessionInfo, targetKey: string): string {
    return `${session.key}|${targetKey}`
  }

  /** The session's current open run on a target, if any. Never creates one. */
  currentRun(session: AgentSessionInfo, target: RunTarget): ActiveRun | undefined {
    const id = this.current.get(this.currentKey(session, runTargetKey(target)))
    const run = id === undefined ? undefined : this.open.get(id)
    if (run === undefined) return undefined
    if (this.now().getTime() - run.lastActivityAt.getTime() >= this.idleMs) {
      // The idle timer is late (event loop busy): treat the run as closed.
      void this.closeRun(run, 'idle')
      return undefined
    }
    return run
  }

  /**
   * The run an invocation belongs to. With `runId`, that run (it must be
   * open, started by the SAME session — the same MCP session, or for the
   * command API the same token / session key — and on this target).
   * Another session of the same user cannot attach to it: a run id seen in
   * the Agent activity list or in a log is not a credential that lets a
   * second client write under someone else's run, its attribution and its
   * revert history. Otherwise the session's
   * current run on the target — created now when `write` is true and there
   * is none, so every agent write is attributed to a run.
   */
  async runFor(args: {
    userId: string
    session: AgentSessionInfo
    target: RunTarget
    write: boolean
    runId?: string
  }): Promise<ActiveRun | undefined> {
    const targetKey = runTargetKey(args.target)
    if (args.runId !== undefined) {
      const run = this.open.get(args.runId)
      if (run === undefined || run.userId !== args.userId || run.session.key !== args.session.key) {
        throw new CommandError(
          'conflict',
          `run '${args.runId}' is not open (it was closed, reverted or never existed); start a new one with agent.startRun`,
        )
      }
      if (run.targetKey !== targetKey) {
        throw new CommandError(
          'conflict',
          `run '${args.runId}' works on ${run.targetKey}, not ${targetKey}`,
        )
      }
      this.current.set(this.currentKey(args.session, targetKey), run.id)
      return run
    }
    const existing = this.currentRun(args.session, args.target)
    if (existing !== undefined || !args.write) return existing
    return this.createRun({
      userId: args.userId,
      session: args.session,
      target: args.target,
      request: null,
    })
  }

  private async createRun(args: {
    userId: string
    session: AgentSessionInfo
    target: RunTarget
    request: string | null
  }): Promise<ActiveRun> {
    if (this.shuttingDown) throw new CommandError('failed', 'the server is shutting down')
    const targetKey = runTargetKey(args.target)
    const createdAt = this.now()
    let userName: string | null = null
    try {
      userName = await this.store.userDisplayName(args.userId)
    } catch (err) {
      // Cosmetic (the presence label): never fail a run over it.
      this.log.warn({ user: args.userId, err }, 'agent run: reading the display name failed')
    }
    const run: ActiveRun = {
      id: this.newRunId(),
      userId: args.userId,
      userName,
      session: args.session,
      target: args.target,
      targetKey,
      request: args.request,
      createdAt,
      lastActivityAt: createdAt,
      status: 'open',
      seq: 0,
      idleTimer: null,
      lease: null,
    }
    await this.store.insertRun({
      id: run.id,
      userSub: run.userId,
      deckId: args.target.kind === 'deck' ? args.target.deckId : null,
      componentId: args.target.kind === 'component' ? args.target.componentId : null,
      surface: args.session.surface,
      clientName: args.session.clientName ?? null,
      request: args.request,
      createdAt,
    })
    // Close the session's previous run on this target (a new request).
    const key = this.currentKey(args.session, targetKey)
    const previousId = this.current.get(key)
    const previous = previousId === undefined ? undefined : this.open.get(previousId)
    if (previous !== undefined) {
      // The session keeps working on the same document: hand the lease on,
      // so the document (and with it the previous run's undo history) does
      // not unload between two requests of one session.
      run.lease = previous.lease
      previous.lease = null
    }
    this.open.set(run.id, run)
    this.current.set(key, run.id)
    this.armIdle(run)
    if (previous !== undefined) await this.closeRun(previous, 'replaced')
    // Bound the documents one user keeps loaded (MAX_OPEN_RUNS_PER_USER).
    const mine = [...this.open.values()]
      .filter((r) => r.userId === run.userId && r.id !== run.id)
      .sort((a, b) => a.lastActivityAt.getTime() - b.lastActivityAt.getTime())
    for (let excess = mine.length + 1 - this.maxOpenRunsPerUser; excess > 0; excess--) {
      const oldest = mine.shift()
      if (oldest !== undefined) await this.closeRun(oldest, 'capacity')
    }
    this.log.info(
      { runId: run.id, user: run.userId, target: targetKey, surface: args.session.surface },
      'agent run opened',
    )
    return run
  }

  private armIdle(run: ActiveRun): void {
    if (run.idleTimer !== null) clearTimeout(run.idleTimer)
    run.idleTimer = setTimeout(() => {
      run.idleTimer = null
      void this.closeRun(run, 'idle')
    }, this.idleMs)
    run.idleTimer.unref?.()
  }

  /** Record activity on a run (resets its idle timer). */
  async touch(run: ActiveRun): Promise<void> {
    if (run.status !== 'open') return
    run.lastActivityAt = this.now()
    this.armIdle(run)
    try {
      await this.store.touchRun(run.id, run.lastActivityAt)
    } catch (err) {
      this.log.error({ runId: run.id, err }, 'agent run: recording activity failed')
    }
  }

  /**
   * Log one op of a run to `agent_ops`. A logging failure never fails the op
   * (it already happened). Input and result are redacted first
   * (agent/opRedaction.ts): inline file bytes become their size and digest,
   * URLs lose query strings, fragments and credentials.
   */
  async recordOp(run: ActiveRun, op: OpToRecord): Promise<number> {
    run.seq += 1
    const record: OpRecord = {
      runId: run.id,
      seq: run.seq,
      command: op.command,
      input: redactForAudit(op.input ?? null),
      target: op.target,
      createdAt: this.now(),
      ...(op.error === undefined ? { result: boundedResult(op.result) } : { error: op.error }),
      ...(op.fetchedHosts === undefined || op.fetchedHosts.length === 0
        ? {}
        : { fetchedHosts: [...op.fetchedHosts] }),
    }
    try {
      await this.store.insertOp(record)
    } catch (err) {
      this.log.error(
        { runId: run.id, seq: record.seq, command: op.command, err },
        'agent run: logging op failed',
      )
    }
    return record.seq
  }

  private async closeRun(
    run: ActiveRun,
    reason: 'idle' | 'replaced' | 'session' | 'reverted' | 'shutdown' | 'capacity',
  ): Promise<void> {
    if (!this.open.has(run.id)) return
    this.open.delete(run.id)
    for (const [key, id] of this.current) if (id === run.id) this.current.delete(key)
    if (run.idleTimer !== null) clearTimeout(run.idleTimer)
    run.idleTimer = null
    if (run.status === 'open') run.status = 'closed'
    // Only the current run is compared with (query.render): a closed one's
    // "before" is let go now, its undo history kept.
    const entry = this.undo.get(run.id)
    if (entry !== undefined) entry.before = null
    run.lease?.release()
    run.lease = null
    this.presence.clearRun(run.id)
    // The run's UndoManager keeps its own reference to the origin object;
    // no write can carry this origin any more, so the cache may forget it.
    releaseAgentOrigin(run.id)
    if (reason !== 'reverted') {
      try {
        await this.store.closeRun(run.id, this.now())
      } catch (err) {
        this.log.error({ runId: run.id, err }, 'agent run: closing failed')
      }
    }
    this.log.info({ runId: run.id, reason }, 'agent run closed')
  }

  /** The session is gone (MCP session closed): close its runs. */
  async endSession(sessionKey: string): Promise<void> {
    const runs = [...this.open.values()].filter((r) => r.session.key === sessionKey)
    await Promise.all(runs.map((r) => this.closeRun(r, 'session')))
  }

  /** Close every open run and drop every history (process shutdown). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    await Promise.all([...this.open.values()].map((r) => this.closeRun(r, 'shutdown')))
    for (const entry of [...this.undo.values()]) this.dropHistory(entry, 'unloaded')
    this.presence.clearAll()
  }

  // -------------------------------------------------------------------------
  // Document writes (host-facing)
  // -------------------------------------------------------------------------

  /**
   * Call before a run writes `lease.document`: attaches the run's undo
   * history to that live document (so it captures the write that follows)
   * and makes the run hold the document loaded for as long as it is open.
   */
  async beforeDocumentWrite(run: ActiveRun, lease: DocumentLease): Promise<void> {
    if (run.lease === null && run.status === 'open') {
      run.lease = await this.documents.acquire(lease.documentName)
    }
    const existing = this.undo.get(run.id)
    if (
      existing !== undefined &&
      existing.document === lease.document &&
      !lease.document.isDestroyed
    ) {
      return
    }
    // A run that already wrote before this history (its document was
    // reloaded under it): a "before" taken now would hide those writes.
    const partial = existing !== undefined || this.tombstones.has(run.id)
    if (existing !== undefined) {
      // The document was unloaded and reloaded under the run (only possible
      // if its lease was lost): the old history died with the old instance.
      this.dropHistory(existing, 'unloaded')
    }
    this.sweep()
    const document = lease.document
    const manager = new Y.UndoManager([document.getArray('slides'), document.getArray('guides')], {
      trackedOrigins: new Set<unknown>([agentOrigin(run.id)]),
      // One stack item per op: never merge by time, split explicitly with
      // stopCapturing() after each op (afterDocumentWrite).
      captureTimeout: Number.POSITIVE_INFINITY,
    })
    this.undo.set(run.id, {
      runId: run.id,
      documentName: lease.documentName,
      document,
      manager,
      lastActivity: this.now().getTime(),
      // A compare is of a deck only, and of the whole run only.
      before:
        run.target.kind === 'deck' && !partial
          ? this.keepBefore(Y.encodeStateAsUpdate(document))
          : null,
    })
    this.tombstones.delete(run.id)
    this.watchDocument(document)
    this.enforceDocumentCap(document)
  }

  /**
   * Call after the write, also when it failed: closes the op's undo step (so
   * the next op never merges into it) and, when the write succeeded
   * (`touched` is not null), moves the agent's presence peer.
   */
  afterDocumentWrite(run: ActiveRun, document: Document, touched: Touched | null): void {
    const entry = this.undo.get(run.id)
    if (entry !== undefined && entry.document === document) {
      entry.manager.stopCapturing()
      entry.lastActivity = this.now().getTime()
    }
    if (touched !== null && run.target.kind === 'deck') {
      this.presence.show(
        document,
        {
          runId: run.id,
          userId: run.userId,
          userName: run.userName,
          surface: run.session.surface,
          clientName: run.session.clientName ?? null,
        },
        touched,
      )
    }
  }

  private watchDocument(document: Document): void {
    if (this.watched.has(document)) return
    this.watched.add(document)
    document.once('destroy', () => {
      for (const entry of [...this.undo.values()]) {
        if (entry.document === document)
          this.dropHistory(entry, 'unloaded', { documentDestroyed: true })
      }
    })
  }

  private dropHistory(
    entry: UndoEntry,
    reason: NotRevertibleReason,
    opts: { documentDestroyed?: boolean } = {},
  ): void {
    if (this.undo.get(entry.runId) === entry) this.undo.delete(entry.runId)
    if (!opts.documentDestroyed && !entry.document.isDestroyed) {
      // Unpin the deleted items the history kept restorable, then detach.
      entry.manager.clear()
    }
    entry.manager.destroy()
    this.tombstones.set(entry.runId, reason)
    while (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.tombstones.keys().next().value
      if (oldest === undefined) break
      this.tombstones.delete(oldest)
    }
  }

  /** Drop histories older than the age limit (never those of open runs). */
  private sweep(): void {
    const cutoff = this.now().getTime() - this.undoMaxAgeMs
    for (const entry of [...this.undo.values()]) {
      if (entry.lastActivity < cutoff && !this.open.has(entry.runId))
        this.dropHistory(entry, 'expired')
    }
  }

  private enforceDocumentCap(document: Document): void {
    const onDoc = [...this.undo.values()]
      .filter((e) => e.document === document && !this.open.has(e.runId))
      .sort((a, b) => a.lastActivity - b.lastActivity)
    const openOnDoc = [...this.undo.values()].filter(
      (e) => e.document === document && this.open.has(e.runId),
    ).length
    let excess = onDoc.length + openOnDoc - this.maxUndoRunsPerDocument
    for (const entry of onDoc) {
      if (excess <= 0) break
      this.dropHistory(entry, 'expired')
      excess--
    }
  }

  // -------------------------------------------------------------------------
  // AgentRunService
  // -------------------------------------------------------------------------

  async startRun(args: {
    userId: string
    session: AgentSessionInfo
    target: RunDocument
    request: string
  }): Promise<{ runId: string }> {
    const run = await this.createRun({
      userId: args.userId,
      session: args.session,
      target: args.target,
      request: args.request,
    })
    return { runId: run.id }
  }

  private changeCount(opCounts: ReadonlyArray<{ command: string; succeeded: number }>): number {
    let n = 0
    for (const c of opCounts) {
      const def = this.registry.get(c.command)
      if (def !== undefined && isWriteCommand(def)) n += c.succeeded
    }
    return n
  }

  private revertState(
    run: Pick<RunRecord, 'id' | 'status' | 'deckId' | 'componentId'>,
    changeCount: number,
  ): { revertibleChanges: number; reason: NotRevertibleReason | null } {
    if (run.status === 'reverted') return { revertibleChanges: 0, reason: 'reverted' }
    if (run.deckId === null && run.componentId === null)
      return { revertibleChanges: 0, reason: 'not_document' }
    const entry = this.undo.get(run.id)
    if (entry !== undefined && entry.document.isDestroyed) {
      this.dropHistory(entry, 'unloaded', { documentDestroyed: true })
      return { revertibleChanges: 0, reason: 'unloaded' }
    }
    if (entry === undefined) {
      const tomb = this.tombstones.get(run.id)
      if (tomb !== undefined) return { revertibleChanges: 0, reason: tomb }
      return { revertibleChanges: 0, reason: changeCount > 0 ? 'unloaded' : 'nothing_to_revert' }
    }
    const n = entry.manager.undoStack.length
    return { revertibleChanges: n, reason: n > 0 ? null : 'nothing_to_revert' }
  }

  async listRuns(args: {
    userId: string
    target: RunDocument
    limit: number
  }): Promise<AgentRunSummary[]> {
    this.sweep()
    const rows = await this.store.listRuns(args.target, args.limit)
    return rows.map((row) => {
      const live = this.open.get(row.id)
      const status: RunStatus =
        row.status === 'reverted' ? 'reverted' : live !== undefined ? 'open' : row.status
      const lastActivityAt = live?.lastActivityAt ?? row.lastActivityAt
      const changeCount = this.changeCount(row.opCounts)
      const { revertibleChanges, reason } = this.revertState({ ...row, status }, changeCount)
      return {
        id: row.id,
        userId: row.userSub,
        userName: row.userName,
        surface: row.surface,
        clientName: row.clientName,
        request: row.request,
        status,
        createdAt: row.createdAt.toISOString(),
        lastActivityAt: lastActivityAt.toISOString(),
        revertedAt: row.revertedAt?.toISOString() ?? null,
        revertedBy: row.revertedBySub,
        opCount: row.opCounts.reduce((sum, c) => sum + c.total, 0),
        changeCount,
        revertibleChanges,
        revertible: reason === null,
        notRevertibleReason: reason,
      }
    })
  }

  async revertRun(args: {
    userId: string
    target: RunDocument
    runId: string
    lastOps?: number
  }): Promise<RevertRunResult> {
    const live = this.open.get(args.runId)
    const record = live !== undefined ? null : await this.store.getRun(args.runId)
    const runTarget =
      live !== undefined ? live.target : record === null ? null : recordTarget(record)
    if (runTarget === null || runTargetKey(runTarget) !== runTargetKey(args.target)) {
      const where = args.target.kind === 'deck' ? 'this deck' : 'this component master'
      throw new CommandError('not_found', `run '${args.runId}' does not exist on ${where}`)
    }
    const status = live?.status ?? record?.status
    if (status === 'reverted')
      throw new CommandError('conflict', `run '${args.runId}' was already reverted`)

    const entry = this.undo.get(args.runId)
    if (entry === undefined || entry.document.isDestroyed) {
      if (entry !== undefined) this.dropHistory(entry, 'unloaded', { documentDestroyed: true })
      const reason = this.tombstones.get(args.runId) ?? 'unloaded'
      throw new CommandError('conflict', notRevertibleMessage(args.runId, reason))
    }
    const stack = entry.manager.undoStack
    if (stack.length === 0) {
      throw new CommandError('conflict', notRevertibleMessage(args.runId, 'nothing_to_revert'))
    }

    const lease = await this.documents.acquire(entry.documentName)
    const before = stack.length
    const wanted = Math.min(args.lastOps ?? before, before)
    try {
      if (lease.document !== entry.document) {
        // The document was reloaded: the history belongs to a dead instance.
        this.dropHistory(entry, 'unloaded')
        throw new CommandError('conflict', notRevertibleMessage(args.runId, 'unloaded'))
      }
      const origin: AgentRevertOrigin = Object.freeze({ kind: 'agent-revert', runId: args.runId })
      await lease.transact((document) => {
        // One transaction for every undo step: one update for editors. The
        // UndoManager's own transactions nest into it; its origin is not
        // tracked by any run, so a revert is never itself recorded.
        document.transact(() => {
          while (
            entry.manager.undoStack.length > 0 &&
            before - entry.manager.undoStack.length < wanted
          ) {
            entry.manager.undo()
          }
        }, origin)
      })
    } finally {
      lease.release()
    }
    const remaining = entry.manager.undoStack.length
    const revertedChanges = before - remaining
    let finalStatus: RunStatus = live?.status ?? record?.status ?? 'closed'
    if (remaining === 0) {
      finalStatus = 'reverted'
      this.dropHistory(entry, 'reverted')
      try {
        await this.store.markReverted(args.runId, args.userId, this.now())
      } catch (err) {
        this.log.error({ runId: args.runId, err }, 'agent run: recording the revert failed')
      }
      if (live !== undefined) {
        live.status = 'reverted'
        await this.closeRun(live, 'reverted')
      } else {
        this.presence.clearRun(args.runId)
      }
    }
    this.log.info(
      { runId: args.runId, by: args.userId, revertedChanges, remaining },
      'agent run reverted',
    )
    // The revert may have brought back pictures of a folder the deck has
    // left since the run: copied into the deck now, not only at the next store.
    if (runTarget.kind === 'deck' && revertedChanges > 0 && this.afterDeckRevert !== undefined) {
      try {
        await this.afterDeckRevert(runTarget.deckId)
      } catch (err) {
        this.log.warn(
          { runId: args.runId, deckId: runTarget.deckId, err },
          'agent run: catching up old folder media after the revert failed',
        )
      }
    }
    return { runId: args.runId, revertedChanges, remainingChanges: remaining, status: finalStatus }
  }

  /**
   * The document a run works on (null: unknown run, or a run outside any
   * document). For routes addressed by run id, which then authorise the
   * caller on that document.
   */
  async documentOfRun(runId: string): Promise<RunDocument | null> {
    const live = this.open.get(runId)
    const target =
      live !== undefined
        ? live.target
        : await this.store.getRun(runId).then((r) => (r === null ? null : recordTarget(r)))
    return target === null || target.kind === 'account' ? null : target
  }

  // -------------------------------------------------------------------------
  // Introspection (tests, metrics)
  // -------------------------------------------------------------------------

  /** Number of runs open in this process. */
  openRunCount(): number {
    return this.open.size
  }

  /**
   * A new "before" state, or null when it is too large to be of use; makes
   * room within the budget by letting the oldest kept ones go (the Map keeps
   * insertion order, so the first entries are the oldest runs).
   */
  private keepBefore(update: Uint8Array): Uint8Array | null {
    if (update.byteLength > MAX_BEFORE_STATE_BYTES) return null
    let total = update.byteLength
    for (const entry of this.undo.values()) total += entry.before?.byteLength ?? 0
    for (const entry of this.undo.values()) {
      if (total <= this.beforeStatesBudgetBytes) break
      if (entry.before === null) continue
      total -= entry.before.byteLength
      entry.before = null
    }
    return update
  }

  stateBefore(runId: string): { document: RunDocument; update: Uint8Array } | null {
    const entry = this.undo.get(runId)
    if (entry === undefined || entry.document.isDestroyed || entry.before === null) return null
    const name = entry.documentName
    const document: RunDocument = name.startsWith('component:')
      ? { kind: 'component', componentId: name.slice('component:'.length) }
      : { kind: 'deck', deckId: name.startsWith('deck:') ? name.slice('deck:'.length) : name }
    return { document, update: entry.before }
  }

  /** The live UndoManager of a run, if its history is still held. */
  undoManagerOf(runId: string): Y.UndoManager | undefined {
    return this.undo.get(runId)?.manager
  }
}

/** The target a stored run was opened on. */
function recordTarget(record: Pick<RunRecord, 'deckId' | 'componentId'>): RunTarget {
  if (record.deckId !== null) return { kind: 'deck', deckId: record.deckId }
  if (record.componentId !== null) return { kind: 'component', componentId: record.componentId }
  return { kind: 'account' }
}

export function notRevertibleMessage(runId: string, reason: NotRevertibleReason): string {
  switch (reason) {
    case 'reverted':
      return `run '${runId}' was already reverted`
    case 'nothing_to_revert':
      return `run '${runId}' has no changes left to revert`
    case 'unloaded':
      return (
        `run '${runId}' is no longer revertible (document was unloaded): its undo history lived in server ` +
        'memory and went away when nobody had the deck (or master) open, or when the server restarted. Undo its ' +
        'changes by editing.'
      )
    case 'expired':
      return (
        `run '${runId}' is no longer revertible (its undo history expired): the server keeps it only for the ` +
        'most recent runs on a deck and for a limited time. Undo its changes by editing.'
      )
    case 'not_document':
      return `run '${runId}' did not change a document, so there is nothing to revert`
  }
}

/**
 * The `runs` member of `ServerServices`. The run manager is one stateful
 * object per process (it holds open runs and undo histories), created by
 * the agent runtime and handed to every service set through `deps`.
 */
export function createRunsService(deps: ServiceDeps): AgentRunService {
  if (deps.runs !== undefined) return deps.runs
  const unavailable = (): never => {
    throw new CommandError('wrong_host', 'agent runs are not available in this server process')
  }
  return {
    startRun: unavailable,
    listRuns: unavailable,
    revertRun: unavailable,
    // No runs in this process: nothing changed by one.
    stateBefore: () => null,
  }
}
