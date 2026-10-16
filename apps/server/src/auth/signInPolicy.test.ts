/**
 * auth/signInPolicy.test.ts — the one allowlist rule shared by Google sign-in
 * and personal access token verification: env allowlist first (no database
 * work), then — for a verified email only — a pending deck or folder
 * invite, then a deck or a folder somebody else shared. The SQL of the last
 * two (a user's own decks and folders never count) is exercised against
 * Postgres in services/folderSharing.integration.test.ts.
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
    // Unverified → not the domain rule, and the database admits no
    // unverified email at all: not even asked.
    const db = scriptedDb()
    await expect(
      signInGrant(db.db, byDomain, { email: 'a@example.com', emailVerified: false }),
    ).resolves.toBeNull()
    expect(db.remaining().selects).toBe(0)
  })

  const bela = { email: 'bela@example.org', emailVerified: true }

  it('admits an address an admin allowed, before looking at invites', async () => {
    const db = scriptedDb({ selects: [[{ email: 'bela@example.org' }]] })
    await expect(signInGrant(db.db, byEmail, bela)).resolves.toBe('allowlist')
    expect(db.remaining().selects).toBe(0)
  })

  it('admits ADMIN_EMAILS with a verified email only, without the database', async () => {
    const admins = { allowedEmails: ['petr@example.com'], adminEmails: ['boss@example.org'] }
    const db = scriptedDb()
    await expect(
      signInGrant(db.db, admins, { email: 'Boss@Example.org', emailVerified: true }),
    ).resolves.toBe('admin')
    expect(db.remaining().selects).toBe(0)
    // Unverified: not admitted by the env, and the database admits no unverified email.
    await expect(
      signInGrant(scriptedDb().db, admins, { email: 'boss@example.org', emailVerified: false }),
    ).resolves.toBeNull()
  })

  it('admits a pending deck invite, then a pending folder invite', async () => {
    await expect(
      signInGrant(scriptedDb({ selects: [[], [{ id: 'inv' }]] }).db, byEmail, bela),
    ).resolves.toBe('invite')
    const db = scriptedDb({ selects: [[], [], [{ id: 'finv' }]] })
    await expect(signInGrant(db.db, byEmail, bela)).resolves.toBe('invite')
    expect(db.remaining().selects).toBe(0)
  })

  it('admits an existing deck permission, then a membership in a shared folder', async () => {
    await expect(
      signInGrant(scriptedDb({ selects: [[], [], [], [{ deckId: 'd1' }]] }).db, byEmail, bela),
    ).resolves.toBe('permission')
    const db = scriptedDb({ selects: [[], [], [], [], [{ folderId: 'f1' }]] })
    await expect(signInGrant(db.db, byEmail, bela)).resolves.toBe('permission')
    expect(db.remaining().selects).toBe(0)
  })

  it('admits no unverified email through the database', async () => {
    const db = scriptedDb({ selects: [[{ id: 'inv' }]] })
    await expect(
      signInGrant(db.db, byEmail, { email: 'bela@example.org', emailVerified: false }),
    ).resolves.toBeNull()
    expect(db.remaining().selects).toBe(1)
  })

  it('refuses everyone else', async () => {
    await expect(
      isAllowedToSignIn(scriptedDb({ selects: [[], [], [], [], []] }).db, byEmail, {
        email: 'removed@example.org',
        emailVerified: true,
      }),
    ).resolves.toBe(false)
  })
})
