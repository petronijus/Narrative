// @vitest-environment node
/**
 * pages/accessTokenList.test.ts — a late answer to the Access tokens page's
 * list neither drops a token created meanwhile nor revives one revoked
 * meanwhile (found 2026-10-02: under a parallel e2e run the list arrived
 * after "Create token", the new token vanished from the page, and the spec
 * checked the token "revoked" while it was still live).
 */

import { describe, expect, it } from 'vitest'
import type { AccessTokenSummary } from '../api/client.js'
import { mergeLoadedTokens } from './accessTokenList.js'

const token = (id: string): AccessTokenSummary => ({
  id,
  name: id,
  prefix: `nrt_${id}`,
  scopes: ['mcp'],
  createdAt: '2026-10-02T10:00:00.000Z',
  lastUsedAt: null,
  expiresAt: '2026-11-01T10:00:00.000Z',
  expired: false,
})

describe('mergeLoadedTokens', () => {
  it('takes the server list as it is when nothing happened meanwhile', () => {
    expect(mergeLoadedTokens([token('a'), token('b')], [], new Set())).toEqual([
      token('a'),
      token('b'),
    ])
  })

  it('keeps a token created before the list arrived, first', () => {
    expect(mergeLoadedTokens([token('a')], [token('new')], new Set()).map((t) => t.id)).toEqual([
      'new',
      'a',
    ])
  })

  it('does not duplicate a created token the server already lists', () => {
    expect(
      mergeLoadedTokens([token('new'), token('a')], [token('new')], new Set()).map((t) => t.id),
    ).toEqual(['new', 'a'])
  })

  it('takes nothing but its own creations over the server (no stale rows)', () => {
    // A row the server no longer lists is gone, unless this page created it.
    expect(mergeLoadedTokens([token('a')], [], new Set()).map((t) => t.id)).toEqual(['a'])
  })

  it('leaves out a token revoked before the list arrived', () => {
    expect(
      mergeLoadedTokens([token('a'), token('b')], [], new Set(['a'])).map((t) => t.id),
    ).toEqual(['b'])
  })
})
