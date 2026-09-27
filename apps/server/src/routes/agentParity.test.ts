/**
 * routes/agentParity.test.ts — the agent-parity route guard
 * (docs/plans/agentic-layer.md §9.1, ADR 0010).
 *
 * Builds the API's route table exactly as production does (the same
 * `registerHttpRoutes` index.ts calls, on a bare Fastify instance with a
 * stub database — nothing is served or queried) and requires every route to
 * be claimed by exactly one of:
 *   - a command that wraps it (`CommandDef.routes`),
 *   - temporary debt (`KNOWN_MISSING[].routes` in packages/commands), or
 *   - a deliberate, reasoned exclusion (`AGENT_ALLOWLIST[].routes`).
 * It also fails when a claim names a route the server no longer registers,
 * so the lists cannot rot. A new endpoint therefore cannot ship without the
 * agent surface noticing.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import {
  createDefaultRegistry,
  normaliseRoute,
  routeCoverage,
  routeKey,
  type RouteRef,
} from '@narrative/commands'
import { registerHttpRoutes } from '../http/registerRoutes.js'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import type { Database } from '../db/client.js'
import type { AgentRuntime } from '../agent/runtime.js'
import type { McpRuntime } from '../mcp/runtime.js'

async function registeredRoutes(): Promise<RouteRef[]> {
  const app = Fastify({ logger: false })
  const routes: RouteRef[] = []
  app.addHook('onRoute', (route) => {
    routes.push(...normaliseRoute(route.method, route.url))
  })
  // Route handlers close over the database; registration never touches it.
  const db = {} as Database
  registerAuthPlugin(app, { bypass: true, db })
  await registerHttpRoutes(app, {
    db,
    // Production registers /metrics only with METRICS_TOKEN set; the guard
    // must see every route the server CAN serve.
    metrics: true,
    auth: {
      verifier: null,
      spaOrigin: 'http://localhost:5173',
      redirectUri: 'http://localhost:3001/auth/callback',
      isProd: false,
      allowlist: { allowedEmails: [], allowedDomain: undefined },
    },
    // Like the database: the agent routes close over the agent host and
    // registering them never touches it.
    agent: {} as AgentRuntime,
    // The MCP routes read their runtime only when a request arrives.
    mcp: { mcp: {} as McpRuntime, allowedOrigins: [] },
  })
  // Plugins registered with app.register() add their routes when loaded.
  await app.ready()
  await app.close()
  return routes
}

describe('agent parity: every API route is backed by a command, known-missing, or allowlisted', () => {
  const coverage = routeCoverage(createDefaultRegistry())
  let routes: RouteRef[] = []
  let registered = new Set<string>()

  beforeAll(async () => {
    routes = await registeredRoutes()
    registered = new Set(routes.map(routeKey))
  })

  it('enumerates the whole route table, plugin routes included (sanity check)', () => {
    const core: RouteRef[] = [
      { method: 'GET', path: '/health' },
      { method: 'GET', path: '/decks/:id/export.pptx' },
      { method: 'ALL', path: '/api/uploads/*' },
      { method: 'GET', path: '/api/media/:assetId/font-url' },
      { method: 'GET', path: '/metrics' },
    ]
    for (const r of core) expect(registered, routeKey(r)).toContain(routeKey(r))
  })

  it('has an owner for every registered route', () => {
    const unclaimed = routes
      .filter((r) => !coverage.has(routeKey(r)))
      .map((r) => `${r.method} ${r.path}`)
      .sort()
    // Each route here needs a command (CommandDef.routes), or — only while
    // the command is being built — a KNOWN_MISSING entry of a phase that is
    // not finished, or, if it is not a user capability, an AGENT_ALLOWLIST
    // entry with a real reason (a reviewed change). See
    // packages/commands/src/parity/.
    expect(unclaimed).toEqual([])
  })

  it('claims no route the server does not register', () => {
    const stale = [...coverage.entries()]
      .filter(([key]) => !registered.has(key))
      .map(([, c]) => `${c.route.method} ${c.route.path} (${c.by})`)
      .sort()
    expect(stale).toEqual([])
  })
})
