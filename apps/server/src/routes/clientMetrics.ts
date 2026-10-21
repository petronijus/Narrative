/**
 * routes/clientMetrics.ts
 *
 *   POST /client-metrics   (public: /api/client-metrics)
 *     body: ClientMetricsReport (@narrative/shared clientMetrics.ts) → 204,
 *     400 for anything the schema refuses
 *
 * The editor's session report (performance plan G4): folded into the
 * `/metrics` histograms (metrics/clientMetrics.ts) and logged as one
 * structured line, `client session metrics`, carrying the report only (no
 * user, IP, deck or report id). A report id seen among the last 10,000 is
 * a repeat and counted nowhere. The numbers are what browsers assert: fine
 * for watching trends, not for alerting.
 *
 * Auth: a signed-in session only — `authPreHandler` refuses tokens, so no
 * agent writes here (not an agent capability: AGENT_ALLOWLIST) — from the
 * web app's origin (`requireSameOrigin`), rate limited per user.
 */

import type { FastifyInstance } from 'fastify'
import { clientMetricsReportSchema } from '@narrative/shared'
import { authPreHandler } from '../auth/fastifyAuth.js'
import { requireSameOrigin } from '../http/sameOrigin.js'
import { recordClientMetrics } from '../metrics/clientMetrics.js'

/**
 * Reports per user per minute. A page sends one per session (on its first
 * hide); this only bounds a script.
 */
export const CLIENT_METRICS_RATE_LIMIT = { max: 30, timeWindowMs: 60_000 } as const

/** The largest report body accepted (a real one is ~400 bytes). */
const CLIENT_METRICS_BODY_LIMIT = 4096

/** Report ids remembered to drop repeats (the most recent; ~40 bytes each). */
export const CLIENT_METRICS_SEEN_IDS = 10_000

/** A bounded set: the oldest ids go first once it is full. */
export class RecentIds {
  private readonly ids = new Set<string>()

  constructor(private readonly capacity: number) {}

  /** False when `id` is already in the set. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false
    this.ids.add(id)
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value
      if (oldest !== undefined) this.ids.delete(oldest)
    }
    return true
  }
}

const seenReports = new RecentIds(CLIENT_METRICS_SEEN_IDS)

export function registerClientMetricsRoute(app: FastifyInstance): void {
  app.post(
    '/client-metrics',
    {
      preHandler: [authPreHandler, requireSameOrigin],
      bodyLimit: CLIENT_METRICS_BODY_LIMIT,
      config: {
        rateLimit: {
          max: CLIENT_METRICS_RATE_LIMIT.max,
          timeWindow: CLIENT_METRICS_RATE_LIMIT.timeWindowMs,
        },
      },
    },
    async (req, reply) => {
      const parsed = clientMetricsReportSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_report' })
      }
      const { id, ...report } = parsed.data
      // One report per page session: a repeat is answered like the first and
      // counted nowhere.
      if (!seenReports.add(id)) return reply.status(204).send()
      recordClientMetrics(parsed.data)
      req.log.info({ clientMetrics: report }, 'client session metrics')
      return reply.status(204).send()
    },
  )
}
