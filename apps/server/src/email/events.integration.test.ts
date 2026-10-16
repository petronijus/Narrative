/**
 * email/events.integration.test.ts — the notification emails against a real
 * Postgres, through the services that send them:
 *   - deleting a shared folder tells its other members, never the deleter;
 *   - removing a member tells them, with the folder and their old role;
 *   - an accepted invite tells the inviter;
 *   - making someone an admin tells them, and so does taking it away;
 *   - allowing a new address welcomes it;
 *   - a kind an admin turned off is not sent at all.
 * Excluded from `pnpm test`; run with `just integration`.
 *
 * It creates its own users and folders under random ids and deletes them
 * afterwards. The email client is mocked: nothing is sent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'

const sendEmail = vi.fn(async (_: { to: string; subject: string; text: string }) => 'sent')
vi.mock('./client.js', () => ({ sendEmail }))

const { db, pool } = await import('../db/client.js')
const { allowedEmails, emailSettings, folderInvites, folderPermissions, folders, users } =
  await import('../db/schema.js')
const { createFoldersService } = await import('../services/folders.js')
const { createFolderSharingService } = await import('../services/folderSharing.js')
const { createAdminService } = await import('../services/admin.js')
const { consumePendingInvitesForEmail } = await import('../auth/invites.js')
const { notifyInvitesAccepted } = await import('./events.js')
const { quietLog } = await import('../test-support/agentWorld.js')

const suffix = nanoid(8)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, 'x')
const id = (name: string) => `it-mail-${name}-${suffix}`
const email = (sub: string) => `${sub}@example.test`

const owner = id('owner')
const member = id('member')
const admin = id('admin')
const newcomer = id('newcomer')
const people = [owner, member, admin, newcomer]
const folderA = id('folder-a')
const folderB = id('folder-b')

const deps = { db, log: quietLog, hocuspocus: () => null }
const foldersService = createFoldersService(deps)
const sharing = createFolderSharingService(deps)
const admins = createAdminService(deps, { allowlist: { allowedEmails: ['x@example.test'] } })

/** The emails sent to `to`, once the background sends settle. */
async function sentTo(to: string, count = 1) {
  await vi.waitFor(() =>
    expect(sendEmail.mock.calls.filter(([m]) => m.to === to).length).toBeGreaterThanOrEqual(count),
  )
  return sendEmail.mock.calls.filter(([m]) => m.to === to).map(([m]) => m)
}

beforeAll(async () => {
  await db.insert(users).values([
    { sub: owner, email: email(owner), name: 'Owner', emailVerified: true },
    { sub: member, email: email(member), name: 'Member', emailVerified: true },
    { sub: admin, email: email(admin), name: 'Admin', emailVerified: true, isAdmin: true },
  ])
  await db.insert(folders).values([
    { id: folderA, ownerUserId: owner, name: 'Pitches' },
    { id: folderB, ownerUserId: owner, name: 'Archive' },
  ])
  await db.insert(folderPermissions).values([
    { folderId: folderA, userId: owner, role: 'owner' },
    { folderId: folderA, userId: member, role: 'editor', grantedBy: owner },
    { folderId: folderB, userId: owner, role: 'owner' },
    { folderId: folderB, userId: member, role: 'viewer', grantedBy: owner },
  ])
})

afterAll(async () => {
  await db.delete(emailSettings).where(eq(emailSettings.updatedBySub, admin))
  await db.delete(allowedEmails).where(eq(allowedEmails.addedBySub, admin))
  await db.delete(folders).where(inArray(folders.id, [folderA, folderB]))
  await db.delete(users).where(inArray(users.sub, people))
  await pool.end()
})

beforeEach(() => sendEmail.mockClear())

describe('notification emails', () => {
  it('removing a member tells them which folder and what role they had', async () => {
    await sharing.removeMember({ userId: owner, folderId: folderB, memberId: member })
    const [m] = await sentTo(email(member))
    expect(m).toMatchObject({
      subject: 'Your access to "Archive" was removed',
      text: expect.stringContaining('Your role was: Viewer'),
    })
  })

  it('deleting a shared folder tells its other members, never the one who deleted it', async () => {
    await foldersService.delete({ userId: owner, folderId: folderA })
    const [m] = await sentTo(email(member))
    expect(m!.subject).toBe('Owner deleted the folder "Pitches"')
    await new Promise((r) => setTimeout(r, 50))
    expect(sendEmail.mock.calls.some(([x]) => x.to === email(owner))).toBe(false)
  })

  it('an accepted invite tells whoever sent it', async () => {
    const f = id('folder-c')
    await db.insert(folders).values({ id: f, ownerUserId: owner, name: 'Launch' })
    await db.insert(folderPermissions).values({ folderId: f, userId: owner, role: 'owner' })
    try {
      await db.insert(folderInvites).values({
        id: id('inv'),
        folderId: f,
        email: email(newcomer),
        role: 'viewer',
        invitedBySub: owner,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      await db
        .insert(users)
        .values({ sub: newcomer, email: email(newcomer), name: 'Newcomer', emailVerified: true })
      const consumed = await consumePendingInvitesForEmail(db, {
        email: email(newcomer),
        sub: newcomer,
        emailVerified: true,
      })
      notifyInvitesAccepted(
        { db, log: quietLog },
        { whoSub: newcomer, accepted: consumed.accepted },
      )
      const [m] = await sentTo(email(owner))
      expect(m!.subject).toBe('Newcomer accepted your invitation to "Launch"')
    } finally {
      await db.delete(folders).where(eq(folders.id, f))
    }
  })

  it('making someone an admin tells them, and so does taking it away', async () => {
    await admins.setAdmin({ userId: admin, targetUserId: member, isAdmin: true })
    expect((await sentTo(email(member)))[0]!.subject).toBe('Admin made you an admin of Narrative')
    sendEmail.mockClear()
    await admins.setAdmin({ userId: admin, targetUserId: member, isAdmin: false })
    expect((await sentTo(email(member)))[0]!.subject).toBe('You’re no longer an admin of Narrative')
  })

  it('allowing a new address welcomes it; a kind turned off is not sent at all', async () => {
    const fresh = email(id('fresh'))
    await admins.allowEmail({ userId: admin, email: fresh })
    expect((await sentTo(fresh))[0]!.subject).toBe('Admin invited you to Narrative')

    await admins.setEmailEnabled({ userId: admin, kind: 'sign-in-allowed', enabled: false })
    const muted = email(id('muted'))
    await admins.allowEmail({ userId: admin, email: muted })
    await new Promise((r) => setTimeout(r, 100))
    expect(sendEmail.mock.calls.some(([m]) => m.to === muted)).toBe(false)
    expect(
      (await admins.listEmails({ userId: admin })).find((k) => k.kind === 'sign-in-allowed'),
    ).toMatchObject({ enabled: false })
    await admins.setEmailEnabled({ userId: admin, kind: 'sign-in-allowed', enabled: true })
  })
})
