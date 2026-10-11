/**
 * `AgentRunService` — defined here, implemented by apps/server/src/services/runs.ts.
 * See ../services.ts for the pattern.
 *
 * A run is one agent session's work on one document — a deck or a component
 * master (plan §6, ADR 0011): every write of the run carries
 * `agentOrigin(runId)`, every command it executes is logged to `agent_ops`,
 * and the whole run (or its last N changes) can be reverted while the
 * document stays loaded on the server.
 */

import type { AgentSessionInfo } from '../types.js'

export type AgentRunStatus = 'open' | 'closed' | 'reverted'

/**
 * Why a run cannot be reverted (any more):
 * - `reverted`: it already was;
 * - `nothing_to_revert`: it has not changed the document (or every change was reverted);
 * - `unloaded`: the deck document was unloaded from the server (nobody had it
 *   open) or the server restarted — the per-run undo history lives in server
 *   memory only (plan §6 known limit; durable revert needs version history);
 * - `expired`: the server dropped the run's undo history to bound memory
 *   (only the most recent runs per document stay revertible);
 * - `not_document`: the run did not target a document (account/folder work).
 */
export type NotRevertibleReason =
  | 'reverted'
  | 'nothing_to_revert'
  | 'unloaded'
  | 'expired'
  | 'not_document'

export interface AgentRunSummary {
  id: string
  /** The user the agent acted for. */
  userId: string
  /** That user's display name (or email), when known. */
  userName: string | null
  surface: 'mcp' | 'api'
  clientName: string | null
  /** The user's request as the agent stated it in `agent.startRun`; null for implicit runs. */
  request: string | null
  status: AgentRunStatus
  /** ISO timestamps. */
  createdAt: string
  lastActivityAt: string
  revertedAt: string | null
  revertedBy: string | null
  /** Every command the run executed (reads and failures included). */
  opCount: number
  /** Commands of the run that succeeded and could change something (writes). */
  changeCount: number
  /** Changes that can still be reverted right now. */
  revertibleChanges: number
  revertible: boolean
  notRevertibleReason: NotRevertibleReason | null
}

/**
 * The document a run works on: a deck, or a component master (an agent edits
 * a master through the same document commands, targeted with `componentId`).
 * Runs outside any document (account work) are opened by the host
 * implicitly and never through these service calls.
 */
export type RunDocument =
  | { kind: 'deck'; deckId: string }
  | { kind: 'component'; componentId: string }

export interface StartRunArgs {
  userId: string
  session: AgentSessionInfo
  /** The document the run works on. */
  target: RunDocument
  /** The user's request, in the agent's words ("Shorten slide 3 to two bullets"). */
  request: string
}

export interface ListRunsArgs {
  userId: string
  /** The document whose runs to list; the caller is authorised on it. */
  target: RunDocument
  limit: number
}

export interface RevertRunArgs {
  /** Who reverts (recorded as `reverted_by_sub`). */
  userId: string
  /** The document the caller was authorised on; the run must belong to it. */
  target: RunDocument
  runId: string
  /** Revert only the run's last N changes; omitted = the whole run. */
  lastOps?: number
}

export interface RevertRunResult {
  runId: string
  /** How many changes were undone. */
  revertedChanges: number
  /** Changes of the run still in place (0 after a whole-run revert). */
  remainingChanges: number
  status: AgentRunStatus
}

export interface AgentRunService {
  /**
   * Open a new run for the calling session on `target`, closing the
   * session's previous run on that document. Subsequent commands of the
   * session on that document belong to it.
   */
  startRun(args: StartRunArgs): Promise<{ runId: string }>
  /** Recent runs on a document, newest first. The caller is authorised on it. */
  listRuns(args: ListRunsArgs): Promise<AgentRunSummary[]>
  /**
   * Undo a run's document changes — only that run's, so edits other people
   * made meanwhile stay. Fails with `not_found` for a run of another document,
   * `conflict` when the run is no longer revertible (with the reason).
   */
  revertRun(args: RevertRunArgs): Promise<RevertRunResult>
  /**
   * The document a run changed, as it was just before the run's first write
   * to it — the "before" of `query.render`'s compare. Null when the run has
   * written no document yet, or its history is no longer held (it lives as
   * long as the run's undo history, see `notRevertibleReason`).
   */
  stateBefore(runId: string): { document: RunDocument; update: Uint8Array } | null
}
