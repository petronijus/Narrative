/**
 * Parity guards (docs/plans/agentic-layer.md §9.1). These are what make
 * "an agent can do everything a user can" fail the build instead of rot:
 *   - every slide-model export is classified, so a new one cannot slip in;
 *   - every slide-model writer is used by a command or listed as known-missing;
 *   - known-missing entries of finished phases are gone;
 *   - nothing is both a command and known-missing;
 *   - allowlist entries carry a real reason.
 */

import { describe, expect, it } from 'vitest'
import * as slideModel from '@narrative/slide-model'
import { createDefaultRegistry } from '../catalog.js'
import { SLIDE_MODEL_EXPORTS } from './slideModelExports.js'
import { FINISHED_PHASES, KNOWN_MISSING } from './knownMissing.js'
import { AGENT_ALLOWLIST } from './allowlist.js'
import { normaliseRoute, routeCoverage, routeKey } from './routes.js'

const registry = createDefaultRegistry()
const commands = registry.list()
const runtimeExports = Object.keys(slideModel).sort()
const usedWriters = new Set(commands.flatMap((c) => c.implementedWith))
const knownMissingWriters = new Set(KNOWN_MISSING.flatMap((m) => m.writers ?? []))

describe('slide-model export inventory', () => {
  it('classifies every runtime export of @narrative/slide-model (classify new exports in slideModelExports.ts)', () => {
    const unclassified = runtimeExports.filter((name) => !(name in SLIDE_MODEL_EXPORTS))
    expect(unclassified).toEqual([])
  })

  it('has no stale entries for exports that no longer exist', () => {
    const stale = Object.keys(SLIDE_MODEL_EXPORTS).filter((name) => !runtimeExports.includes(name))
    expect(stale).toEqual([])
  })

  it('reaches every writer through a command or lists it as known-missing', () => {
    const orphaned = Object.entries(SLIDE_MODEL_EXPORTS)
      .filter(([, kind]) => kind === 'writer')
      .map(([name]) => name)
      .filter((name) => !usedWriters.has(name) && !knownMissingWriters.has(name))
    expect(orphaned).toEqual([])
  })

  it("only names real slide-model exports in commands' implementedWith", () => {
    const bogus = commands.flatMap((c) =>
      c.implementedWith
        .filter((name) => !runtimeExports.includes(name))
        .map((name) => `${c.id}: ${name}`),
    )
    expect(bogus).toEqual([])
  })

  it('does not keep a writer in known-missing once a command uses it', () => {
    const both = [...knownMissingWriters].filter((w) => usedWriters.has(w))
    expect(both).toEqual([])
  })
})

describe('known-missing list', () => {
  it('has no entries left for finished phases', () => {
    const leftovers = KNOWN_MISSING.filter((m) => FINISHED_PHASES.includes(m.phase)).map(
      (m) => `${m.phase} ${m.capability}`,
    )
    expect(leftovers).toEqual([])
  })

  it('never lists a capability that is already a registered command', () => {
    const both = KNOWN_MISSING.filter((m) => registry.has(m.capability)).map((m) => m.capability)
    expect(both).toEqual([])
  })

  it('says where each capability lives today, in the shape its source needs', () => {
    const wrong = KNOWN_MISSING.flatMap((m) => {
      const hasWhere = m.where !== undefined && m.where.trim() !== ''
      const hasRoutes = m.routes !== undefined && m.routes.length > 0
      if (m.source === 'route' && !hasRoutes)
        return [`${m.capability}: source 'route' needs routes`]
      if (m.source === 'route' && hasWhere)
        return [`${m.capability}: a route source is named by routes, not where`]
      if ((m.source === 'web' || m.source === 'slide-model') && !hasWhere)
        return [`${m.capability}: needs where`]
      if (m.source === 'new' && (hasWhere || hasRoutes))
        return [`${m.capability}: a new capability has no source yet`]
      return []
    })
    expect(wrong).toEqual([])
  })

  it('has unique capabilities', () => {
    const seen = new Set<string>()
    const dupes = KNOWN_MISSING.map((m) => m.capability).filter((c) =>
      seen.has(c) ? true : (seen.add(c), false),
    )
    expect(dupes).toEqual([])
  })
})

