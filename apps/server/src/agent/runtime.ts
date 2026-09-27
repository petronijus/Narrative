/**
 * agent/runtime.ts
 *
 * Wires the agent host together, once per process: the document lease
 * layer, presence, the run manager (open runs + undo histories), the
 * server services every command gets, and the ServerHost. The HTTP command
 * routes (routes/agent.ts) and the MCP server call `runtime.host`.
 *
 * It also owns the process's periodic cleanup, because it is the one object
 * with a lifecycle (created at boot, shut down before Hocuspocus):
 *   - agent run retention: runs whose last activity is older than
 *     `AGENT_RUN_RETENTION_MS` (90 days) are deleted with their ops — the
 *     audit trail is for recent work, and op inputs, even redacted, are user
 *     content that should not accumulate forever. Runs at startup (after the
 *     stale-run close) and every `AGENT_RUN_RETENTION_INTERVAL_MS` (24 h).
 *     Open runs are never deleted; a run reaches 90 days idle only long
 *     after its 10-minute idle close and its 24-hour undo history.
 *   - export packages (services/exportSweep.ts): `decks/*\/exports/` objects
 *     older than a day, first a few minutes after start, then every 6 hours.
 * Both timers are `unref()`ed (they never keep the process alive) and
 * cleared by `shutdown()`. A startup sweep beats a separate cron: nothing
 * else to deploy, and a server restarted daily still sweeps.
 */

import type { Hocuspocus } from '@hocuspocus/server'
import type { FastifyBaseLogger } from 'fastify'
import {
  createDefaultRegistry,
  type CommandRegistry,
  type ServerServices,
} from '@narrative/commands'
import type { Database } from '../db/client.js'
import { createServerServices } from '../services/index.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { EXPORT_SWEEP_INTERVAL_MS, sweepExpiredExports } from '../services/exportSweep.js'
import { RunManager } from '../services/runs.js'
import { createDbAccess, type AgentAccess } from './access.js'
import { createAgentDocuments, type AgentDocuments } from './documents.js'
import { createAgentPresence, type AgentPresence, type AgentPrincipalKeys } from './presence.js'
import { createDrizzleRunStore, type RunStore } from './runStore.js'
import { createDbConfirmationLookups, type ConfirmationLookups } from './confirmationSummary.js'
import { AgentConfirmations } from './confirmations.js'
import { ServerHost } from './serverHost.js'

/** Agent runs (and their ops) idle for longer than this are deleted. */
export const AGENT_RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
/** How often run retention runs (it also runs once at startup). */
export const AGENT_RUN_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Delay before the first export sweep, so boot is not slowed by a bucket walk. */
export const EXPORT_SWEEP_FIRST_DELAY_MS = 5 * 60 * 1000

type SweepLog = Pick<FastifyBaseLogger, 'info' | 'error'>

/** Delete runs idle for longer than the retention window. Never throws; returns the count (0 on failure). */
export async function sweepAgentRunRetention(
  store: Pick<RunStore, 'deleteRunsInactiveBefore'>,
  now: Date,
  log: SweepLog,
  retentionMs: number = AGENT_RUN_RETENTION_MS,
): Promise<number> {
  try {
    const deleted = await store.deleteRunsInactiveBefore(new Date(now.getTime() - retentionMs))
    if (deleted > 0) log.info({ deleted }, 'agent run retention: old runs deleted')
    return deleted
  } catch (err) {
    log.error({ err }, 'agent run retention failed')
    return 0
  }
}

/**
 * Run `task` after `firstDelayMs`, then every `intervalMs`, never two at
 * once. Returns a stop function. The timers are unref()ed.
 */
function startPeriodic(
  task: () => Promise<unknown>,
  firstDelayMs: number,
  intervalMs: number,
): () => void {
  let running = false
  let stopped = false
  const tick = (): void => {
    if (running || stopped) return
    running = true
    void task().finally(() => {
      running = false
    })
  }
  const first = setTimeout(tick, firstDelayMs)
  first.unref?.()
  const every = setInterval(tick, intervalMs)
  every.unref?.()
  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(every)
  }
}

/**
 * AGENT_URL_FETCH_ALLOWED_HOSTS: comma-separated hostnames (no scheme, path
 * or port; matched exactly, case-insensitively — `example.com` does not admit
 * `cdn.example.com`) that agent URL downloads may contact without the user
 * confirming the host. Empty by default: every URL download is confirmed.
 * Throws on an entry that is not a plain hostname, so a typo fails the start
 * instead of silently confirming nothing.
 */
