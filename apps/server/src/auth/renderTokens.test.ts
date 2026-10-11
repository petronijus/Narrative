/**
 * auth/renderTokens.test.ts
 *
 * The render worker's tokens (auth/renderTokens.ts): minted per job, viewer
 * access to one deck while its requester can read it, expiring (connections
 * too), revocable — and resolved as a share link, so every share-link path
 * admits them and nothing else does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../hocuspocus/connections.js', () => ({
  closeShareTokenConnections: vi.fn(() => 0),
}))

/** Who can read which deck, as a signed-in user ("deck → users"). */
const readers = new Map<string, Set<string>>()

vi.mock('./permissions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./permissions.js')>()
  return {
    ...original,
    // A user's own access comes from `readers`; a share token takes the real
    // path (findShareLink, which re-checks the render token's requester
    // through this same function).
    resolveDeckAccess: vi.fn(
      async (
        db: Parameters<typeof original.resolveDeckAccess>[0],
        args: Parameters<typeof original.resolveDeckAccess>[1],
      ) => {
        if (args.userId !== null) {
          return readers.get(args.deckId)?.has(args.userId)
            ? ({ role: 'editor', reason: 'direct' } as const)
            : null
        }
        return original.resolveDeckAccess(db, args)
      },
    ),
  }
})

import {
  RENDER_TOKEN_TTL_MS,
  clearRenderTokensForTests,
  isRenderToken,
  mintRenderToken,
  resolveRenderToken,
  revokeRenderToken,
  extendRenderToken,
} from './renderTokens.js'
import { findShareLink } from './shareLinks.js'
import { resolveDeckAccess } from './permissions.js'
import { looksLikeNarrativeCredential, maskCredentials } from './credentialPatterns.js'
import { closeShareTokenConnections } from '../hocuspocus/connections.js'
import type { Database } from '../db/client.js'

/** A render token's checks never query the database directly; any query is a bug. */
const noDb = new Proxy({} as Database, {
  get() {
    throw new Error('a render token must not touch the database')
  },
})

beforeEach(() => {
  clearRenderTokensForTests()
  readers.clear()
  readers.set('deck-a', new Set(['alice']))
  vi.mocked(closeShareTokenConnections).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('render tokens', () => {
  it('mints a 256-bit nrr_ token that resolves to its deck and requester', () => {
    const token = mintRenderToken('deck-a', 'alice')
    expect(token).toMatch(/^nrr_[A-Za-z0-9_-]{43}$/)
    expect(isRenderToken(token)).toBe(true)
    expect(resolveRenderToken(token)).toEqual({ deckId: 'deck-a', requestedBy: 'alice' })
  })

  it('mints a different token every time', () => {
    expect(mintRenderToken('deck-a', 'alice')).not.toBe(mintRenderToken('deck-a', 'alice'))
  })

  it('knows a token by its full shape, so a share link id starting with nrr_ stays a share link', () => {
    expect(isRenderToken(`nrr_${'a'.repeat(43)}`)).toBe(true)
    expect(isRenderToken('nrr_V1StGXR8_Z5jdHi6B')).toBe(false)
  })

  it('expires after the TTL and closes the page connections then', () => {
    vi.useFakeTimers()
    const now = Date.now()
    const token = mintRenderToken('deck-a', 'alice', now)
    expect(resolveRenderToken(token, now + RENDER_TOKEN_TTL_MS - 1)).not.toBeNull()
    expect(resolveRenderToken(token, now + RENDER_TOKEN_TTL_MS)).toBeNull()

    const live = mintRenderToken('deck-a', 'alice')
    vi.advanceTimersByTime(RENDER_TOKEN_TTL_MS)
    expect(closeShareTokenConnections).toHaveBeenCalledWith(live)
    expect(resolveRenderToken(live)).toBeNull()
  })

  it("lives as long as its job asks (the job's deadline plus a margin)", () => {
    const now = 2_000_000
    const token = mintRenderToken('deck-a', 'alice', now, 90_000)
    expect(resolveRenderToken(token, now + 89_999)).not.toBeNull()
    expect(resolveRenderToken(token, now + 90_000)).toBeNull()
  })

  it('goes on while its render session is extended, and ends when that stops', () => {
    vi.useFakeTimers()
    const token = mintRenderToken('deck-a', 'alice', Date.now(), 1_000)
    vi.advanceTimersByTime(900)
    expect(extendRenderToken(token, 1_000)).toBe(true)
    vi.advanceTimersByTime(900)
    // Past the first expiry, still live: the timer moved with it.
    expect(resolveRenderToken(token)).not.toBeNull()
    expect(closeShareTokenConnections).not.toHaveBeenCalledWith(token)
    vi.advanceTimersByTime(100)
    expect(resolveRenderToken(token)).toBeNull()
    expect(closeShareTokenConnections).toHaveBeenCalledWith(token)
    // An ended token is not brought back.
    expect(extendRenderToken(token, 1_000)).toBe(false)
  })

  it('stops working when revoked, and closes the page connections', () => {
    const token = mintRenderToken('deck-a', 'alice')
    revokeRenderToken(token)
    expect(resolveRenderToken(token)).toBeNull()
    expect(closeShareTokenConnections).toHaveBeenCalledWith(token)
  })

  it('refuses anything it did not mint, well-formed or not', () => {
    expect(resolveRenderToken(`nrr_${'a'.repeat(43)}`)).toBeNull()
    expect(resolveRenderToken('nrr_short')).toBeNull()
    expect(resolveRenderToken('')).toBeNull()
  })

  it('is a credential: masked in logs and audit', () => {
    const token = mintRenderToken('deck-a', 'alice')
    expect(looksLikeNarrativeCredential(token)).toBe(true)
    expect(maskCredentials(`GET /deck/deck-a/render?share_token=${token}`, '***')).toBe(
      'GET /deck/deck-a/render?share_token=nrr_***',
    )
  })
})

describe('a render token as a share link', () => {
  it('resolves to viewer access to its deck', async () => {
    const token = mintRenderToken('deck-a', 'alice')
    await expect(findShareLink(noDb, token)).resolves.toEqual({ deckId: 'deck-a', role: 'viewer' })
  })

  it('opens its own deck read-only and no other deck', async () => {
    readers.set('deck-b', new Set(['alice']))
    const token = mintRenderToken('deck-a', 'alice')
    await expect(
      resolveDeckAccess(noDb, { deckId: 'deck-a', userId: null, shareToken: token }),
    ).resolves.toEqual({ role: 'viewer', reason: 'share-link' })
    await expect(
      resolveDeckAccess(noDb, { deckId: 'deck-b', userId: null, shareToken: token }),
    ).resolves.toBeNull()
  })

  it('stops reading the deck the moment its requester cannot (lost access, deleted deck)', async () => {
    const token = mintRenderToken('deck-a', 'alice')
    readers.get('deck-a')!.delete('alice')
    await expect(findShareLink(noDb, token)).resolves.toBeNull()
    await expect(
      resolveDeckAccess(noDb, { deckId: 'deck-a', userId: null, shareToken: token }),
    ).resolves.toBeNull()
  })

  it('opens nothing once revoked', async () => {
    const token = mintRenderToken('deck-a', 'alice')
    revokeRenderToken(token)
    await expect(findShareLink(noDb, token)).resolves.toBeNull()
  })
})
