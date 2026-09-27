/**
 * services/http.ts — how an HTTP route builds the services it shares with
 * the agent commands. Per request (services are a handful of closures), so
 * each carries the request's logger and the app's BYPASS_AUTH setting.
 */

import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import type { ServiceDeps } from './deps.js'

/** BYPASS_AUTH dev mode, as the auth plugin recorded it on the app. */
export function isBypass(app: FastifyInstance): boolean {
  return (app as FastifyInstance & { _authOpts?: { bypass?: boolean } })._authOpts?.bypass === true
}

export function routeDeps(app: FastifyInstance, db: Database, log: FastifyBaseLogger): ServiceDeps {
  return { db, log, bypass: isBypass(app) }
}
