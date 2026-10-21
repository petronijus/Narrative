/**
 * routes/clientMetrics.test.ts — the editor's session reports (G4): a valid
 * report from the signed-in browser lands in /metrics' histograms; tokens,
 * anonymous callers, foreign origins and anything outside the schema are
 * refused and leave the histograms alone. Sessions are mocked at
 * `lookupSession` (cookie `narrative_session=s-<user>` is <user>).
 */

import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

vi.mock('../auth/session.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/session.js')>()
  return {
    ...original,
    lookupSession: vi.fn(async (_db: unknown, raw: string) => {
      const m = /^s-(user-\d+)$/.exec(raw)
      return m ? { userSub: m[1]!, userEmail: `${m[1]}@example.com`, userName: null } : null
    }),
  }
})

import type { ClientMetricsReport } from '@narrative/shared'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import { createPatService, type PatService } from '../auth/personalAccessTokens.js'
import type { Database } from '../db/client.js'
import { registerSameOriginPolicy } from '../http/sameOrigin.js'
import { formatPrometheus } from '../metrics/collectors.js'
import { _resetClientMetrics } from '../metrics/clientMetrics.js'
import { allowAllPatOwners, createMemoryPatStore } from '../test-support/memoryPatStore.js'
import { RecentIds, registerClientMetricsRoute } from './clientMetrics.js'

const SPA = 'http://localhost:5173'
let app: FastifyInstance
let pats: PatService

const report = (over: Partial<ClientMetricsReport> = {}): ClientMetricsReport => ({
  v: 1,
  id: randomUUID(),
  route: 'editor',
  nav: { ttfbMs: 120, fcpMs: 640, domContentLoadedMs: 700 },
  deckLoad: {
    cold: true,
    wsConnectedMs: 180,
    wsSyncedMs: 420,
    pixiReadyMs: 380,
    firstPaintMs: 900,
    longTaskMs: 310,
  },
  longTasks: { count: 7, totalMs: 1200, maxMs: 260 },
  inp: { interactions: 12, inpMs: 96 },
  ...over,
})

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/client-metrics',
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  })
const asUser = { cookie: 'narrative_session=s-user-1', origin: SPA }

/** The value of one exposition line, by its exact series name and labels. */
function sample(series: string): number | undefined {
  const line = formatPrometheus()
    .split('\n')
    .find((l) => l.startsWith(`${series} `))
  return line === undefined ? undefined : Number(line.slice(series.length + 1))
}

