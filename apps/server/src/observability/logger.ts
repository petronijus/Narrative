/**
 * observability/logger.ts
 *
 * Shared standalone pino logger for server subsystems that run OUTSIDE the
 * Fastify request lifecycle — the Hocuspocus WebSocket server, its Postgres
 * persistence extension, the tus upload hooks, the email client. Those paths
 * have no `request.log` to hang off, and previously logged through bare
 * `console.*`, which produced unstructured, unleveled output that the prod
 * log pipeline (pino JSON) couldn't parse or filter.
 *
 * Config mirrors the Fastify logger in `index.ts`: pino-pretty in dev,
 * raw JSON in prod, honoring `LOG_LEVEL`. Child loggers (`logger.child({
 * subsystem })`) tag each line so prod logs stay greppable per subsystem.
 */

import pino from 'pino'

const isDev = process.env['NODE_ENV'] !== 'production'
// Vitest sets VITEST=true; keep subsystem logs out of test output (they made the
// reporter unreadable). Honors an explicit LOG_LEVEL override if a test needs it.
const isTest = process.env['VITEST'] !== undefined || process.env['NODE_ENV'] === 'test'

export const logger = pino(
  {
    level: process.env['LOG_LEVEL'] ?? (isTest ? 'silent' : 'info'),
  },
  isDev && !isTest
    ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
    : undefined,
)

/** Tag a logger with its subsystem so prod JSON logs stay filterable. */
export function subsystemLogger(subsystem: string): typeof logger {
  return logger.child({ subsystem })
}