describe('allowlist', () => {
  it('gives every deliberately excluded capability a real reason', () => {
    const weak = AGENT_ALLOWLIST.filter((a) => a.reason.trim().length < 20).map((a) => a.capability)
    expect(weak).toEqual([])
  })
})

describe('route claims (the server suite checks them against the Fastify route table)', () => {
  it('claim each route once, across commands, known-missing and the allowlist', () => {
    expect(() => routeCoverage(registry)).not.toThrow()
  })

  it('are written in their normalised form', () => {
    const claimed = [
      ...commands.flatMap((c) => c.routes ?? []),
      ...KNOWN_MISSING.flatMap((m) => m.routes ?? []),
      ...AGENT_ALLOWLIST.flatMap((a) => a.routes ?? []),
    ]
    const malformed = claimed
      .filter((r) => !r.path.startsWith('/') || (r.path.length > 1 && r.path.endsWith('/')))
      .map((r) => routeKey(r))
    expect(malformed).toEqual([])
  })

  it('normalise Fastify route records the same way on both sides', () => {
    const everyMethod = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT', 'OPTIONS', 'PROPFIND']
    expect(normaliseRoute(everyMethod, '/api/uploads')).toEqual([
      { method: 'ALL', path: '/api/uploads' },
    ])
    expect(normaliseRoute('HEAD', '/decks')).toEqual([])
    expect(normaliseRoute(['GET', 'HEAD'], '/decks/:id')).toEqual([
      { method: 'GET', path: '/decks/:id' },
    ])
    expect(routeKey({ method: 'GET', path: '/decks/:deckId/' })).toBe(
      routeKey({ method: 'GET', path: '/decks/:id' }),
    )
  })
})

/**
 * A description that names a command which does not exist sends a model to
 * a dead end. Every `<domain>.<name>` it mentions must be registered, or be
 * followed by "(planned, not available yet)" (and then give today's
 * workaround). `table.style.*` / `table.resize*` wildcards must match a
 * registered command.
 */
const DOMAIN_NAMES = [
  'deck',
  'folder',
  'token',
  'slide',
  'object',
  'text',
  'table',
  'animation',
  'guide',
  'media',
  'component',
  'share',
  'style',
  'query',
  'editor',
  'ops',
  'agent',
]
const COMMAND_MENTION = new RegExp(
  `\\b(?:${DOMAIN_NAMES.join('|')})(?:\\.[a-z][a-zA-Z]*)+(\\.?\\*)?`,
  'g',
)
const PLANNED = ' (planned, not available yet)'

describe('command descriptions', () => {
  it('only name commands that exist, or mark them planned', () => {
    const ids = commands.map((c) => c.id)
    const dangling = commands.flatMap((c) =>
      [...c.description.matchAll(COMMAND_MENTION)].flatMap((m) => {
        const mention = m[0]
        const wildcard = m[1] !== undefined
        const id = wildcard ? mention.slice(0, mention.length - m[1]!.length) : mention
        if (wildcard) return ids.some((x) => x.startsWith(id)) ? [] : [`${c.id} names ${mention}`]
        if (registry.has(id)) return []
        return c.description.startsWith(PLANNED, m.index + mention.length)
          ? []
          : [`${c.id} names ${id}`]
      }),
    )
    expect(dangling).toEqual([])
  })

  it('never mark a registered command as planned', () => {
    const stale = commands.flatMap((c) =>
      [...c.description.matchAll(COMMAND_MENTION)]
        .filter(
          (m) => registry.has(m[0]) && c.description.startsWith(PLANNED, m.index + m[0].length),
        )
        .map((m) => `${c.id} calls ${m[0]} planned`),
    )
    expect(stale).toEqual([])
  })
})

describe('command metadata quality', () => {
  it('asks for confirmation before every irreversible command', () => {
    const unconfirmed = commands
      .filter((c) => c.undo === 'irreversible' && c.confirm !== 'always')
      .map((c) => c.id)
    expect(unconfirmed).toEqual([])
  })

  it('marks read-only commands as viewer-safe and effect-free', () => {
    const wrong = commands
      .filter((c) => c.domain === 'query')
      .filter((c) => c.effects.length > 0 || c.role !== 'viewer')
      .map((c) => c.id)
    expect(wrong).toEqual([])
  })
})
