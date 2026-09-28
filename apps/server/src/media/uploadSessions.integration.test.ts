/**
 * media/uploadSessions.integration.test.ts — the Drizzle UploadSessionStore
 * against a real Postgres (migration 0024 applied). Excluded from `pnpm test`;
 * run with `pnpm --filter @narrative/server test:integration` against the
 * local dev database. It creates its own user, folder and deck under random
 * ids and deletes them afterwards (sessions cascade with the deck).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, pool } from '../db/client.js'
import { decks, folders, uploadSessions, users } from '../db/schema.js'
import {
  UPLOAD_SESSION_TTL_MS,
  createDrizzleUploadSessionStore,
  createUploadSessionService,
  revokeAllUploadSessionsForUser,
  revokeUploadSessionsForCredential,
} from './uploadSessions.js'

const suffix = nanoid(8)
const userSub = `it-user-${suffix}`
const folderId = `it-folder-${suffix}`
const deckId = `it-deck-${suffix}`
const store = createDrizzleUploadSessionStore(db)

beforeAll(async () => {
  await db.insert(users).values({ sub: userSub, email: `${userSub}@example.test`, name: 'IT' })
  await db.insert(folders).values({ id: folderId, ownerUserId: userSub, name: 'IT folder' })
  await db.insert(decks).values({ id: deckId, ownerUserId: userSub, folderId, title: 'IT deck' })
})

afterAll(async () => {
  await db.delete(decks).where(eq(decks.id, deckId))
  await db.delete(folders).where(eq(folders.id, folderId))
  await db.delete(users).where(eq(users.sub, userSub))
  await pool.end()
})

describe('Drizzle upload session store', () => {
  it('issues, verifies and binds exactly once, even when two claims race', async () => {
    const sessions = createUploadSessionService(store, { isOwnerAllowed: async () => true })
    const { token } = await sessions.issue({ userSub, deckId, sizeBytes: 1024, kind: 'image' })
    const session = await sessions.verify(token)
    expect(session).toMatchObject({ userSub, deckId, uploadId: null })
    const results = await Promise.all([
      sessions.claim(session!, 'upload-a'),
      sessions.claim(session!, 'upload-b'),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const bound = await sessions.verify(token)
    expect(['upload-a', 'upload-b']).toContain(bound!.uploadId)
  })

  it('does not bind an expired session, and sweeps it a day later', async () => {
    let now = new Date()
    const sessions = createUploadSessionService(store, {
      isOwnerAllowed: async () => true,
      now: () => now,
    })
    const { token } = await sessions.issue({ userSub, deckId, sizeBytes: 1024, kind: 'image' })
    const session = (await sessions.verify(token))!
    now = new Date(now.getTime() + UPLOAD_SESSION_TTL_MS + 1000)
    expect(await sessions.claim(session, 'late')).toBe(false)
    now = new Date(now.getTime() + 25 * 60 * 60 * 1000)
    await sessions.issue({ userSub, deckId, sizeBytes: 1024, kind: 'image' })
    const [row] = await db.select().from(uploadSessions).where(eq(uploadSessions.id, session.id))
    expect(row).toBeUndefined()
  })

  it('goes with its deck', async () => {
    const sessions = createUploadSessionService(store, { isOwnerAllowed: async () => true })
    const tempDeck = `it-deck-tmp-${suffix}`
    await db.insert(decks).values({ id: tempDeck, ownerUserId: userSub, folderId, title: 'tmp' })
    const { token } = await sessions.issue({
      userSub,
      deckId: tempDeck,
      sizeBytes: 1024,
      kind: 'image',
    })
    await db.delete(decks).where(eq(decks.id, tempDeck))
    expect(await sessions.verify(token)).toBeNull()
  })

  it("reads the owner's email for the sign-in policy, and dies with its credential or its user", async () => {
    const seen: unknown[] = []
    const sessions = createUploadSessionService(store, {
      isOwnerAllowed: async (owner) => {
        seen.push(owner)
        return true
      },
    })
    const a = await sessions.issue({
      userSub,
      deckId,
      sizeBytes: 1024,
      kind: 'image',
      credentialKey: `token:it-${suffix}`,
    })
    const b = await sessions.issue({ userSub, deckId, sizeBytes: 1024, kind: 'image' })
    expect(await sessions.verify(a.token)).not.toBeNull()
    expect(seen[0]).toMatchObject({ userSub, email: `${userSub}@example.test` })
    expect(await revokeUploadSessionsForCredential(db, `token:it-${suffix}`)).toBe(1)
    expect(await sessions.verify(a.token)).toBeNull()
    expect(await sessions.verify(b.token)).not.toBeNull()
    expect(await revokeAllUploadSessionsForUser(db, userSub)).toBeGreaterThanOrEqual(1)
    expect(await sessions.verify(b.token)).toBeNull()
  })
})
