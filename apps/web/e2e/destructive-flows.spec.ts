/**
 * destructive-flows.spec.ts
 *
 * E2E coverage for the three irreversible-by-design operations:
 *
 *   1. Deck delete  — DELETE /decks/:id (owner only).
 *   2. Share-link revoke — DELETE /decks/:id/share-links/:linkId.
 *      The Tier-1 IDOR fix scopes by deckId; this test exercises the
 *      happy path through the actual revoke API call.
 *   3. Folder delete cascade — DELETE /folders/:id deletes all decks
 *      inside it (server enforces). Drafts cannot be deleted.
 *
 * Why e2e rather than RTL: each flow involves a confirmation dialog,
 * an HTTP roundtrip, AND a UI refresh of the surrounding list view.
 * The interaction surface is exactly what jsdom misrepresents.
 *
 * Driven through the API where the UI doesn't yet expose a button (kebab
 * menu / confirm modal flows are mid-refactor at the time of writing,
 * per the strategy doc's note on FoldersHome:197). When the menus
 * stabilise, the test should switch to clicking the buttons; meanwhile
 * the API path validates the server contract end-to-end.
 */

import { expect, test, type Page } from '@playwright/test'

const SERVER = 'http://localhost:3001'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createDeck(page: Page, title = 'destructive-flow-spec'): Promise<string> {
  const res = await page.request.post(`${SERVER}/decks`, { data: { title } })
  expect(res.status()).toBe(201)
  const { id } = (await res.json()) as { id: string }
  return id
}

async function listDecks(page: Page): Promise<Array<{ id: string; title: string }>> {
  const res = await page.request.get(`${SERVER}/decks`)
  expect(res.status()).toBe(200)
  return (await res.json()) as Array<{ id: string; title: string }>
}

// ---------------------------------------------------------------------------
// Deck delete
// ---------------------------------------------------------------------------

test.describe('Deck delete', () => {
  test('owner can delete their own deck and the deck disappears from /decks', async ({ page }) => {
    test.setTimeout(30_000)

    const id = await createDeck(page, 'delete-me')

    // Sanity — the deck shows up in the list.
    expect((await listDecks(page)).some((d) => d.id === id)).toBe(true)

    const del = await page.request.delete(`${SERVER}/decks/${id}`)
    expect(del.status()).toBe(204)

    // Gone.
    expect((await listDecks(page)).some((d) => d.id === id)).toBe(false)

    // Re-fetching the deck directly returns 404 (or 403 — the server
    // historically returned both depending on which guard fired first;
    // either is fine, the key invariant is "no longer accessible").
    const get = await page.request.get(`${SERVER}/decks/${id}`)
    expect([403, 404]).toContain(get.status())
  })

  test('deleting a deck releases its share links', async ({ page }) => {
    test.setTimeout(30_000)

    const deckId = await createDeck(page, 'shared-then-deleted')

    // Create a share link.
    const linkRes = await page.request.post(`${SERVER}/decks/${deckId}/share-links`, {
      data: { role: 'viewer' },
    })
    expect(linkRes.status()).toBe(201)
    const link = (await linkRes.json()) as { id: string }

    // Delete the parent deck.
    const del = await page.request.delete(`${SERVER}/decks/${deckId}`)
    expect(del.status()).toBe(204)

    // Hitting the share URL must NOT resurrect the deck — confirmation
    // that the cascade ran on the server side.
    const sharedAccess = await page.request.get(`${SERVER}/decks/${deckId}?share_token=${link.id}`)
    expect([403, 404]).toContain(sharedAccess.status())
  })
})

// ---------------------------------------------------------------------------
// Share-link revoke (IDOR-fixed path from Tier 1)
// ---------------------------------------------------------------------------

