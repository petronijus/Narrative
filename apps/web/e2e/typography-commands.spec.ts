/**
 * e2e/typography-commands.spec.ts
 *
 * The Inspector's text and slide controls with real clicks and keys (A2.11):
 * a Typography change goes to the selected part of the text being edited
 * (`text.format`) or to the whole box (`text.setBoxTypography`, which also
 * clears the inline formatting that would hide it and keeps the weight on a
 * cut a new family has); list controls act on the caret's paragraph
 * (`text.list`); the slide's transition and background are
 * `slide.setTransition` / `slide.setBackground`, and an image background is
 * written only once a picture is chosen. Results are read back through the
 * command API.
 */

import { test, expect, type APIRequestContext, type Page } from './fixtures/test'
import { caret } from './fixtures/keys.js'
import { PNG } from 'pngjs'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

const BOX = { x: 300, y: 300, width: 1000, height: 200 }

interface Run {
  text: string
  fontWeight?: number
  italic?: boolean
}
interface Paragraph {
  runs: Run[]
  list?: string
}
interface TextView {
  text: string
  paragraphs?: Paragraph[]
  fontWeight?: number | string
  fontFamily?: string
  italic?: boolean
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

const slideOf = (request: APIRequestContext, deckId: string) =>
  command<{ transition: { kind: string }; background: Record<string, unknown> | null }>(
    request,
    { deckId },
    'query.slide',
    { slide: { index: 0 } },
  )

/**
 * A deck with one text box, opened at 1920 x 1080 and fitted; the box is
 * selected. `body` is what text.set writes into it.
 */
async function openText(page: Page, title: string, body: unknown) {
  const { id: deckId } = await command<{ id: string }>(page.request, {}, 'deck.create', { title })
  const { objectId } = await command<{ objectId: string }>(
    page.request,
    { deckId },
    'object.create',
    {
      slide: { index: 0 },
      object: { type: 'text', ...BOX, text: 'x', fontSize: 48, fontWeight: 400 },
    },
  )
  await command(page.request, { deckId }, 'text.set', {
    target: { slide: { index: 0 }, object: objectId },
    text: body,
  })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`/deck/${deckId}`)
  const artboard = page.locator('.artboard')
  await expect(artboard).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
  await page.getByRole('button', { name: 'Fit to screen' }).click()
  await page.waitForTimeout(400)
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
  const box = (await artboard.boundingBox())!
  const scale = box.width / 1920
  const centre = {
    x: box.x + (BOX.x + BOX.width / 2) * scale,
    y: box.y + (BOX.y + BOX.height / 2) * scale,
  }
  return { deckId, objectId, centre }
}

const editor = (page: Page) => page.locator('[contenteditable="true"]').first()

/**
 * Let the editor publish a caret moved from the keyboard: `selectionchange`
 * arrives as a task after the key, and an Inspector control used within
 * the same frame (as automation can, a person cannot) would still see the
 * previous caret.
 */
async function settleSelection(page: Page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
}

/** Double-click into the box and put the caret at the very start. */
async function editFromStart(page: Page, centre: { x: number; y: number }) {
  await page.mouse.dblclick(centre.x, centre.y)
  await expect(editor(page)).toBeFocused()
  await page.keyboard.press(caret.textStart)
  await settleSelection(page)
}

test('Bold with the box selected sets the box weight and clears inline bold', async ({ page }) => {
  const { deckId, objectId } = await openText(page, `typography box ${Date.now()}`, {
    paragraphs: [{ runs: [{ text: 'Quarterly ' }, { text: 'results', bold: true }] }],
  })
  await page.getByTitle('Bold', { exact: true }).click()
  await expect.poll(async () => (await textOf(page.request, deckId, objectId)).fontWeight).toBe(700)
  // No inline formatting left: the body reads as plain text.
  expect((await textOf(page.request, deckId, objectId)).paragraphs).toBeUndefined()
})

test('Italic with a word selected formats only that word', async ({ page }) => {
  const { deckId, objectId, centre } = await openText(
    page,
    `typography inline ${Date.now()}`,
    'Quarterly results',
  )
  await editFromStart(page, centre)
  for (let i = 0; i < 'Quarterly'.length; i++) await page.keyboard.press('Shift+ArrowRight')
  await settleSelection(page)
  await page.getByTitle('Italic', { exact: true }).click()
  await expect
    .poll(async () => (await textOf(page.request, deckId, objectId)).paragraphs?.[0]?.runs)
    .toEqual([{ text: 'Quarterly', italic: true }, { text: ' results' }])
  expect((await textOf(page.request, deckId, objectId)).italic).toBeFalsy()
})

test('switching family keeps the weight on a cut the family has', async ({ page }) => {
  const { deckId, objectId } = await openText(page, `typography family ${Date.now()}`, 'Heading')
  await page.locator(`#inspector-fontweight-${objectId}`).selectOption('300')
  await expect.poll(async () => (await textOf(page.request, deckId, objectId)).fontWeight).toBe(300)
  // Georgia has 400 and 700: the browser would show 400 for 300, so that is stored.
  await page
    .locator(`#inspector-fontfamily-${objectId}`)
    .selectOption("Georgia, 'Times New Roman', serif")
  await expect
    .poll(async () => {
      const t = await textOf(page.request, deckId, objectId)
      return [t.fontFamily, t.fontWeight]
    })
    .toEqual(["Georgia, 'Times New Roman', serif", 400])
})

test("the list picker turns only the caret's paragraph into a list", async ({ page }) => {
  const { deckId, objectId, centre } = await openText(
    page,
    `typography list ${Date.now()}`,
    'One\n\nTwo',
  )
  await editFromStart(page, centre)
  await page.getByTitle('List style').selectOption('bullet')
  await expect
    .poll(async () =>
      ((await textOf(page.request, deckId, objectId)).paragraphs ?? []).map((p) => p.list),
    )
    .toEqual(['bullet', undefined])
})

/** A small solid-colour PNG to upload. */
function solidPng(): Buffer {
  const png = new PNG({ width: 16, height: 16 })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200
    png.data[i + 1] = 60
    png.data[i + 2] = 40
    png.data[i + 3] = 255
  }
  return PNG.sync.write(png)
}

test('slide transition, and an image background written once the picture is chosen', async ({
  page,
}) => {
  const { deckId } = await openText(page, `slide settings ${Date.now()}`, 'Title')
  await page.evaluate(() => window.__narrative_test_api!.setSelection([]))
  const kind = page.locator('[id^="transition-kind-"]')
  await expect(kind).toBeVisible()
  await kind.selectOption('fade')
  await expect.poll(async () => (await slideOf(page.request, deckId)).transition.kind).toBe('fade')

  await page.getByLabel('Background type').selectOption('image')
  await expect(page.getByText('Choose image…')).toBeVisible()
  expect((await slideOf(page.request, deckId)).background).toBeNull()
  await page
    .locator('input[type="file"][accept="image/*"]')
    .last()
    .setInputFiles({ name: 'bg.png', mimeType: 'image/png', buffer: solidPng() })
  await expect
    .poll(async () => (await slideOf(page.request, deckId)).background, { timeout: 20_000 })
    .toMatchObject({ kind: 'image', fit: 'cover', assetId: expect.stringMatching(/.+/) })
})
