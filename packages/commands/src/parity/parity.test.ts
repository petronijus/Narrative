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
import { COMMAND_DOMAINS, danglingCommandMentions } from '../agentSurface.js'
import { commandMetadataProblems } from '../registry.js'

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
 * registered command. The rule lives in agentSurface.ts, shared with the
 * playbook tests, so all model-facing prose follows one rule.
 */
describe('command descriptions', () => {
  it('only name commands that exist, or mark them planned (and never mark a registered one planned)', () => {
    const dangling = commands.flatMap((c) =>
      danglingCommandMentions(c.description, registry).map((d) => `${c.id}: ${d}`),
    )
    expect(dangling).toEqual([])
  })

  it('use only domains the mention pattern knows', () => {
    const unknown = [...new Set(commands.map((c) => c.domain))].filter(
      (d) => !(COMMAND_DOMAINS as readonly string[]).includes(d),
    )
    expect(unknown).toEqual([])
  })
})

describe('command metadata quality', () => {
  it('asks for confirmation before every irreversible command', () => {
    const unconfirmed = commands
      .filter((c) => c.undo === 'irreversible' && c.confirm !== 'always')
      .map((c) => c.id)
    expect(unconfirmed).toEqual([])
  })

  it('keeps read-only and idempotent metadata consistent (registry.ts commandMetadataProblems)', () => {
    const problems = commands.flatMap((c) => commandMetadataProblems(c).map((p) => `${c.id}: ${p}`))
    expect(problems).toEqual([])
  })

  it('marks every server read read-only (a list / get / status command that changes nothing)', () => {
    // A command that changes nothing but forgets `readOnly` would make every
    // Claude client ask the user before a harmless read. The registry cannot
    // see that a server call is a read, so the reads are pinned by name here:
    // a new one is added to this list together with its `readOnly: true`.
    const serverReads = [
      'agent.runs',
      'component.get',
      'component.list',
      'deck.activeEditors',
      'deck.fonts.list',
      'deck.get',
      'deck.list',
      'editor.context',
      'folder.fonts.list',
      'folder.invites.list',
      'folder.list',
      'folder.members.list',
      'media.fontUrl',
      'media.status',
      'media.url',
      'share.invites.list',
      'share.links.list',
      'share.permissions.list',
      'token.list',
      'token.usages',
    ]
    expect(serverReads.filter((id) => registry.get(id)?.readOnly !== true)).toEqual([])
    // …and every command named like a read is on that list or effect-free.
    const unlisted = commands
      .filter((c) => /\.(list|get|status|url|fontUrl|usages|runs|context)$/.test(c.id))
      .filter((c) => c.undo === 'n/a' && c.effects.length > 0 && !serverReads.includes(c.id))
      .map((c) => c.id)
    expect(unlisted).toEqual([])
  })

  it('marks read-only commands as viewer-safe and effect-free', () => {
    const wrong = commands
      .filter((c) => c.domain === 'query')
      .filter((c) => c.effects.length > 0 || c.role !== 'viewer')
      .map((c) => c.id)
    expect(wrong).toEqual([])
  })
})
