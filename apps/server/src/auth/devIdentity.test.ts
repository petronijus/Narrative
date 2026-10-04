/**
 * auth/devIdentity.test.ts — BYPASS_AUTH's synthetic identities: the
 * `narrative_dev_as` cookie switches a request to another one only with the
 * `dev-` prefix, every bypass-mode request resolves to that identity, a
 * switched identity gets its directory row once, and without bypass the
 * cookie means nothing.
 */

import { describe, expect, it } from 'vitest'
import { DEV_USER_SUB, devSubFromCookieHeader, devUserClaims } from './devIdentity.js'
import { resolveIdentityFromHeaders } from './identity.js'
import { scriptedDb } from '../test-support/scriptedDb.js'
import type { PatService } from './personalAccessTokens.js'

const noPats = { verify: async () => null } as unknown as PatService

describe('devSubFromCookieHeader', () => {
  it('names a dev- identity from the cookie, else dev-user', () => {
    expect(devSubFromCookieHeader(undefined)).toBe(DEV_USER_SUB)
    expect(devSubFromCookieHeader('narrative_dev_as=dev-viewer-42')).toBe('dev-viewer-42')
    expect(devSubFromCookieHeader(['a=1', 'narrative_dev_as=dev-owner'])).toBe('dev-owner')
    // Never a real Google sub, nothing outside the pattern.
    expect(devSubFromCookieHeader('narrative_dev_as=106635599393307737914')).toBe(DEV_USER_SUB)
    expect(devSubFromCookieHeader('narrative_dev_as=dev-UPPER')).toBe(DEV_USER_SUB)
    expect(devSubFromCookieHeader(`narrative_dev_as=dev-${'x'.repeat(61)}`)).toBe(DEV_USER_SUB)
  })

  it('gives a switched identity an address of its own', () => {
    expect(devUserClaims(DEV_USER_SUB)).toEqual({
      sub: 'dev-user',
      email: 'dev-user@dev.narrative.test',
      name: 'Dev User',
    })
    expect(devUserClaims('dev-viewer')).toEqual({
      sub: 'dev-viewer',
      email: 'dev-viewer@dev.narrative.test',
      name: 'dev-viewer',
    })
  })
})

describe('resolveIdentityFromHeaders under BYPASS_AUTH', () => {
  it('is dev-user without the cookie (its directory row is written at boot, not here)', async () => {
    const db = scriptedDb()
    const result = await resolveIdentityFromHeaders({}, { db: db.db, bypass: true, pats: noPats })
    expect(result).toMatchObject({
      status: 'ok',
      identity: { user: { sub: 'dev-user', email: 'dev-user@dev.narrative.test' } },
    })
    expect(db.writes).toEqual([])
  })

  it('is the identity the cookie names, with its users row written once', async () => {
    const sub = `dev-once-${Date.now().toString(36)}`
    const db = scriptedDb()
    const deps = { db: db.db, bypass: true, pats: noPats }
    const headers = { cookie: `narrative_dev_as=${sub}` }
    const first = await resolveIdentityFromHeaders(headers, deps)
    expect(first).toMatchObject({
      status: 'ok',
      identity: { user: { sub, email: `${sub}@dev.narrative.test` }, auth: { bypass: true } },
    })
    await resolveIdentityFromHeaders(headers, deps)
    expect(db.writes.map((w) => w.table)).toEqual(['users'])
  })

  it('ignores the cookie without bypass', async () => {
    const db = scriptedDb()
    const result = await resolveIdentityFromHeaders(
      { cookie: 'narrative_dev_as=dev-viewer' },
      { db: db.db, bypass: false, pats: noPats },
    )
    expect(result).toEqual({ status: 'none' })
  })
})
