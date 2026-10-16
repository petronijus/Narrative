/**
 * services/sharing.integration.test.ts — the email deck sharing sends,
 * against a real Postgres: someone who already uses Narrative gets access at
 * once AND an email saying so (with the deck's thumbnail when there is one);
 * the same role again sends nothing, a new role sends again.
 * Excluded from `pnpm test`; run with `just integration`.
 *
 * It creates its own users and deck under random ids and deletes them
 * afterwards. The email client is mocked: nothing is sent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'

const sendEmail = vi.fn(async () => 'sent')
vi.mock('../email/client.js', () => ({ sendEmail }))

const { db, pool } = await import('../db/client.js')
const { decks, deckPermissions, folders, users } = await import('../db/schema.js')
const { createSharingService } = await import('./sharing.js')
const { quietLog } = await import('../test-support/agentWorld.js')

const suffix = nanoid(8)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, 'x')
const id = (name: string) => `it-dshare-${name}-${suffix}`
const email = (sub: string) => `${sub}@example.test`

const owner = id('owner')
const colleague = id('colleague')
const deck = id('deck')
const folder = id('folder')

const service = createSharingService({ db, log: quietLog, hocuspocus: () => null })

beforeAll(async () => {
  await db
    .insert(users)
    .values(
      [owner, colleague].map((sub) => ({ sub, email: email(sub), name: sub, emailVerified: true })),
    )
  await db.insert(folders).values({ id: folder, ownerUserId: owner, name: 'Work' })
  await db
    .insert(decks)
    .values({ id: deck, title: 'Quarterly', ownerUserId: owner, folderId: folder })
  await db.insert(deckPermissions).values({ deckId: deck, userId: owner, role: 'owner' })
})

afterAll(async () => {
  await db.delete(decks).where(inArray(decks.id, [deck]))
  await db.delete(folders).where(inArray(folders.id, [folder]))
  await db.delete(users).where(inArray(users.sub, [owner, colleague]))
  await pool.end()
})

beforeEach(() => sendEmail.mockClear())

const invite = (role: 'viewer' | 'editor') =>
  service.invite({ deckId: deck, inviterUserId: owner, email: email(colleague), role })

describe('sharing a deck with someone who already uses Narrative', () => {
  it('grants at once and emails them that the deck is theirs', async () => {
    await expect(invite('viewer')).resolves.toMatchObject({ kind: 'granted' })
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1))
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: email(colleague),
        replyTo: email(owner),
        subject: `${owner} shared "Quarterly" with you on Narrative`,
        text: expect.stringContaining('It is already in your Narrative'),
        html: expect.stringContaining('You now have access to'),
      }),
    )
  })

  it('sends nothing for the same role again, and again for a new role', async () => {
    await invite('viewer')
    await new Promise((r) => setTimeout(r, 50))
    expect(sendEmail).not.toHaveBeenCalled()
    await invite('editor')
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1))
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Role:  Editor') }),
    )
  })
})