export function parseUrlFetchAllowedHosts(raw: string | undefined): string[] {
  const hosts: string[] = []
  for (const entry of (raw ?? '').split(',')) {
    const host = entry.trim().toLowerCase()
    if (host === '') continue
    let parsed: URL | null = null
    try {
      parsed = new URL(`http://${host}`)
    } catch {
      parsed = null
    }
    if (parsed === null || parsed.hostname !== host || parsed.port !== '' || /[/?#@\s]/.test(host))
      throw new Error(
        `AGENT_URL_FETCH_ALLOWED_HOSTS entry "${entry.trim()}" must be a plain hostname`,
      )
    if (!hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

export interface AgentRuntime {
  host: ServerHost
  runs: RunManager
  documents: AgentDocuments
  presence: AgentPresence
  services: ServerServices
  registry: CommandRegistry
  /** Pending out-of-band confirmations (MCP clients without form elicitation, the confirmation page). */
  confirmations: AgentConfirmations
  /** Close open runs, clear presence and release documents (before Hocuspocus is destroyed). */
  shutdown(): Promise<void>
}

export interface AgentRuntimeOptions {
  db: Database
  log: FastifyBaseLogger
  hocuspocus: Hocuspocus
  /** Public origin of the web app, for links handed to users. */
  appOrigin: string
  /**
   * Keys identifying whom an agent peer works for (agent/presence.ts), MACed
   * with AGENT_PRINCIPAL_KEY_SECRET. The same instance must go to the
   * Hocuspocus server, which tells each editor its own key.
   */
  principalKeys: AgentPrincipalKeys
  bypass?: boolean
  // Test seams — production uses the defaults.
  registry?: CommandRegistry
  store?: RunStore
  access?: AgentAccess
  documentLingerMs?: number
  runIdleMs?: number
  maxOpenRunsPerUser?: number
  presenceIdleMs?: number
  now?: () => Date
  /**
   * The periodic export sweep; `null` disables it (tests without a bucket).
   * Default: `sweepExpiredExports` against the media bucket.
   */
  exportSweep?: (() => Promise<unknown>) | null
  /** Run retention window (default `AGENT_RUN_RETENTION_MS`). */
  runRetentionMs?: number
  /**
   * Hostnames a URL download may contact without the user confirming it
   * (AGENT_URL_FETCH_ALLOWED_HOSTS, `parseUrlFetchAllowedHosts`). Empty by default.
   */
  urlFetchAllowedHosts?: readonly string[]
  /** Test seam: confirmation summary lookups (default: the database). */
  confirmationLookups?: ConfirmationLookups
}

export async function createAgentRuntime(opts: AgentRuntimeOptions): Promise<AgentRuntime> {
  const registry = opts.registry ?? createDefaultRegistry()
  const store = opts.store ?? createDrizzleRunStore(opts.db)
  const documents = createAgentDocuments(opts.hocuspocus, {
    ...(opts.documentLingerMs === undefined ? {} : { lingerMs: opts.documentLingerMs }),
  })
  const presence = createAgentPresence({
    principalKeys: opts.principalKeys,
    ...(opts.presenceIdleMs === undefined ? {} : { idleMs: opts.presenceIdleMs }),
  })

  const now = opts.now ?? (() => new Date())
  // Runs left `open` belong to a process that is gone: their undo history
  // died with it, and no session can continue them.
  try {
    const closed = await store.closeAllOpen(now())
    if (closed > 0)
      opts.log.info({ closed }, 'agent runs left open by a previous process were closed')
  } catch (err) {
    opts.log.error({ err }, 'closing stale agent runs failed')
  }

  // Retention (after the close above, so no stale `open` row is spared).
  const retain = (): Promise<number> =>
    sweepAgentRunRetention(store, now(), opts.log, opts.runRetentionMs)
  await retain()
  const stopRetention = startPeriodic(
    retain,
    AGENT_RUN_RETENTION_INTERVAL_MS,
    AGENT_RUN_RETENTION_INTERVAL_MS,
  )
  const exportSweep =
    opts.exportSweep === undefined
      ? () => sweepExpiredExports({ s3: buildS3Client(), bucket: MEDIA_BUCKET, log: opts.log })
      : opts.exportSweep
  const stopExportSweep =
    exportSweep === null
      ? () => undefined
      : startPeriodic(exportSweep, EXPORT_SWEEP_FIRST_DELAY_MS, EXPORT_SWEEP_INTERVAL_MS)

  const runs = new RunManager({
    store,
    documents,
    presence,
    registry,
    log: opts.log,
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.runIdleMs === undefined ? {} : { idleMs: opts.runIdleMs }),
    ...(opts.maxOpenRunsPerUser === undefined
      ? {}
      : { maxOpenRunsPerUser: opts.maxOpenRunsPerUser }),
  })
  const services = createServerServices({
    db: opts.db,
    log: opts.log,
    ...(opts.bypass === undefined ? {} : { bypass: opts.bypass }),
    hocuspocus: () => opts.hocuspocus,
    runs,
    appOrigin: opts.appOrigin,
  })
  const confirmations = new AgentConfirmations()
  const host = new ServerHost({
    registry,
    access: opts.access ?? createDbAccess(opts.db),
    documents,
    runs,
    services,
    log: opts.log,
    audit: { recordConfirmation: (runId, seq, c) => store.setOpConfirmation(runId, seq, c) },
    confirmations,
    confirmationLookups: opts.confirmationLookups ?? createDbConfirmationLookups(opts.db),
    urlFetchAllowedHosts: new Set(opts.urlFetchAllowedHosts ?? []),
  })

  return {
    host,
    runs,
    documents,
    presence,
    services,
    registry,
    confirmations,
    async shutdown() {
      stopRetention()
      stopExportSweep()
      await runs.shutdown()
      presence.clearAll()
      await documents.closeAll()
    },
  }
}
