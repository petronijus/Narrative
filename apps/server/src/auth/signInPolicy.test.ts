/**
 * auth/signInPolicy.test.ts — the one allowlist rule shared by Google sign-in
 * and personal access token verification: env allowlist first (no database
 * work), then a pending invite, then an existing deck permission.
 */

import { describe, it, expect } from 'vitest'
import { signInGrant, isAllowedToSignIn } from './signInPolicy.js'
import { scriptedDb } from '../test-support/scriptedDb.js'

const byEmail = { allowedEmails: ['petr@example.com'], allowedDomain: undefined }
const byDomain = { allowedEmails: [], allowedDomain: 'example.com' }

describe('signInGrant', () => {
  it('admits an env-allowlisted email without touching the database', async () => {
    const db = scriptedDb()
    await expect(
      signInGrant(db.db, byEmail, { email: 'Petr@Example.com', emailVerified: false }),
    ).resolves.toBe('env')
    expect(db.remaining().selects).toBe(0)
  })

  it('admits the allowed domain only with a verified email', async () => {
    await expect(
      signInGrant(scriptedDb().db, byDomain, { email: 'a@example.com', emailVerified: true }),
    ).resolves.toBe('env')
    // Unverified → falls through to the database, which has nothing.
    const db = scriptedDb({ selects: [[], []] })
    await expect(
      signInGrant(db.db, byDomain, { email: 'a@example.com', emailVerified: false }),
    ).resolves.toBeNull()
    expect(db.remaining().selects).toBe(0)
  })

  it('admits a pending invite, then an existing deck permission', async () => {
    await expect(
      signInGrant(scriptedDb({ selects: [[{ id: 'inv' }]] }).db, byEmail, {
        email: 'bela@example.org',
        emailVerified: true,
      }),
    ).resolves.toBe('invite')
    await expect(
      signInGrant(scriptedDb({ selects: [[], [{ deckId: 'd1' }]] }).db, byEmail, {
        email: 'bela@example.org',
        emailVerified: true,
      }),
    ).resolves.toBe('permission')
  })

  it('refuses everyone else', async () => {
    await expect(
      isAllowedToSignIn(scriptedDb({ selects: [[], []] }).db, byEmail, {
        email: 'removed@example.org',
        emailVerified: true,
      }),
    ).resolves.toBe(false)
  })
})
