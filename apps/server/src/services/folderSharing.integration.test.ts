/**
 * services/folderSharing.integration.test.ts — folder sharing, step 3
 * (docs/plans/folder-sharing.md) against a real Postgres:
 *   - the folder's owner lists, invites, re-roles and removes members and
 *     pending invites; a known address becomes a member at once, an unknown
 *     one gets a pending invite and an email — sent again only for a new
 *     role, not on every repeat;
 *   - the sign-in policy admits a pending invite and what somebody else
 *     shared — never the user's own decks or folders, never an unverified
 *     email — and the first verified sign-in turns the invite into a
 *     membership;
 *   - the Drafts folder (marked, whatever its name) is never shared;
 *   - nobody changes or removes their own membership; a removed member loses
 *     the owner rows of the decks they created there (a grant someone else
 *     gave them stays); a demoted owner's pending invites are withdrawn;
 *     two owners removing each other at once leave the folder an owner;
 *     two first invites to one address at once make one invite.
 * Excluded from `pnpm test`; run with `just integration`.
 *
 * It creates its own users, folders and decks under random ids and deletes
 * them afterwards. The email client is mocked: nothing is sent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'

const sendEmail = vi.fn(async () => 'sent')
vi.mock('../email/client.js', () => ({ sendEmail }))

const { db, pool } = await import('../db/client.js')
const { decks, deckPermissions, folderInvites, folderPermissions, folders, users } =
  await import('../db/schema.js')
const { createFolderSharingService } = await import('./folderSharing.js')
const { resolveDeckAccess, resolveFolderAccess } = await import('../auth/permissions.js')
const { consumePendingInvitesForEmail } = await import('../auth/invites.js')
const { allowedByDb } = await import('../auth/signInPolicy.js')
const { quietLog } = await import('../test-support/agentWorld.js')

const suffix = nanoid(8)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, 'x')
const id = (name: string) => `it-fshare-${name}-${suffix}`
const email = (sub: string) => `${sub}@example.test`
const verified = (sub: string) => ({ email: email(sub), emailVerified: true })

// The folder's creator, a second owner, a known user to invite, someone
// whose only decks and folders are their own, an address nobody has signed
// in with, and a member who creates decks.
const owner = id('owner')
const coOwner = id('co-owner')
const known = id('known')
const loner = id('loner')
const newcomer = id('newcomer')
const maker = id('maker')
const everyone = [owner, coOwner, known, loner, newcomer, maker]

const folder = id('folder')
const drafts = id('drafts')
const lonerFolder = id('loner-folder')
const deck = id('deck')
const lonerDeck = id('loner-deck')
const makersDeck = id('makers-deck')
const giftDeck = id('gift-deck')

const service = createFolderSharingService({ db, log: quietLog, hocuspocus: () => null })

beforeAll(async () => {
  await db.insert(users).values(
    [owner, coOwner, known, loner, maker].map((sub) => ({
      sub,
      email: email(sub),
      name: sub,
      emailVerified: true,
    })),
  )
  await db.insert(folders).values([
    { id: folder, ownerUserId: owner, name: 'Client' },
    // The owner's Drafts, renamed: it stays Drafts by its flag.
    { id: drafts, ownerUserId: owner, name: 'Scratch', isDrafts: true },
    { id: lonerFolder, ownerUserId: loner, name: 'Mine' },
  ])
  await db.insert(folderPermissions).values([
    { folderId: folder, userId: owner, role: 'owner' },
    { folderId: drafts, userId: owner, role: 'owner' },
    { folderId: lonerFolder, userId: loner, role: 'owner' },
  ])
  await db.insert(decks).values([
    { id: deck, title: 'Pitch', ownerUserId: owner, folderId: folder },
    { id: lonerDeck, title: 'Own deck', ownerUserId: loner, folderId: lonerFolder },
  ])
  await db.insert(deckPermissions).values([
    { deckId: deck, userId: owner, role: 'owner', grantedBy: owner },
    // The loner's creator row: their own deck must not admit them.
    { deckId: lonerDeck, userId: loner, role: 'owner', grantedBy: loner },
  ])
})

afterAll(async () => {
  // Decks first (folders restrict); permissions and invites cascade.
  await db.delete(decks).where(inArray(decks.id, [deck, lonerDeck, makersDeck, giftDeck]))
  await db.delete(folders).where(inArray(folders.id, [folder, drafts, lonerFolder]))
  await db.delete(users).where(inArray(users.sub, everyone))
  await pool.end()
})

beforeEach(() => sendEmail.mockClear())

async function roleOf(sub: string) {
  return (await resolveFolderAccess(db, { folderId: folder, userId: sub }))?.role ?? null
}

async function owners() {
  const rows = await db
    .select({ userId: folderPermissions.userId })
    .from(folderPermissions)
    .where(and(eq(folderPermissions.folderId, folder), eq(folderPermissions.role, 'owner')))
  return rows.map((r) => r.userId).sort()
}

/** Let the fire-and-forget invitation email finish. */
async function settleEmail() {
  await vi.waitFor(() => expect(sendEmail).toHaveBeenCalled())
}

