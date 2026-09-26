/**
 * slide-model/src/origins.ts
 *
 * Transaction origins beyond the human `LOCAL_ORIGIN`.
 *
 * Yjs attributes every change to the `origin` of the transaction that made
 * it. Nested `doc.transact` calls keep the OUTERMOST origin, so a host that
 * wraps a whole command (or a batch of commands) in one transaction decides
 * the attribution of everything the slide-model mutations inside it write,
 * regardless of the `LOCAL_ORIGIN` those mutations pass themselves.
 *
 * An agent run gets its own origin object. It must be identity-stable for
 * the lifetime of the run — `Y.UndoManager.trackedOrigins` is a Set, and a
 * server-side revert manager scoped to one run relies on matching exactly
 * that run's transactions — hence the cache.
 */

export interface AgentOrigin {
  readonly kind: 'agent'
  readonly runId: string
}

const agentOrigins = new Map<string, AgentOrigin>()

/**
 * Origin for every write an agent run makes. Returns the same object for the
 * same `runId` until {@link releaseAgentOrigin} is called.
 */
export function agentOrigin(runId: string): AgentOrigin {
  if (runId.length === 0) throw new Error('agentOrigin: runId must not be empty')
  let origin = agentOrigins.get(runId)
  if (origin === undefined) {
    origin = Object.freeze({ kind: 'agent' as const, runId })
    agentOrigins.set(runId, origin)
  }
  return origin
}

/** Drop the cached origin of a finished run so the cache does not grow unbounded. */
export function releaseAgentOrigin(runId: string): void {
  agentOrigins.delete(runId)
}

export function isAgentOrigin(origin: unknown): origin is AgentOrigin {
  return (
    typeof origin === 'object' &&
    origin !== null &&
    (origin as { kind?: unknown }).kind === 'agent' &&
    typeof (origin as { runId?: unknown }).runId === 'string'
  )
}