test.describe('Share-link revoke', () => {
  test('revoke makes the link unusable on subsequent share_token queries', async ({ page }) => {
    test.setTimeout(30_000)

    const deckId = await createDeck(page, 'revoke-spec')

    const linkRes = await page.request.post(`${SERVER}/decks/${deckId}/share-links`, {
      data: { role: 'viewer' },
    })
    const link = (await linkRes.json()) as { id: string }

    // Link works before revoke.
    const beforeRevoke = await page.request.get(`${SERVER}/decks/${deckId}?share_token=${link.id}`)
    expect(beforeRevoke.status()).toBe(200)

    // Revoke.
    const revokeRes = await page.request.delete(`${SERVER}/decks/${deckId}/share-links/${link.id}`)
    expect(revokeRes.status()).toBe(204)

    // A token that was never issued tells us whether the token is consulted at
    // all. With BYPASS_AUTH=true — the default for local dev — every request is
    // authenticated as the deck's owner and the share token is ignored, so a
    // revoked link still returns 200 for reasons that have nothing to do with
    // revocation. Assert nothing rather than assert something false.
    const bogus = await page.request.get(`${SERVER}/decks/${deckId}?share_token=not-a-real-token`)
    test.skip(
      bogus.status() === 200,
      'server authenticates the caller directly (BYPASS_AUTH) — share-token revocation is not observable here',
    )

    // Link no longer grants access.
    const afterRevoke = await page.request.get(`${SERVER}/decks/${deckId}?share_token=${link.id}`)
    expect([403, 404]).toContain(afterRevoke.status())
  })

  test('IDOR guard: revoking with the wrong deckId is a no-op (the link survives)', async ({
    page,
  }) => {
    test.setTimeout(30_000)

    const deckA = await createDeck(page, 'idor-deckA')
    const deckB = await createDeck(page, 'idor-deckB')

    // Create a share link on deck A.
    const linkRes = await page.request.post(`${SERVER}/decks/${deckA}/share-links`, {
      data: { role: 'viewer' },
    })
    const link = (await linkRes.json()) as { id: string }

    // Attempt to revoke the link via deck B's endpoint. Pre-Tier-1 fix
    // this would have revoked the link (linkId is a primary key with no
    // deck_id constraint). Post-fix the SQL UPDATE matches zero rows,
    // and the link stays alive.
    //
    // Either status is acceptable: server may return 204 (DELETE is
    // idempotent — "no matching row" is treated as success) OR 404.
    // What matters is the side-effect: link still works through deck A.
    const revokeWrongDeck = await page.request.delete(
      `${SERVER}/decks/${deckB}/share-links/${link.id}`,
    )
    expect([204, 404]).toContain(revokeWrongDeck.status())

    // Crucial assertion: the link still grants access on deck A.
    const stillWorks = await page.request.get(`${SERVER}/decks/${deckA}?share_token=${link.id}`)
    expect(stillWorks.status()).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Folder delete cascade
// ---------------------------------------------------------------------------

test.describe('Folder delete', () => {
  test('deleting a folder removes all decks inside it', async ({ page }) => {
    test.setTimeout(30_000)

    // Create a folder.
    const folderRes = await page.request.post(`${SERVER}/folders`, {
      data: { name: 'cascade-spec' },
    })
    expect(folderRes.status()).toBe(201)
    const folder = (await folderRes.json()) as { id: string }

    // Create two decks inside the folder.
    const deck1Res = await page.request.post(`${SERVER}/decks`, {
      data: { title: 'cascade-1', folderId: folder.id },
    })
    const deck1 = (await deck1Res.json()) as { id: string }
    const deck2Res = await page.request.post(`${SERVER}/decks`, {
      data: { title: 'cascade-2', folderId: folder.id },
    })
    const deck2 = (await deck2Res.json()) as { id: string }

    // Sanity: both decks exist.
    const decksBefore = await listDecks(page)
    expect(decksBefore.some((d) => d.id === deck1.id)).toBe(true)
    expect(decksBefore.some((d) => d.id === deck2.id)).toBe(true)

    // Delete the folder.
    const del = await page.request.delete(`${SERVER}/folders/${folder.id}`)
    expect([204, 200]).toContain(del.status())

    // Both decks must be gone — the folder cascade applies.
    const decksAfter = await listDecks(page)
    expect(decksAfter.some((d) => d.id === deck1.id)).toBe(false)
    expect(decksAfter.some((d) => d.id === deck2.id)).toBe(false)
  })

  test('cannot delete the Drafts folder (server invariant)', async ({ page }) => {
    test.setTimeout(30_000)

    // Drafts is auto-created on first /folders request for the user.
    const list = await page.request.get(`${SERVER}/folders`)
    expect(list.status()).toBe(200)
    const folders = (await list.json()) as Array<{ id: string; name: string }>
    const drafts = folders.find((f) => f.name === 'Drafts')
    if (drafts === undefined) {
      // Drafts may not exist if no user-state has been seeded yet — that's
      // fine, the invariant only matters when the folder is real.
      test.skip(true, 'No Drafts folder present yet — server has not seeded user state')
      return
    }

    const del = await page.request.delete(`${SERVER}/folders/${drafts.id}`)
    expect(del.status()).toBeGreaterThanOrEqual(400)
    // Drafts must still exist.
    const after = await page.request.get(`${SERVER}/folders`)
    const stillThere = ((await after.json()) as Array<{ id: string; name: string }>).some(
      (f) => f.id === drafts.id,
    )
    expect(stillThere).toBe(true)
  })
})
