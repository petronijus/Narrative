/**
 * e2e/folder-sharing.spec.ts — folder sharing, step 3
 * (docs/plans/folder-sharing.md), with two people: the owner shares a folder
 * from its page; the member finds it on the home page with who shared it and
 * their role; a viewer gets no controls that would change the folder, its
 * decks or its component masters; an editor's open editor writes to the
 * deck, and once they are removed nothing they do reaches it any more; the
 * folder goes from their list.
 *
 * Two people in one dev stack: under BYPASS_AUTH every browser is
 * `dev-user`, and the `narrative_dev_as` cookie makes a browser context
 * another synthetic identity (apps/server/src/auth/devIdentity.ts). Each
 * parallel slot uses its own fixed pair, so runs leave at most two directory
 * rows per slot behind. Each test seeds its folder, deck and component through
 * the API as the owner and deletes the folder (with all of it) afterwards.
 */

import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
  type TestInfo,
} from '@playwright/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

/** A browser context that is the synthetic identity `sub`. */
async function personPage(browser: Browser, sub: string): Promise<Page> {
  const context = await browser.newContext()
  await context.addCookies([
    { name: 'narrative_dev_as', value: sub, domain: 'localhost', path: '/' },
  ])
  return context.newPage()
}

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

interface World {
  owner: Page
  member: Page
  ownerSub: string
  memberSub: string
  memberEmail: string
  folderId: string
  folderName: string
  deckId: string
  deckTitle: string
  componentId: string
}

async function seed(browser: Browser, info: TestInfo): Promise<World> {
  const slot = info.parallelIndex
  const ownerSub = `dev-e2e-share-owner-${slot}`
  const memberSub = `dev-e2e-share-member-${slot}`
  const owner = await personPage(browser, ownerSub)
  const member = await personPage(browser, memberSub)
  // The member's first request gives them a directory entry, as a first
  // sign-in would: inviting their address then makes them a member at once.
  const me = await member.request.get(`${API_BASE}/folders`)
  expect(me.ok(), 'GET /folders as the member').toBe(true)

  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const folderName = `Shared folder ${stamp}`
  const { id: folderId } = await command<{ id: string }>(owner.request, {}, 'folder.create', {
    name: folderName,
  })
  const deckTitle = `Shared deck ${stamp}`
  const { id: deckId } = await command<{ id: string }>(owner.request, {}, 'deck.create', {
    title: deckTitle,
    folderId,
  })
  const component = await owner.request.post(`${API_BASE}/folders/${folderId}/components`, {
    data: { name: `Shared master ${stamp}` },
  })
  expect(component.ok(), `POST components: ${component.status()}`).toBe(true)
  const { id: componentId } = (await component.json()) as { id: string }
  return {
    owner,
    member,
    ownerSub,
    memberSub,
    memberEmail: `${memberSub}@dev.narrative.test`,
    folderId,
    folderName,
    deckId,
    deckTitle,
    componentId,
  }
}

async function cleanUp(world: World): Promise<void> {
  const res = await world.owner.request.delete(`${API_BASE}/folders/${world.folderId}`)
  expect(res.ok() || res.status() === 404, `DELETE /folders: ${res.status()}`).toBe(true)
  await world.owner.context().close()
  await world.member.context().close()
}

/** Open the folder's Share dialog from its page, as its owner, and share it with the member. */
async function shareWithMember(world: World, role: 'viewer' | 'editor') {
  await world.owner.goto(`/folder/${world.folderId}`)
  await world.owner.locator('[data-action="folder.share"]').click()
  const dialog = world.owner.getByRole('dialog', { name: `Share “${world.folderName}”` })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Invite by email').fill(world.memberEmail)
  await dialog.getByLabel('Role for the invite').selectOption(role)
  await dialog.getByRole('button', { name: 'Invite' }).click()
  await expect(dialog.getByText(`Granted ${world.memberEmail} ${role} access.`)).toBeVisible()
  await expect(dialog.getByText(world.memberSub, { exact: true })).toBeVisible()
  return dialog
}

/** The member's card for the folder on the home page. */
function folderCard(page: Page, name: string) {
  return page.locator('.panel').filter({ hasText: name })
}

