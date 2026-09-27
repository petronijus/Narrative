import { describe, expect, it } from 'vitest'
import {
  AgentConfirmations,
  canonicalJson,
  confirmationInputHash,
  confirmationPageUrl,
  type ConfirmationBinding,
  type ConfirmationSummary,
} from './confirmations.js'

const summary: ConfirmationSummary = {
  commandId: 'share.links.create',
  title: 'Create a share link',
  action: 'Create a link.',
  target: { kind: 'deck', label: 'Q3' },
  details: [{ label: 'Role', value: 'viewer' }],
  reasons: ['irreversible'],
  hosts: [],
  clientName: 'claude-code 2',
}

const binding: ConfirmationBinding = {
  userId: 'u1',
  sessionKey: 'mcp:s1',
  commandId: 'share.links.create',
  inputHash: confirmationInputHash({ role: 'viewer' }),
  target: { deckId: 'd1' },
}

function clock() {
  let t = 1_000_000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('canonical input hash', () => {
  it('ignores key order, nothing else', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}',
    )
    expect(confirmationInputHash({ a: 1, b: 2 })).toBe(confirmationInputHash({ b: 2, a: 1 }))
    expect(confirmationInputHash({ a: 1 })).not.toBe(confirmationInputHash({ a: '1' }))
    expect(confirmationInputHash({ a: [1, 2] })).not.toBe(confirmationInputHash({ a: [2, 1] }))
  })
})

describe('AgentConfirmations', () => {
  it('is used once, only when approved, only for the exact binding', () => {
    const c = new AgentConfirmations()
    const r = c.create(binding, summary)
    expect(r.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(c.consume(r.id, binding)).toMatchObject({ ok: false, state: 'pending' })
    expect(c.decide(r.id, 'u1', true)).toMatchObject({ ok: true })
    for (const other of [
      { ...binding, userId: 'u2' },
      { ...binding, sessionKey: 'mcp:s2' },
      { ...binding, commandId: 'share.links.revoke' },
      { ...binding, inputHash: confirmationInputHash({ role: 'editor' }) },
      { ...binding, target: { deckId: 'd2' } },
    ])
      expect(c.consume(r.id, other).ok, JSON.stringify(other)).toBe(false)
    expect(c.consume(r.id, binding)).toMatchObject({ ok: true })
    expect(c.consume(r.id, binding)).toMatchObject({ ok: false, why: 'used' })
  })

  it('shows and decides only for its own user, once, before expiry', () => {
    const t = clock()
    const c = new AgentConfirmations({ now: t.now })
    const r = c.create(binding, summary)
    expect(c.viewForUser(r.id, 'u2')).toBeNull()
    expect(c.decide(r.id, 'u2', true)).toEqual({ ok: false, reason: 'not_found' })
    expect(c.viewForUser(r.id, 'u1')).toMatchObject({ status: 'pending', summary })
    t.advance(5 * 60_000)
    expect(c.viewForUser(r.id, 'u1')!.status).toBe('expired')
    expect(c.decide(r.id, 'u1', true)).toMatchObject({ ok: false, reason: 'expired' })
    const r2 = c.create(binding, summary)
    expect(c.decide(r2.id, 'u1', false)).toMatchObject({ ok: true })
    expect(c.decide(r2.id, 'u1', true)).toMatchObject({ ok: false, reason: 'already_decided' })
    expect(c.consume(r2.id, binding)).toMatchObject({ ok: false, state: 'declined' })
  })

  it('keeps at most N undecided per user, dropping the oldest', () => {
    const c = new AgentConfirmations({ maxPendingPerUser: 2 })
    const a = c.create(binding, summary)
    const b = c.create(binding, summary)
    const d = c.create(binding, summary)
    expect(c.viewForUser(a.id, 'u1')).toBeNull()
    expect(c.viewForUser(b.id, 'u1')).not.toBeNull()
    expect(c.viewForUser(d.id, 'u1')).not.toBeNull()
  })

  it('wakes a waiter on the decision, on expiry and on abort', async () => {
    const t = clock()
    const c = new AgentConfirmations({ now: t.now, ttlMs: 50 })
    const r = c.create(binding, summary)
    const waiting = c.waitForDecision(r.id)
    c.decide(r.id, 'u1', true)
    await expect(waiting).resolves.toBe('approved')

    const r2 = c.create(binding, summary)
    const controller = new AbortController()
    const aborted = c.waitForDecision(r2.id, controller.signal)
    controller.abort()
    await expect(aborted).resolves.toBe('aborted')

    const r3 = c.create(binding, summary)
    await expect(c.waitForDecision(r3.id)).resolves.toBe('expired')
  })

  it('forgets a session', () => {
    const c = new AgentConfirmations()
    const r = c.create(binding, summary)
    c.forgetSession('mcp:s1')
    expect(c.viewForUser(r.id, 'u1')).toBeNull()
  })

  it('links to the web page', () => {
    expect(confirmationPageUrl('https://n.example/', 'abc')).toBe('https://n.example/confirm/abc')
  })
})
