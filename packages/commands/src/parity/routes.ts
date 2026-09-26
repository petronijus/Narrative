/**
 * commands/src/parity/routes.ts
 *
 * The agent-parity route guard's vocabulary (docs/plans/agentic-layer.md
 * §9.1): every route the API server registers must be backed by a command
 * (`CommandDef.routes`), be temporary debt (`KNOWN_MISSING[].routes`) or be
 * deliberately excluded (`AGENT_ALLOWLIST[].routes`). The server suite
 * (apps/server/src/routes/agentParity.test.ts) enumerates the Fastify route
 * table and checks it against `routeCoverage()`; both sides normalise
 * routes with the helpers below so they compare equal.
 */

import type { CommandRegistry } from '../registry.js'
import type { RouteRef } from '../types.js'
import { KNOWN_MISSING } from './knownMissing.js'
import { AGENT_ALLOWLIST } from './allowlist.js'

const CONCRETE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/**
 * A comparable key for a route: upper-case method, path with every param
 * name erased (`/decks/:id` and `/decks/:deckId` are the same route) and no
 * trailing slash.
 */
export function routeKey(route: RouteRef): string {
  const path = route.path
    .split('/')
    .map((seg) => (seg.startsWith(':') ? ':' : seg))
    .join('/')
    .replace(/(.)\/$/, '$1')
  return `${route.method} ${path}`
}

/**
 * Normalise what Fastify reports for a registered route (its `method`,
 * which is an array for `app.all()` / multi-method routes, and its `url`)
 * into route refs. A route registered for every concrete method becomes one
 * `ALL` ref; `HEAD` and `OPTIONS` are dropped (Fastify adds a HEAD twin to
 * every GET, and neither is a capability of its own).
 */
export function normaliseRoute(method: string | readonly string[], url: string): RouteRef[] {
  const methods = (typeof method === 'string' ? [method] : [...method]).map((m) => m.toUpperCase())
  if (CONCRETE_METHODS.every((m) => methods.includes(m))) return [{ method: 'ALL', path: url }]
  return methods
    .filter((m): m is RouteRef['method'] => (CONCRETE_METHODS as readonly string[]).includes(m))
    .map((m) => ({ method: m, path: url }))
}

/** What covers a route, for the guard's messages. */
export interface RouteCoverage {
  route: RouteRef
  by: string
}

/**
 * Every route something claims, keyed by `routeKey`: commands (by their
 * `routes`), known-missing entries and allowlist entries. Throws when two
 * of them claim the same route — a route has exactly one owner.
 */
export function routeCoverage(registry: CommandRegistry): Map<string, RouteCoverage> {
  const claims: RouteCoverage[] = [
    ...registry
      .list()
      .flatMap((c) => (c.routes ?? []).map((route) => ({ route, by: `command ${c.id}` }))),
    ...KNOWN_MISSING.flatMap((m) =>
      (m.routes ?? []).map((route) => ({ route, by: `known-missing ${m.capability}` })),
    ),
    ...AGENT_ALLOWLIST.flatMap((a) =>
      (a.routes ?? []).map((route) => ({ route, by: `allowlist "${a.capability}"` })),
    ),
  ]
  const byKey = new Map<string, RouteCoverage>()
  for (const claim of claims) {
    const key = routeKey(claim.route)
    const prior = byKey.get(key)
    if (prior !== undefined)
      throw new Error(`route ${key} is claimed twice: by ${prior.by} and by ${claim.by}`)
    byKey.set(key, claim)
  }
  return byKey
}
