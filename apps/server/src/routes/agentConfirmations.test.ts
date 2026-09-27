/**
 * routes/agentConfirmations.test.ts — the confirmation page's API: only the
 * signed-in browser of the user the confirmation belongs to can see or
 * decide it; tokens and foreign origins are refused. Sessions are mocked at
 * `lookupSession` (cookie `narrative_session=s-<user>` is <user>).
 */

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

import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import { createPatService, type PatService } from '../auth/personalAccessTokens.js'
import type { Database } from '../db/client.js'
import { registerSameOriginPolicy } from '../http/sameOrigin.js'
import { allowAllPatOwners, createMemoryPatStore } from '../test-support/memoryPatStore.js'
import {
  AgentConfirmations,
  confirmationInputHash,
  type ConfirmationRecord,
} from '../agent/confirmations.js'
import { registerAgentConfirmationRoutes } from './agentConfirmations.js'

const SPA = 'http://localhost:5173'
let app: FastifyInstance
let confirmations: AgentConfirmations
let pats: PatService
let record: ConfirmationRecord

beforeEach(async () => {
  confirmations = new AgentConfirmations()
  pats = createPatService(createMemoryPatStore(), { isOwnerAllowed: allowAllPatOwners })
  app = Fastify({ logger: false })
  registerAuthPlugin(app, { bypass: false, db: {} as Database, pats })
  registerSameOriginPolicy(app, { allowedOrigins: [SPA] })
  await registerAgentConfirmationRoutes(app, { confirmations: () => confirmations })
  await app.ready()
  record = confirmations.create(
    {
      userId: 'user-1',
      sessionKey: 'mcp:s1',
      commandId: 'share.links.create',
      inputHash: confirmationInputHash({ role: 'viewer' }),
      target: { deckId: 'd1' },
    },
    {
      commandId: 'share.links.create',
      title: 'Create a share link',
      action: 'Create a link.',
      target: { kind: 'deck', label: 'Q3 review' },
      details: [{ label: 'Role', value: 'viewer' }],
      reasons: ['irreversible'],
      hosts: [],
      clientName: 'claude-code',
    },
  )
})

afterEach(async () => {
  await app.close()
})

const as = (user: string) => ({ cookie: `narrative_session=s-${user}` })
const decide = (headers: Record<string, string>, decision: unknown = 'approve') =>
  app.inject({
    method: 'POST',
    url: `/agent-confirmations/${record.id}/decision`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify({ decision }),
  })

describe('GET /agent-confirmations/:id', () => {
  it('shows the summary to its own user only', async () => {
    const mine = await app.inject({
      url: `/agent-confirmations/${record.id}`,
      headers: as('user-1'),
    })
    expect(mine.statusCode).toBe(200)
    expect(mine.json()).toMatchObject({
      status: 'pending',
      summary: { title: 'Create a share link', target: { label: 'Q3 review' } },
    })
    expect(JSON.stringify(mine.json())).not.toContain('mcp:s1')
    const theirs = await app.inject({
      url: `/agent-confirmations/${record.id}`,
      headers: as('user-2'),
    })
    expect(theirs.statusCode).toBe(404)
    const anon = await app.inject({ url: `/agent-confirmations/${record.id}` })
    expect(anon.statusCode).toBe(401)
  })

  it('refuses a personal access token (an agent cannot look up its own request)', async () => {
    const { token } = await pats.create('user-1', {
      name: 't',
      scopes: ['mcp', 'api'],
      expiresInDays: 30,
    })
    const res = await app.inject({
      url: `/agent-confirmations/${record.id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('POST /agent-confirmations/:id/decision', () => {
  it('approves from Narrative’s origin with the user’s session', async () => {
    const res = await decide({ ...as('user-1'), origin: SPA })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'approved' })
    const again = await decide({ ...as('user-1'), origin: SPA }, 'decline')
    expect(again.statusCode).toBe(409)
  })

  it('refuses a foreign or missing origin (CSRF)', async () => {
    expect((await decide({ ...as('user-1'), origin: 'https://evil.example' })).statusCode).toBe(403)
    expect((await decide(as('user-1'))).statusCode).toBe(403)
    expect(confirmations.viewForUser(record.id, 'user-1')!.status).toBe('pending')
  })

  it('refuses another user, a token and a non-JSON body', async () => {
    expect((await decide({ ...as('user-2'), origin: SPA })).statusCode).toBe(404)
    const { token } = await pats.create('user-1', {
      name: 't',
      scopes: ['mcp', 'api'],
      expiresInDays: 30,
    })
    expect((await decide({ authorization: `Bearer ${token}`, origin: SPA })).statusCode).toBe(403)
    const form = await app.inject({
      method: 'POST',
      url: `/agent-confirmations/${record.id}/decision`,
      headers: { ...as('user-1'), origin: SPA, 'content-type': 'text/plain' },
      payload: 'decision=approve',
    })
    expect(form.statusCode).toBeGreaterThanOrEqual(400)
    expect((await decide({ ...as('user-1'), origin: SPA }, 'yes')).statusCode).toBe(400)
    expect(confirmations.viewForUser(record.id, 'user-1')!.status).toBe('pending')
  })
})
