/**
 * http/bearerCache.test.ts — the in-memory bearer cache behind the
 * token-keyed pre-limit: which values count as agent bearers, the negative
 * cache (TTL, LRU bound), and the sliding "seen" set.
 */

import { describe, expect, it, vi } from 'vitest'
import { resolvePatIdentity } from '../auth/identity.js'
import type { PatService } from '../auth/personalAccessTokens.js'
import {
  agentBearer,
  bearerFromHeader,
  BearerCache,
  hashBearer,
  NEGATIVE_TTL_MS,
  SEEN_TTL_MS,
} from './bearerCache.js'

const nmo = (c: string) => `nmo_${c.repeat(43)}`
const nrt = (c: string) => `nrt_${c.repeat(43)}`

function clock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('agentBearer', () => {
  it('accepts exactly the minted shapes of MCP OAuth access tokens and PATs', () => {
    expect(agentBearer(nmo('a'))).toMatchObject({ kind: 'mcp-oauth', hash: hashBearer(nmo('a')) })
    expect(agentBearer(nrt('b'))).toMatchObject({ kind: 'personal-access-token' })
    for (const value of [
      null,
      undefined,
      '',
      `nmo_${'a'.repeat(42)}`,
      `nrt_${'a'.repeat(44)}`,
      `nmr_${'a'.repeat(43)}`, // an OAuth refresh token is never a bearer on /mcp
      `nmo_${'a'.repeat(42)}!`,
      'metrics-token',
    ]) {
      expect(agentBearer(value), String(value)).toBeNull()
    }
  })

  it('reads the value of a Bearer authorization header', () => {
    expect(bearerFromHeader(`Bearer ${nmo('a')}`)).toBe(nmo('a'))
    expect(bearerFromHeader(`bearer\t${nmo('a')} `)).toBe(nmo('a'))
    expect(bearerFromHeader([`Bearer ${nrt('c')}`])).toBe(nrt('c'))
    expect(bearerFromHeader('Basic abc')).toBeNull()
    expect(bearerFromHeader(undefined)).toBeNull()
  })
})

describe('BearerCache', () => {
  it('remembers a failed verification for the negative TTL only', () => {
    const c = clock()
    const cache = new BearerCache({ now: c.now })
    cache.recordInvalid(nrt('x'))
    expect(cache.isKnownInvalid(nrt('x'))).toBe(true)
    expect(cache.isKnownInvalidHash(hashBearer(nrt('x')))).toBe(true)
    expect(cache.isKnownInvalid(nrt('y'))).toBe(false)
    c.advance(NEGATIVE_TTL_MS - 1)
    expect(cache.isKnownInvalid(nrt('x'))).toBe(true)
    c.advance(1)
    expect(cache.isKnownInvalid(nrt('x'))).toBe(false)
  })

  it('bounds the negative cache, evicting the least recently recorded entry', () => {
    const cache = new BearerCache({ negativeMaxEntries: 2 })
    cache.recordInvalid(nrt('a'))
    cache.recordInvalid(nrt('b'))
    cache.recordInvalid(nrt('a')) // refreshed: now the youngest
    cache.recordInvalid(nrt('c'))
    expect(cache.isKnownInvalid(nrt('b'))).toBe(false)
    expect(cache.isKnownInvalid(nrt('a'))).toBe(true)
    expect(cache.isKnownInvalid(nrt('c'))).toBe(true)
    expect(cache.sizes().invalid).toBe(2)
  })

  it('keeps "seen" sliding on success and forgets it on failure', () => {
    const c = clock()
    const cache = new BearerCache({ now: c.now })
    const hash = hashBearer(nmo('s'))
    expect(cache.hasSeenHash(hash)).toBe(false)
    cache.markSeenHash(hash)
    c.advance(SEEN_TTL_MS - 1000)
    cache.recordValid(nmo('s')) // a successful verification refreshes the entry
    c.advance(SEEN_TTL_MS - 1000)
    expect(cache.hasSeenHash(hash)).toBe(true)
    c.advance(1000)
    expect(cache.hasSeenHash(hash)).toBe(false)

    cache.markSeenHash(hash)
    cache.recordInvalid(nmo('s'))
    expect(cache.hasSeenHash(hash)).toBe(false)
    // A later success clears the negative entry.
    cache.recordValid(nmo('s'))
    expect(cache.isKnownInvalid(nmo('s'))).toBe(false)
  })

  it('bounds the seen set', () => {
    const cache = new BearerCache({ seenMaxEntries: 1 })
    cache.markSeenHash('a')
    cache.markSeenHash('b')
    expect(cache.hasSeenHash('a')).toBe(false)
    expect(cache.hasSeenHash('b')).toBe(true)
  })
})

describe('resolvePatIdentity with a bearer cache', () => {
  const service = (verify: PatService['verify']) =>
    ({ verify: vi.fn(verify) }) as unknown as PatService & {
      verify: ReturnType<typeof vi.fn>
    }

  it('short-circuits a token that failed, without calling verify', async () => {
    const cache = new BearerCache()
    const pats = service(async () => null)
    expect(await resolvePatIdentity(nrt('q'), pats, cache)).toEqual({
      status: 'invalid',
      presented: 'token',
    })
    expect(await resolvePatIdentity(nrt('q'), pats, cache)).toEqual({
      status: 'invalid',
      presented: 'token',
    })
    expect(pats.verify).toHaveBeenCalledTimes(1)
  })

  it('records nothing when verification throws, and a success as seen', async () => {
    const cache = new BearerCache()
    const down = service(async () => {
      throw new Error('database down')
    })
    await expect(resolvePatIdentity(nrt('d'), down, cache)).rejects.toThrow('database down')
    expect(cache.isKnownInvalid(nrt('d'))).toBe(false)

    const ok = service(async () => ({
      tokenId: 't1',
      userSub: 'u1',
      email: null,
      name: null,
      scopes: ['mcp'],
    }))
    const result = await resolvePatIdentity(nrt('d'), ok, cache)
    expect(result.status).toBe('ok')
    expect(cache.hasSeenHash(hashBearer(nrt('d')))).toBe(true)
  })
})
