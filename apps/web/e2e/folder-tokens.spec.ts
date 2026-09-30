/**
 * e2e/folder-tokens.spec.ts
 *
 * A folder's design tokens change on the server (A2.12): Folder Settings and
 * the Inspector's preset actions call the token routes, the server writes
 * the folder document and carries a text-style change into every deck of
 * the folder — the one open in another tab and the one nobody has open. The
 * editor itself writes no folder document. Results are read back through the
 * command API (`query.object`, `token.list`).
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

const BOX = { x: 300, y: 300, width: 1000, height: 200 }

interface TextView {
  fontSize?: number
  textStyleId?: string
  textStyleOverrides?: string[]
}
interface TextStyle {
  id: string
  name: string
  size?: number
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

const textOf = async (request: APIRequestContext, deckId: string, id: string) =>
  (
    await command<{ object: TextView }>(request, { deckId }, 'query.object', {
      slide: { index: 0 },
      object: id,
    })
  ).object

const stylesOf = async (request: APIRequestContext, folderId: string) =>
  (await command<{ textStyles: TextStyle[] }>(request, { folderId }, 'token.list', {})).textStyles

/** A deck in `folderId` with one text box (48 px), optionally linked to a text style by name. */
async function deckWithText(
  request: APIRequestContext,
  folderId: string,
  title: string,
  style?: string,
) {
  const { id: deckId } = await command<{ id: string }>(request, {}, 'deck.create', {
    title,
    folderId,
  })
  const { objectId } = await command<{ objectId: string }>(request, { deckId }, 'object.create', {
    slide: { index: 0 },
    object: { type: 'text', ...BOX, text: 'Quarterly results', fontSize: 48, fontWeight: 400 },
  })
  if (style !== undefined)
    await command(request, { deckId }, 'text.style.apply', {
      slide: { index: 0 },
      objects: [objectId],
      style,
    })
  return { deckId, objectId }
}

/** Open a deck at 1920 x 1080 and select `objectId`. */
async function openDeck(page: Page, deckId: string, objectId: string) {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`/deck/${deckId}`)
  await expect(page.locator('.artboard')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 15_000 })
    .toBe('object')
  await expect
    .poll(
      () =>
        page.evaluate((id) => window.__narrative_test_api!.sceneGraphHasMountedNode(id), objectId),
      { timeout: 8000 },
    )
    .toBe(true)
  await page.evaluate((id) => window.__narrative_test_api!.setSelection([id]), objectId)
}

test('a text style changed in Folder Settings reaches the open and the closed deck', async ({
  page,
  context,
}) => {
  const { id: folderId } = await command<{ id: string }>(page.request, {}, 'folder.create', {
    name: `Tokens e2e ${Date.now()}`,
  })
  const open = await deckWithText(page.request, folderId, 'open deck', 'Body')
  const closed = await deckWithText(page.request, folderId, 'closed deck', 'Body')
  const body = (await stylesOf(page.request, folderId)).find((s) => s.name === 'Body')!
  // A new folder comes with its default styles, seeded on the server.
  expect(body).toBeDefined()
  const target = (body.size ?? 24) + 7

  await openDeck(page, open.deckId, open.objectId)

  const settings = await context.newPage()
  await settings.goto(`/folder/${folderId}/settings?tab=textStyles`)
  await settings.getByRole('option', { name: /Body/ }).click()
  await settings.getByLabel('Font size').fill(String(target))

  await expect
    .poll(async () => (await textOf(page.request, open.deckId, open.objectId)).fontSize, {
      timeout: 15_000,
    })
    .toBe(target)
  await expect
    .poll(async () => (await textOf(page.request, closed.deckId, closed.objectId)).fontSize, {
      timeout: 15_000,
    })
    .toBe(target)
  // The style itself took the change.
  expect((await stylesOf(page.request, folderId)).find((s) => s.id === body.id)?.size).toBe(target)
})

test("the Inspector makes a style from a box and pushes the box's look into it", async ({
  page,
}) => {
  const { id: folderId } = await command<{ id: string }>(page.request, {}, 'folder.create', {
    name: `Presets e2e ${Date.now()}`,
  })
  const { deckId, objectId } = await deckWithText(page.request, folderId, 'preset deck')
  const other = await deckWithText(page.request, folderId, 'other deck')
  await openDeck(page, deckId, objectId)

  // Create new text style → the box is linked to it exactly.
  await page.getByRole('button', { name: 'Preset actions' }).click()
  await page.getByRole('menuitem', { name: 'Create new text style' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create new text style' })
  await dialog.locator('#new-preset-name').fill('Quote e2e')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  const quote = (await stylesOf(page.request, folderId)).find((s) => s.name === 'Quote e2e')!
  expect(quote).toMatchObject({ size: 48 })
  await expect
    .poll(async () => (await textOf(page.request, deckId, objectId)).textStyleId)
    .toBe(quote.id)

  // Another deck's box takes the style; then the first box is set by hand…
  await command(page.request, { deckId: other.deckId }, 'text.style.apply', {
    slide: { index: 0 },
    objects: [other.objectId],
    style: quote.id,
  })
  await command(page.request, { deckId }, 'text.setBoxTypography', {
    slide: { index: 0 },
    objects: [objectId],
    style: { fontSize: 60 },
  })
  await expect
    .poll(async () => (await textOf(page.request, deckId, objectId)).textStyleOverrides)
    .toEqual(['fontSize'])

  // …and Update preset makes that the style's, everywhere it is linked.
  await page.getByRole('button', { name: 'Preset actions' }).click()
  await page.getByRole('menuitem', { name: 'Update preset' }).click()
  await expect
    .poll(
      async () => (await stylesOf(page.request, folderId)).find((s) => s.id === quote.id)?.size,
      {
        timeout: 15_000,
      },
    )
    .toBe(60)
  await expect
    .poll(async () => (await textOf(page.request, other.deckId, other.objectId)).fontSize, {
      timeout: 15_000,
    })
    .toBe(60)
  // The box matches its style exactly again.
  await expect
    .poll(async () => (await textOf(page.request, deckId, objectId)).textStyleOverrides ?? [])
    .toEqual([])
})
