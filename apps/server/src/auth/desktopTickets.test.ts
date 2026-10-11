/**
 * auth/desktopTickets.test.ts
 *
 * The desktop sign-in tickets (auth/desktopTickets.ts, ADR 0014): one
 * redeem, 60 s, only with the PKCE verifier of the challenge they were
 * minted for, and bounded in number.
 */

import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { s256 } from './pkce.js'
import {
  DESKTOP_TICKET_CAP,
  DESKTOP_TICKET_TTL_MS,
  clearDesktopTicketsForTests,
  desktopTicketCountForTests,
  isDesktopTicket,
  mintDesktopTicket,
  redeemDesktopTicket,
  type DesktopTicketGrant,
} from './desktopTickets.js'

const grant: DesktopTicketGrant = {
  user: { sub: 'google-sub-1', email: 'petr@example.com', name: 'Petr' },
  returnTo: '/deck/abc',
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: s256(verifier) }
}

afterEach(() => {
  clearDesktopTicketsForTests()
  vi.useRealTimers()
})

describe('desktop sign-in tickets', () => {
  it('mints an ndt_ ticket with 256 bits of randomness', () => {
    const { challenge } = pkcePair()
    const a = mintDesktopTicket(grant, challenge)
    const b = mintDesktopTicket(grant, challenge)
    expect(isDesktopTicket(a)).toBe(true)
    expect(a).toMatch(/^ndt_[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })

  it('redeems once with the matching verifier', () => {
    const { verifier, challenge } = pkcePair()
    const ticket = mintDesktopTicket(grant, challenge)
    expect(redeemDesktopTicket(ticket, verifier)).toEqual(grant)
    expect(redeemDesktopTicket(ticket, verifier)).toBeNull()
  })

  it('burns the ticket on a wrong verifier, so a second try with the right one fails too', () => {
    const { verifier, challenge } = pkcePair()
    const ticket = mintDesktopTicket(grant, challenge)
    expect(redeemDesktopTicket(ticket, pkcePair().verifier)).toBeNull()
    expect(redeemDesktopTicket(ticket, verifier)).toBeNull()
    expect(desktopTicketCountForTests()).toBe(0)
  })

  it('refuses an expired ticket', () => {
    const { verifier, challenge } = pkcePair()
    const ticket = mintDesktopTicket(grant, challenge, 1_000)
    expect(redeemDesktopTicket(ticket, verifier, 1_000 + DESKTOP_TICKET_TTL_MS)).toBeNull()
  })

  it('forgets a ticket when its time is up, without a redeem', () => {
    vi.useFakeTimers()
    const { challenge } = pkcePair()
    mintDesktopTicket(grant, challenge)
    expect(desktopTicketCountForTests()).toBe(1)
    vi.advanceTimersByTime(DESKTOP_TICKET_TTL_MS)
    expect(desktopTicketCountForTests()).toBe(0)
  })

  it('refuses malformed tickets and verifiers without touching a held ticket', () => {
    const { verifier, challenge } = pkcePair()
    const ticket = mintDesktopTicket(grant, challenge)
    expect(redeemDesktopTicket(undefined, verifier)).toBeNull()
    expect(redeemDesktopTicket(`${ticket}x`, verifier)).toBeNull()
    expect(redeemDesktopTicket(ticket.replace('ndt_', 'nrr_'), verifier)).toBeNull()
    expect(redeemDesktopTicket(ticket, 'short')).toBeNull()
    expect(redeemDesktopTicket(ticket, 42)).toBeNull()
    expect(redeemDesktopTicket(ticket, verifier)).toEqual(grant)
  })

  it('refuses to mint for a malformed challenge', () => {
    expect(() => mintDesktopTicket(grant, 'not-a-challenge')).toThrow(/PKCE challenge/)
  })

  it('drops the oldest ticket beyond the cap', () => {
    const first = pkcePair()
    const oldest = mintDesktopTicket(grant, first.challenge)
    const { challenge } = pkcePair()
    for (let i = 1; i < DESKTOP_TICKET_CAP; i++) mintDesktopTicket(grant, challenge)
    expect(desktopTicketCountForTests()).toBe(DESKTOP_TICKET_CAP)
    mintDesktopTicket(grant, challenge)
    expect(desktopTicketCountForTests()).toBe(DESKTOP_TICKET_CAP)
    expect(redeemDesktopTicket(oldest, first.verifier)).toBeNull()
  })
})