describe('folder sharing', () => {
  it('only an owner of the folder manages its members', async () => {
    await expect(service.listMembers({ userId: known, folderId: folder })).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(
      service.listMembers({ userId: owner, folderId: id('missing') }),
    ).rejects.toMatchObject({ code: 'not_found' })
    const members = await service.listMembers({ userId: owner, folderId: folder })
    expect(members).toEqual([
      expect.objectContaining({ userId: owner, role: 'owner', email: email(owner) }),
    ])
  })

  it('a known address becomes a member at once, with the role on every deck in it', async () => {
    const result = await service.invite({
      userId: owner,
      folderId: folder,
      email: email(known).toUpperCase(),
      role: 'editor',
    })
    expect(result).toEqual({
      kind: 'granted',
      user: { userId: known, email: email(known), name: known, role: 'editor' },
    })
    expect(await roleOf(known)).toBe('editor')
    expect(await resolveDeckAccess(db, { deckId: deck, userId: known })).toEqual({
      role: 'editor',
      reason: 'folder',
    })
    // They already use Narrative: an email says it is theirs now — no invite to accept.
    await settleEmail()
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: email(known),
        subject: expect.stringContaining('shared "Client" with you'),
        text: expect.stringContaining('It is already in your Narrative'),
      }),
    )
    // The same role again: nothing new, no second email.
    sendEmail.mockClear()
    await service.invite({ userId: owner, folderId: folder, email: email(known), role: 'editor' })
    await new Promise((r) => setTimeout(r, 50))
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('inviting a member again changes their role; so does setRole, keeping who shared it', async () => {
    await service.invite({ userId: owner, folderId: folder, email: email(known), role: 'viewer' })
    expect(await roleOf(known)).toBe('viewer')
    await service.invite({ userId: owner, folderId: folder, email: email(coOwner), role: 'owner' })
    await expect(
      service.setRole({ userId: coOwner, folderId: folder, memberId: known, role: 'editor' }),
    ).resolves.toMatchObject({ userId: known, role: 'editor' })
    expect(await roleOf(known)).toBe('editor')
    // "Shared by" still names the owner who invited them, not the one who re-roled them.
    const [row] = await db
      .select({ grantedBy: folderPermissions.grantedBy })
      .from(folderPermissions)
      .where(and(eq(folderPermissions.folderId, folder), eq(folderPermissions.userId, known)))
    expect(row?.grantedBy).toBe(owner)
    // An editor still cannot manage members.
    await expect(
      service.setRole({ userId: known, folderId: folder, memberId: owner, role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    // A role change needs a member; it never adds one.
    await expect(
      service.setRole({ userId: owner, folderId: folder, memberId: loner, role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(await roleOf(loner)).toBeNull()
    await service.removeMember({ userId: owner, folderId: folder, memberId: coOwner })
  })

  it('an unknown address gets a pending invite and one email; a new role emails again', async () => {
    const first = await service.invite({
      userId: owner,
      folderId: folder,
      email: email(newcomer),
      role: 'viewer',
    })
    expect(first).toMatchObject({
      kind: 'pending',
      invite: { email: email(newcomer), role: 'viewer', replaced: false },
    })
    await settleEmail()
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: email(newcomer),
        subject: `${owner} shared "Client" with you on Narrative`,
        replyTo: email(owner),
        text: expect.stringContaining(encodeURIComponent(`/folder/${folder}`)),
      }),
    )

    // The same invitation again: updated, not emailed again.
    sendEmail.mockClear()
    const repeat = await service.invite({
      userId: owner,
      folderId: folder,
      email: email(newcomer),
      role: 'viewer',
    })
    expect(repeat).toMatchObject({ kind: 'pending', invite: { replaced: true } })
    await new Promise((r) => setTimeout(r, 50))
    expect(sendEmail).not.toHaveBeenCalled()

    // A new role is news: emailed, same invite id.
    const again = await service.invite({
      userId: owner,
      folderId: folder,
      email: email(newcomer),
      role: 'editor',
    })
    expect(again).toMatchObject({ kind: 'pending', invite: { role: 'editor', replaced: true } })
    expect(again.kind === 'pending' && first.kind === 'pending' && again.invite.id).toBe(
      first.kind === 'pending' && first.invite.id,
    )
    await settleEmail()
    expect(await service.listInvites({ userId: owner, folderId: folder })).toEqual([
      expect.objectContaining({ email: email(newcomer), role: 'editor' }),
    ])
  })

  it('a pending invite admits only a verified email, and the verified sign-in makes a member', async () => {
    expect(await allowedByDb(db, { email: email(newcomer), emailVerified: false })).toBeNull()
    expect(await allowedByDb(db, verified(newcomer))).toBe('invite')

    await db
      .insert(users)
      .values({ sub: newcomer, email: email(newcomer), name: newcomer, emailVerified: true })
    // An unverified claim to the address does not take the invite.
    const unverified = await consumePendingInvitesForEmail(db, {
      email: email(newcomer),
      sub: newcomer,
      emailVerified: false,
    })
    expect(unverified.joinedFolderIds).toEqual([])
    expect(await roleOf(newcomer)).toBeNull()

    const joined = await consumePendingInvitesForEmail(db, {
      email: email(newcomer),
      sub: newcomer,
      emailVerified: true,
    })
    expect(joined.joinedFolderIds).toEqual([folder])
    expect(await roleOf(newcomer)).toBe('editor')
    expect(await service.listInvites({ userId: owner, folderId: folder })).toEqual([])
    // From now on their membership keeps them allowed.
    expect(await allowedByDb(db, verified(newcomer))).toBe('permission')
  })

  it("only what someone else shared admits — never the user's own decks or folders", async () => {
    // The loner created a folder and a deck (with its creator row): not admitted.
    expect(await allowedByDb(db, verified(loner))).toBeNull()
    // A deck someone else shared with them admits them.
    await db
      .insert(decks)
      .values({ id: giftDeck, title: 'Gift', ownerUserId: owner, folderId: folder })
    await db
      .insert(deckPermissions)
      .values({ deckId: giftDeck, userId: loner, role: 'viewer', grantedBy: owner })
    expect(await allowedByDb(db, verified(loner))).toBe('permission')
    await db.delete(decks).where(eq(decks.id, giftDeck))
    expect(await allowedByDb(db, verified(loner))).toBeNull()
  })

  it('the Drafts folder is never shared, whatever its name', async () => {
    await expect(
      service.invite({ userId: owner, folderId: drafts, email: email(known), role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/Drafts/) })
    expect(
      await db
        .select()
        .from(folderPermissions)
        .where(and(eq(folderPermissions.folderId, drafts), eq(folderPermissions.userId, known))),
    ).toEqual([])
  })

  it('nobody changes or removes their own membership', async () => {
    await expect(
      service.invite({ userId: owner, folderId: folder, email: email(owner), role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      service.setRole({ userId: owner, folderId: folder, memberId: owner, role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      service.removeMember({ userId: owner, folderId: folder, memberId: owner }),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(await roleOf(owner)).toBe('owner')
  })

  it('a removed member loses the decks they made there, but not what was given to them', async () => {
    await service.invite({ userId: owner, folderId: folder, email: email(maker), role: 'editor' })
    // The maker creates a deck in the folder (with its creator row) and is
    // also given the folder's Pitch deck by the owner.
    await db
      .insert(decks)
      .values({ id: makersDeck, title: 'Made here', ownerUserId: maker, folderId: folder })
    await db.insert(deckPermissions).values([
      { deckId: makersDeck, userId: maker, role: 'owner', grantedBy: maker },
      { deckId: deck, userId: maker, role: 'viewer', grantedBy: owner },
    ])
    expect(await resolveDeckAccess(db, { deckId: makersDeck, userId: maker })).toMatchObject({
      role: 'owner',
    })

    await service.removeMember({ userId: owner, folderId: folder, memberId: maker })
    expect(await roleOf(maker)).toBeNull()
    expect(await resolveDeckAccess(db, { deckId: makersDeck, userId: maker })).toBeNull()
    expect(await resolveDeckAccess(db, { deckId: deck, userId: maker })).toEqual({
      role: 'viewer',
      reason: 'direct',
    })
  })

  it("a demoted owner's pending invites are withdrawn", async () => {
    await service.invite({ userId: owner, folderId: folder, email: email(coOwner), role: 'owner' })
    await service.invite({
      userId: coOwner,
      folderId: folder,
      email: `co-guest-${suffix}@example.test`,
      role: 'owner',
    })
    await settleEmail()
    expect(
      (await service.listInvites({ userId: owner, folderId: folder })).map((i) => i.email),
    ).toContain(`co-guest-${suffix}@example.test`)
    await service.setRole({ userId: owner, folderId: folder, memberId: coOwner, role: 'viewer' })
    expect(await service.listInvites({ userId: owner, folderId: folder })).toEqual([])
    await service.removeMember({ userId: owner, folderId: folder, memberId: coOwner })
  })

  it('two owners removing each other at once leave the folder an owner', async () => {
    await service.invite({ userId: owner, folderId: folder, email: email(coOwner), role: 'owner' })
    const outcomes = await Promise.allSettled([
      service.removeMember({ userId: owner, folderId: folder, memberId: coOwner }),
      service.removeMember({ userId: coOwner, folderId: folder, memberId: owner }),
    ])
    // One wins; the other was no longer an owner when its turn came.
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((o) => o.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ code: 'forbidden' }),
    })
    const left = await owners()
    expect(left).toHaveLength(1)
    // Restore the creator as owner for the remaining tests.
    if (left[0] !== owner) {
      await service.invite({
        userId: coOwner,
        folderId: folder,
        email: email(owner),
        role: 'owner',
      })
    }
    if ((await roleOf(coOwner)) !== null) {
      await service.removeMember({ userId: owner, folderId: folder, memberId: coOwner })
    }
    expect(await owners()).toEqual([owner])
  })

  it('two first invites to one address at once make one invite', async () => {
    const address = `twice-${suffix}@example.test`
    const both = await Promise.all([
      service.invite({ userId: owner, folderId: folder, email: address, role: 'viewer' }),
      service.invite({ userId: owner, folderId: folder, email: address, role: 'viewer' }),
    ])
    const ids = both.map((r) => (r.kind === 'pending' ? r.invite.id : null))
    expect(ids[0]).toBe(ids[1])
    const rows = await db
      .select({ id: folderInvites.id })
      .from(folderInvites)
      .where(and(eq(folderInvites.folderId, folder), eq(folderInvites.email, address)))
    expect(rows).toHaveLength(1)
    await settleEmail()
    await service.cancelInvite({ userId: owner, folderId: folder, inviteId: rows[0]!.id })
  })

  it('removing a non-member, and cancelling an invite once', async () => {
    await expect(
      service.removeMember({ userId: owner, folderId: folder, memberId: id('nobody') }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await service.removeMember({ userId: owner, folderId: folder, memberId: newcomer })
    expect(await roleOf(newcomer)).toBeNull()
    // Their only way in is gone, so the sign-in policy no longer admits them.
    expect(await allowedByDb(db, verified(newcomer))).toBeNull()

    const result = await service.invite({
      userId: owner,
      folderId: folder,
      email: `late-${suffix}@example.test`,
      role: 'viewer',
    })
    if (result.kind !== 'pending') throw new Error('expected a pending invite')
    await settleEmail()
    await service.cancelInvite({ userId: owner, folderId: folder, inviteId: result.invite.id })
    await expect(
      service.cancelInvite({ userId: owner, folderId: folder, inviteId: result.invite.id }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})