/** The editor's drawing tools — absent for a viewer. */
function toolButtons(page: Page) {
  return page.locator('[data-action^="tool."]')
}

/** The deck's slide count as the server holds it (the owner's command API). */
async function serverSlideCount(world: World): Promise<number> {
  const deck = await command<{ slideCount: number }>(
    world.owner.request,
    { deckId: world.deckId },
    'query.deck',
    {},
  )
  return deck.slideCount
}

test('the owner shares a folder; a viewer sees who shared it and can change nothing', async ({
  browser,
}, info) => {
  const world = await seed(browser, info)
  try {
    // Before: the folder is not the member's.
    await world.member.goto('/')
    await expect(world.member.getByText('Loading folders…')).toHaveCount(0)
    await expect(folderCard(world.member, world.folderName)).toHaveCount(0)

    await shareWithMember(world, 'viewer')

    // The member: the folder on the home page, with who shared it.
    await world.member.goto('/')
    const card = folderCard(world.member, world.folderName)
    await expect(card).toContainText(`Shared by ${world.ownerSub}`)
    await expect(card).toContainText('viewer')

    // Its page: the deck, and nothing that would change the folder.
    await card.click()
    await expect(world.member).toHaveURL(new RegExp(`/folder/${world.folderId}$`))
    await expect(world.member.getByText(world.deckTitle)).toBeVisible()
    await expect(world.member.getByText(`Shared by ${world.ownerSub}`)).toBeVisible()
    await expect(world.member.getByRole('button', { name: 'New deck' })).toHaveCount(0)
    await expect(world.member.locator('[data-action="folder.share"]')).toHaveCount(0)

    // Its settings: view only.
    await world.member.goto(`/folder/${world.folderId}/settings`)
    await expect(world.member.getByText('View only')).toBeVisible()
    await expect(world.member.getByRole('button', { name: 'Add new color token' })).toHaveCount(0)

    // The deck opens read-only: no tools, no rename.
    await world.member.goto(`/deck/${world.deckId}`)
    await expect(world.member.locator('[data-action="deck.rename"]')).toBeDisabled({
      timeout: 15_000,
    })
    await expect(toolButtons(world.member)).toHaveCount(0)

    // So does the component master.
    await world.member.goto(`/folder/${world.folderId}/component/${world.componentId}`)
    await expect(world.member.locator('canvas').first()).toBeVisible({ timeout: 15_000 })
    await expect(toolButtons(world.member)).toHaveCount(0)
  } finally {
    await cleanUp(world)
  }
})

test("an editor's open editor writes the deck until they are removed; then the folder is gone", async ({
  browser,
}, info) => {
  const world = await seed(browser, info)
  try {
    const dialog = await shareWithMember(world, 'editor')

    // The member edits the deck live: their slide reaches the server.
    await world.member.goto(`/deck/${world.deckId}`)
    await expect(toolButtons(world.member).first()).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(() => world.member.evaluate(() => typeof window.__narrative_test_api), {
        timeout: 15_000,
      })
      .toBe('object')
    const before = await serverSlideCount(world)
    await world.member.evaluate(() => window.__narrative_test_api!.addSlide())
    await expect.poll(() => serverSlideCount(world), { timeout: 10_000 }).toBe(before + 1)

    // Removed: their open editor is disconnected and cannot get back in.
    await dialog.getByRole('button', { name: `Remove ${world.memberSub}` }).click()
    await expect(dialog.getByText(world.memberSub, { exact: true })).toHaveCount(0)
    await world.member.evaluate(() => window.__narrative_test_api!.addSlide())
    // An absence can only be watched for: give a write that would go through
    // ample time to arrive (it takes well under a second above), then check.
    await world.member.waitForTimeout(2_000)
    expect(await serverSlideCount(world)).toBe(before + 1)

    // The folder is gone from their list, and its page sends them home.
    await world.member.goto('/')
    await expect(world.member.getByText('Loading folders…')).toHaveCount(0)
    await expect(folderCard(world.member, world.folderName)).toHaveCount(0)
    await world.member.goto(`/folder/${world.folderId}`)
    await expect(world.member).toHaveURL(new RegExp(`${WEB_ORIGIN}/?$`))
  } finally {
    await cleanUp(world)
  }
})
