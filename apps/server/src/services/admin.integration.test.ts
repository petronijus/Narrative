/**
 * services/admin.integration.test.ts — instance admins (docs/adr/0014)
 * against a real Postgres:
 *   - an admin owns every folder and deck of other people — in the access
 *     resolvers, the folder list and the deck list — but never another
 *     person's Drafts; a plain user sees none of it;
 *   - demoting an admin takes all of it away at once (no rows were written);
 *   - the allowed list admits a verified address to sign in;
 *   - `ADMIN_EMAILS` makes an admin at sign-in, a verified email only;
 *   - two admins demoting each other at once leave one.
 * Excluded from `pnpm test`; run with `just integration`.
 *
 * It creates its own users, folders and decks under random ids and deletes
 * them afterwards.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TransactionRollbackError, eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'

const { db, pool } = await import('../db/client.js')
const { allowedEmails, decks, deckPermissions, folderPermissions, folders, sessions, users } =
  await import('../db/schema.js')
const { createAdminService } = await import('./admin.js')
const { createFoldersService } = await import('./folders.js')
const { createDecksService } = await import('./decks.js')
const { resolveDeckAccess, resolveFolderAccess } = await import('../auth/permissions.js')
const { allowedByDb, signInGrant } = await import('../auth/signInPolicy.js')
const { bootstrapAdmin } = await import('../auth/admin.js')
const { upsertUser } = await import('../auth/users.js')
const { quietLog } = await import('../test-support/agentWorld.js')

const suffix = nanoid(8)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, 'x')
const id = (name: string) => `it-admin-${name}-${suffix}`
const email = (sub: string) => `${sub}@example.test`

const boss = id('boss')
const second = id('second')
const alice = id('alice')
const plain = id('plain')
const everyone = [boss, second, alice, plain]

const aliceFolder = id('alice-folder')
const aliceDrafts = id('alice-drafts')
const aliceDeck = id('alice-deck')
const draftsDeck = id('drafts-deck')
const folderIds = [aliceFolder, aliceDrafts]
const deckIds = [aliceDeck, draftsDeck]

const deps = { db, log: quietLog, hocuspocus: () => null }
const allowlist = { allowedEmails: ['someone.else@example.test'] }
const admin = createAdminService(deps, { allowlist })
const folderService = createFoldersService(deps)
const deckService = createDecksService(deps)

beforeAll(async () => {
  await db.insert(users).values([
    { sub: boss, email: email(boss), name: 'Boss', emailVerified: true, isAdmin: true },
    { sub: second, email: email(second), name: 'Second', emailVerified: true, isAdmin: true },
    { sub: alice, email: email(alice), name: 'Alice', emailVerified: true },
    { sub: plain, email: email(plain), name: 'Plain', emailVerified: true },
  ])
  await db.insert(folders).values([
    { id: aliceFolder, ownerUserId: alice, name: 'Alice client' },
    { id: aliceDrafts, ownerUserId: alice, name: 'Drafts', isDrafts: true },
  ])
  await db.insert(folderPermissions).values([
    { folderId: aliceFolder, userId: alice, role: 'owner' },
    { folderId: aliceDrafts, userId: alice, role: 'owner' },
  ])
  await db.insert(decks).values([
    { id: aliceDeck, title: 'Pitch', ownerUserId: alice, folderId: aliceFolder },
    { id: draftsDeck, title: 'Secret draft', ownerUserId: alice, folderId: aliceDrafts },
  ])
  await db.insert(deckPermissions).values([
    { deckId: aliceDeck, userId: alice, role: 'owner', grantedBy: alice },
    { deckId: draftsDeck, userId: alice, role: 'owner', grantedBy: alice },
  ])
})

afterAll(async () => {
  await db.delete(decks).where(inArray(decks.id, deckIds))
  await db.delete(folders).where(inArray(folders.id, folderIds))
  await db.delete(allowedEmails).where(inArray(allowedEmails.addedBySub, everyone))
  await db.delete(users).where(inArray(users.sub, everyone))
  await pool.end()
})

describe('an admin in the access resolvers', () => {
  it("owns another person's folder and deck, but not their Drafts", async () => {
    expect(await resolveFolderAccess(db, { folderId: aliceFolder, userId: boss })).toEqual({
      role: 'owner',
      reason: 'admin',
    })
    expect(await resolveDeckAccess(db, { deckId: aliceDeck, userId: boss })).toEqual({
      role: 'owner',
      reason: 'admin',
    })
    expect(await resolveFolderAccess(db, { folderId: aliceDrafts, userId: boss })).toBeNull()
    expect(await resolveDeckAccess(db, { deckId: draftsDeck, userId: boss })).toBeNull()
  })

  it('gives a plain user nothing', async () => {
    expect(await resolveFolderAccess(db, { folderId: aliceFolder, userId: plain })).toBeNull()
    expect(await resolveDeckAccess(db, { deckId: aliceDeck, userId: plain })).toBeNull()
  })

  it('keeps Alice owner of her own Drafts and folder, as before', async () => {
    expect(await resolveFolderAccess(db, { folderId: aliceDrafts, userId: alice })).toEqual({
      role: 'owner',
      reason: 'direct',
    })
  })
})

describe('an admin in the lists', () => {
  const mine = (rows: { id: string }[]) =>
    rows.map((r) => r.id).filter((x) => folderIds.includes(x))

  it("lists every folder but other people's Drafts, as owner", async () => {
    const listed = await folderService.list({ userId: boss })
    expect(mine(listed)).toEqual([aliceFolder])
    expect(listed.find((f) => f.id === aliceFolder)).toMatchObject({
      role: 'owner',
      sharedBy: null,
    })
    const page = await folderService.listPage({ userId: boss, limit: 200 })
    expect(mine(page.folders)).toEqual([aliceFolder])
  })

  it("lists their decks as owner, and never a deck in other people's Drafts", async () => {
    const listed = await deckService.list({ userId: boss })
    const found = listed.filter((d) => deckIds.includes(d.id))
    expect(found.map((d) => d.id)).toEqual([aliceDeck])
    expect(found[0]).toMatchObject({ viewerRole: 'owner' })
    const page = await deckService.listPage({ userId: boss, limit: 200 })
    expect(page.decks.filter((d) => deckIds.includes(d.id))).toEqual([
      expect.objectContaining({ id: aliceDeck, role: 'owner' }),
    ])
  })

  it("lists a deck of someone else's Drafts shared with an admin by its own role", async () => {
    await db
      .insert(deckPermissions)
      .values({ deckId: draftsDeck, userId: boss, role: 'viewer', grantedBy: alice })
    try {
      const listed = (await deckService.list({ userId: boss })).find((d) => d.id === draftsDeck)
      expect(listed).toMatchObject({ viewerRole: 'viewer' })
    } finally {
      await db.delete(deckPermissions).where(eq(deckPermissions.userId, boss))
    }
  })

  it('shows a plain user none of it', async () => {
    expect(mine(await folderService.list({ userId: plain }))).toEqual([])
    expect(
      (await deckService.list({ userId: plain })).filter((d) => deckIds.includes(d.id)),
    ).toEqual([])
  })

  it('shows the owner their own folders as before', async () => {
    expect(mine(await folderService.list({ userId: alice })).sort()).toEqual(
      [aliceFolder, aliceDrafts].sort(),
    )
  })
})

describe('the admin role is a flag, not rows', () => {
  it('writes no folder_permissions for an admin, and demoting takes the access away', async () => {
    const rows = await db
      .select()
      .from(folderPermissions)
      .where(inArray(folderPermissions.userId, [boss, second]))
    expect(rows).toEqual([])
    await admin.setAdmin({ userId: boss, targetUserId: second, isAdmin: false })
    expect(await resolveFolderAccess(db, { folderId: aliceFolder, userId: second })).toBeNull()
    expect(
      (await folderService.list({ userId: second })).filter((f) => folderIds.includes(f.id)),
    ).toEqual([])
    await admin.setAdmin({ userId: boss, targetUserId: second, isAdmin: true })
  })

  it('serialises two admins demoting each other: one stays', async () => {
    const results = await Promise.allSettled([
      admin.setAdmin({ userId: boss, targetUserId: second, isAdmin: false }),
      admin.setAdmin({ userId: second, targetUserId: boss, isAdmin: false }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ status: 403 })
    const left = await db.select({ sub: users.sub }).from(users).where(eq(users.isAdmin, true))
    expect(left.map((u) => u.sub).filter((s) => [boss, second].includes(s))).toHaveLength(1)
  })
})

describe('who may sign in', () => {
  it('admits a verified address an admin allowed, and not an unverified one', async () => {
    const newcomer = email(id('newcomer'))
    const who = (await db.select().from(users).where(eq(users.isAdmin, true)).limit(1))[0]!
    expect(await allowedByDb(db, { email: newcomer, emailVerified: true })).toBeNull()
    await admin.allowEmail({ userId: who.sub, email: newcomer.toUpperCase() })
    expect(await allowedByDb(db, { email: newcomer, emailVerified: true })).toBe('allowlist')
    expect(await allowedByDb(db, { email: newcomer, emailVerified: false })).toBeNull()
    // Idempotent, and removable.
    await admin.allowEmail({ userId: who.sub, email: newcomer })
    await admin.removeAllowedEmail({ userId: who.sub, email: newcomer })
    expect(await allowedByDb(db, { email: newcomer, emailVerified: true })).toBeNull()
  })

  it('signs a person out when the removed address was the only thing letting them in', async () => {
    const sub = id('leaver')
    const addr = email(sub)
    const who = (await db.select().from(users).where(eq(users.isAdmin, true)).limit(1))[0]!
    try {
      await upsertUser(db, { sub, email: addr, emailVerified: true, name: 'Leaver' })
      await db.insert(sessions).values({
        idHash: `it-admin-session-${suffix}`,
        userSub: sub,
        userEmail: addr,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      await admin.allowEmail({ userId: who.sub, email: addr })
      await expect(admin.removeAllowedEmail({ userId: who.sub, email: addr })).resolves.toEqual({
        signedOut: true,
      })
      const [session] = await db.select().from(sessions).where(eq(sessions.userSub, sub))
      expect(session?.revokedAt).not.toBeNull()
    } finally {
      await db.delete(sessions).where(eq(sessions.userSub, sub))
      await db.delete(users).where(eq(users.sub, sub))
    }
  })

  it('keeps a person signed in whom something else still admits', async () => {
    const who = (await db.select().from(users).where(eq(users.isAdmin, true)).limit(1))[0]!
    // Plain also holds a grant on a deck Alice made: that still admits them.
    await db.insert(deckPermissions).values({ deckId: aliceDeck, userId: plain, role: 'viewer' })
    try {
      await admin.allowEmail({ userId: who.sub, email: email(plain) })
      await expect(
        admin.removeAllowedEmail({ userId: who.sub, email: email(plain) }),
      ).resolves.toEqual({ signedOut: false })
    } finally {
      await db.delete(deckPermissions).where(eq(deckPermissions.userId, plain))
    }
  })

  it('seeds an admin from ADMIN_EMAILS at sign-in only while there is none, verified only', async () => {
    const sub = id('founder')
    const addr = email(sub)
    await upsertUser(db, { sub, email: addr, emailVerified: true, name: 'Founder' })
    try {
      // Admins exist (this file's): ADMIN_EMAILS seeds nothing.
      expect(await bootstrapAdmin(db, { sub, email: addr, emailVerified: true }, [addr])).toBe(
        false,
      )
      // With no admin at all (inside a transaction rolled back afterwards).
      await db
        .transaction(async (tx) => {
          const t = tx as unknown as typeof db
          await t.update(users).set({ isAdmin: false }).where(eq(users.isAdmin, true))
          expect(await bootstrapAdmin(t, { sub, email: addr, emailVerified: false }, [addr])).toBe(
            false,
          )
          expect(await bootstrapAdmin(t, { sub, email: addr, emailVerified: true }, [addr])).toBe(
            true,
          )
          const [row] = await t.select({ a: users.isAdmin }).from(users).where(eq(users.sub, sub))
          expect(row?.a).toBe(true)
          tx.rollback()
        })
        .catch((e: unknown) => {
          if (!(e instanceof TransactionRollbackError)) throw e
        })
      // The env list also lets the address in.
      expect(
        await signInGrant(
          db,
          { allowedEmails: ['x@example.test'], adminEmails: [addr] },
          {
            email: addr,
            emailVerified: true,
          },
        ),
      ).toBe('admin')
    } finally {
      await db.delete(users).where(eq(users.sub, sub))
    }
  })
})
