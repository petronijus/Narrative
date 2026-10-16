/**
 * e2e/move-deck-share-link.spec.ts — the "Move to…" dialog warns when the
 * deck has an active share link: its holders can read the component pictures
 * and videos of the deck's folder, so the move opens the destination's to
 * them (ADR 0013, Consequences). A deck without a link moves without one.
 *
 * Seeds its own folders and decks through the command API and the share-link
 * route, and deletes the folders (with their decks and links) afterwards.
 */

import { expect, test, type APIRequestContext, type Page } from './fixtures/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

async function command<T>(
  request: APIRequestContext,
  target: Record<string, string>,
  commandId: string,
  input: unknown,
): Promise<T> {
  const res = await request.post(`${API_BASE}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target, command: commandId, input },
  })
  const body = (await res.json()) as { ok: boolean; result: T; error?: { message: string } }
  expect(body.ok, `${commandId}: ${body.error?.message}`).toBe(true)
  return body.result
}

interface Seeded {
  sourceId: string
  destId: string
  destName: string
  sharedTitle: string
  plainTitle: string
  plainId: string
}

async function seed(request: APIRequestContext, tag: string): Promise<Seeded> {
  const stamp = `${tag} ${Date.now()} ${Math.random().toString(36).slice(2, 7)}`
  const { id: sourceId } = await command<{ id: string }>(request, {}, 'folder.create', {
    name: `Move source ${stamp}`,
  })
  const destName = `Move destination ${stamp}`
  const { id: destId } = await command<{ id: string }>(request, {}, 'folder.create', {
    name: destName,
  })
  const sharedTitle = `Shared deck ${stamp}`
  const { id: sharedId } = await command<{ id: string }>(request, {}, 'deck.create', {
    title: sharedTitle,
    folderId: sourceId,
  })
  const plainTitle = `Plain deck ${stamp}`
  const { id: plainId } = await command<{ id: string }>(request, {}, 'deck.create', {
    title: plainTitle,
    folderId: sourceId,
  })
  const link = await request.post(`${API_BASE}/decks/${sharedId}/share-links`, {
    data: { role: 'viewer' },
  })
  expect(link.status(), 'POST /decks/:id/share-links').toBe(201)
  return { sourceId, destId, destName, sharedTitle, plainTitle, plainId }
}

async function deleteFolder(request: APIRequestContext, folderId: string): Promise<void> {
  const res = await request.delete(`${API_BASE}/folders/${folderId}`)
  expect(res.ok() || res.status() === 404, `DELETE /folders/${folderId}: ${res.status()}`).toBe(
    true,
  )
}

/** Open the "Move to…" dialog of the deck card titled `title`. */
async function openMoveDialog(page: Page, title: string) {
  const card = page.locator('.panel').filter({ hasText: title })
  await card.hover()
  await card.getByRole('button', { name: 'Deck options' }).click()
  await card.getByRole('menuitem', { name: /Move to/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Move deck to folder' })
  await expect(dialog).toBeVisible()
  return dialog
}

test.describe('Move to… and share links', () => {
  test('warns that a share-linked deck opens the destination’s component media', async ({
    page,
    request,
  }) => {
    const seeded = await seed(request, 'warn')
    try {
      await page.goto(`/folder/${seeded.sourceId}`)
      const dialog = await openMoveDialog(page, seeded.sharedTitle)
      await dialog.getByRole('option', { name: seeded.destName }).click()

      const note = dialog.getByRole('note')
      await expect(note).toContainText('This deck has an active share link.')
      await expect(note).toContainText(
        `pictures and videos of the components in “${seeded.destName}”`,
      )
      await expect(dialog.getByRole('button', { name: 'Move here' })).toBeEnabled()
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toHaveCount(0)
    } finally {
      await deleteFolder(request, seeded.sourceId)
      await deleteFolder(request, seeded.destId)
    }
  })

  test('a deck without a share link moves without a warning', async ({ page, request }) => {
    const seeded = await seed(request, 'plain')
    try {
      await page.goto(`/folder/${seeded.sourceId}`)
      const dialog = await openMoveDialog(page, seeded.plainTitle)
      await dialog.getByRole('option', { name: seeded.destName }).click()

      const moveHere = dialog.getByRole('button', { name: 'Move here' })
      // Enabled = the share-link check has answered; it found no link.
      await expect(moveHere).toBeEnabled()
      await expect(dialog.getByRole('note')).toHaveCount(0)

      await moveHere.click()
      await expect(dialog).toHaveCount(0)
      await expect
        .poll(async () => {
          const res = await request.get(`${API_BASE}/decks?folderId=${seeded.destId}`)
          const decks = (await res.json()) as Array<{ id: string }>
          return decks.map((d) => d.id)
        })
        .toContain(seeded.plainId)
    } finally {
      await deleteFolder(request, seeded.sourceId)
      await deleteFolder(request, seeded.destId)
    }
  })
})