beforeEach(async () => {
  _resetClientMetrics()
  pats = createPatService(createMemoryPatStore(), { isOwnerAllowed: allowAllPatOwners })
  app = Fastify({ logger: false })
  registerAuthPlugin(app, { bypass: false, db: {} as Database, pats })
  registerSameOriginPolicy(app, { allowedOrigins: [SPA] })
  registerClientMetricsRoute(app)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

describe('POST /client-metrics', () => {
  it('folds a report into the histograms', async () => {
    const res = await post(report(), asUser)
    expect(res.statusCode).toBe(204)

    expect(sample('narrative_client_reports_total{route="editor"}')).toBe(1)
    // 900 ms falls in the 1000 bucket, not the 750 one; cumulative to +Inf.
    const fp = 'narrative_client_deck_first_paint_ms_bucket{route="editor",load="cold"'
    expect(sample(`${fp},le="750"}`)).toBe(0)
    expect(sample(`${fp},le="1000"}`)).toBe(1)
    expect(sample(`${fp},le="+Inf"}`)).toBe(1)
    expect(sample('narrative_client_deck_first_paint_ms_sum{route="editor",load="cold"}')).toBe(900)
    expect(sample('narrative_client_deck_ws_synced_ms_count{route="editor",load="cold"}')).toBe(1)
    expect(sample('narrative_client_inp_ms_bucket{route="editor",le="100"}')).toBe(1)
    expect(sample('narrative_client_session_long_tasks_bucket{route="editor",le="5"}')).toBe(0)
    expect(sample('narrative_client_session_long_tasks_bucket{route="editor",le="10"}')).toBe(1)
    expect(sample('narrative_client_nav_ttfb_ms_sum{route="editor"}')).toBe(120)
  })

  it('keeps cold and warm deck opens and the routes apart, and skips missing marks', async () => {
    await post(report(), asUser)
    await post(
      report({
        route: 'present',
        nav: { ttfbMs: null, fcpMs: null, domContentLoadedMs: null },
        deckLoad: {
          cold: false,
          wsConnectedMs: 20,
          wsSyncedMs: 60,
          pixiReadyMs: null,
          firstPaintMs: null,
          longTaskMs: 0,
        },
        inp: { interactions: 0, inpMs: null },
      }),
      asUser,
    )
    expect(sample('narrative_client_deck_ws_synced_ms_count{route="present",load="warm"}')).toBe(1)
    expect(sample('narrative_client_deck_ws_synced_ms_count{route="editor",load="cold"}')).toBe(1)
    expect(
      sample('narrative_client_deck_first_paint_ms_count{route="present",load="warm"}'),
    ).toBeUndefined()
    expect(sample('narrative_client_nav_ttfb_ms_count{route="present"}')).toBeUndefined()
    expect(sample('narrative_client_inp_ms_count{route="present"}')).toBeUndefined()
    expect(sample('narrative_client_reports_total{route="present"}')).toBe(1)
  })

  it('takes a session without a deck open', async () => {
    const res = await post(report({ route: 'home', deckLoad: null }), asUser)
    expect(res.statusCode).toBe(204)
    expect(sample('narrative_client_reports_total{route="home"}')).toBe(1)
  })

  it.each([
    ['an unknown field (no room for content)', { ...report(), deckId: 'd1' }],
    ['a path instead of a route kind', { ...report(), route: '/deck/abc' }],
    ['a negative duration', report({ longTasks: { count: 1, totalMs: -5, maxMs: 1 } })],
    ['a duration past the bound', report({ inp: { interactions: 1, inpMs: 600_001 } })],
    ['a fraction', report({ longTasks: { count: 1.5, totalMs: 5, maxMs: 1 } })],
    ['another schema version', { ...report(), v: 2 }],
  ])('refuses %s', async (_name, body) => {
    const res = await post(body, asUser)
    expect(res.statusCode).toBe(400)
    expect(sample('narrative_client_reports_total{route="editor"}')).toBeUndefined()
  })

  it('refuses an anonymous caller, a token and a foreign origin', async () => {
    expect((await post(report(), { origin: SPA })).statusCode).toBe(401)
    const { token } = await pats.create('user-1', { name: 't', scopes: ['api'], expiresInDays: 30 })
    expect((await post(report(), { authorization: `Bearer ${token}` })).statusCode).toBe(403)
    const foreign = await post(report(), { ...asUser, origin: 'https://evil.example' })
    expect(foreign.statusCode).toBe(403)
    expect(sample('narrative_client_reports_total{route="editor"}')).toBeUndefined()
  })

  it('counts one report per page session: a repeated id is accepted and dropped', async () => {
    const once = report()
    expect((await post(once, asUser)).statusCode).toBe(204)
    expect((await post(once, asUser)).statusCode).toBe(204)
    expect((await post({ ...once, route: 'present' }, asUser)).statusCode).toBe(204)
    expect(sample('narrative_client_reports_total{route="editor"}')).toBe(1)
    expect(sample('narrative_client_reports_total{route="present"}')).toBeUndefined()
  })

  it('refuses a report without a UUID id', async () => {
    const { id: _id, ...noId } = report()
    expect((await post(noId, asUser)).statusCode).toBe(400)
    expect((await post({ ...report(), id: 'session-1' }, asUser)).statusCode).toBe(400)
  })

  it('refuses a body larger than a report can be', async () => {
    const res = await post({ ...report(), pad: 'x'.repeat(5000) }, asUser)
    expect(res.statusCode).toBe(413)
  })
})

describe('RecentIds', () => {
  it('remembers the most recent ids up to its capacity', () => {
    const ids = new RecentIds(3)
    expect(ids.add('a')).toBe(true)
    expect(ids.add('a')).toBe(false)
    ids.add('b')
    ids.add('c')
    ids.add('d') // 'a' goes
    expect(ids.add('b')).toBe(false)
    expect(ids.add('a')).toBe(true)
  })
})
