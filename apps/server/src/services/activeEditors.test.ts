/**
 * services/activeEditors.test.ts — who has a folder's decks open, as each
 * member sees it (folder sharing step 4, security review): the folder's
 * owners get user ids and emails; viewers and editors get names and a
 * stable pseudonym per person and folder — the open editors can include
 * guests of single decks whom only the owners may know. Outsiders get "not
 * found".
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../hocuspocus/presence.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hocuspocus/presence.js')>()),
  activeEditorsByDeck: (deckIds: string[]) =>
    deckIds.map((deckId) => ({ deckId, userIds: ['sub-guest', 'sub-member'] })),
}))

const { createDecksService } = await import('./decks.js')
const { scriptedDb } = await import('../test-support/scriptedDb.js')
const { serviceErrorOf } = await import('../test-support/serviceErrors.js')
const { quietLog } = await import('../test-support/agentWorld.js')

const PEOPLE = [
  { sub: 'sub-guest', email: 'guest@example.com', name: 'Guest' },
  { sub: 'sub-member', email: 'member@example.com', name: 'Member' },
]

function service(role: string | null) {
  // Selects: the caller's folder membership, the folder's decks, the directory.
  const db = scriptedDb({
    selects: [role === null ? [] : [{ role }], [{ id: 'd1' }], PEOPLE],
  })
  return createDecksService({ db: db.db, log: quietLog, hocuspocus: () => null })
}

describe('activeEditors', () => {
  it("gives the folder's owners user ids and emails", async () => {
    const entries = await service('owner').activeEditors({ userId: 'o', folderId: 'f1' })
    expect(entries).toEqual([
      {
        deckId: 'd1',
        users: [
          { userId: 'sub-guest', email: 'guest@example.com', name: 'Guest' },
          { userId: 'sub-member', email: 'member@example.com', name: 'Member' },
        ],
      },
    ])
  })

  it('gives other members names and stable pseudonyms, never subs or emails', async () => {
    const first = await service('viewer').activeEditors({ userId: 'v', folderId: 'f1' })
    const again = await service('editor').activeEditors({ userId: 'e', folderId: 'f1' })
    const users = first[0]!.users
    expect(users.map((u) => u.name)).toEqual(['Guest', 'Member'])
    expect(users.every((u) => u.email === null && /^peer-[\w-]{16}$/.test(u.userId))).toBe(true)
    expect(JSON.stringify(first)).not.toMatch(/sub-guest|guest@example\.com/)
    // One person, one id, while the server runs; another folder, another id.
    expect(again[0]!.users.map((u) => u.userId)).toEqual(users.map((u) => u.userId))
    const elsewhere = await service('viewer').activeEditors({ userId: 'v', folderId: 'f2' })
    expect(elsewhere[0]!.users[0]!.userId).not.toBe(users[0]!.userId)
  })

  it('answers "not found" to someone outside the folder', async () => {
    const err = await serviceErrorOf(service(null).activeEditors({ userId: 'x', folderId: 'f1' }))
    expect(err.status).toBe(404)
  })
})
