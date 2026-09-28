/**
 * e2e/object-clipboard.spec.ts
 *
 * Copy, cut and paste objects on the canvas, read back through the command
 * API (A2.7):
 *
 *   - copy → paste onto another slide of the same deck: `object.copyTo`, an
 *     exact copy (inline formatting included) moved 10, 10;
 *   - cut → paste: the sources are gone, so the paste recreates them from
 *     the clipboard's snapshot (`object.insert`);
 *   - paste into another deck: the server's `object.insertFromDeck`, which
 *     copies the picture into the target deck (media is deck-scoped — a
 *     pasted image used to keep the source deck's asset id and render
 *     broken there).
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

/** A 1×1 red PNG. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

type Obj = Record<string, unknown> & { id: string; type: string; x: number; y: number }

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

function objectsOn(request: APIRequestContext, deckId: string, index: number): Promise<Obj[]> {
  return command<{ objects: Obj[] }>(request, { deckId }, 'query.slide', {
    slide: { index },
  }).then((s) => s.objects)
}

/** Open a deck fitted to the screen; returns the viewport point of a slide point. */
async function openDeck(page: Page, deckId: string, slides: number) {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`/deck/${deckId}`)
  await expect(page.locator('[data-slide-index]')).toHaveCount(slides, { timeout: 30_000 })
  const artboard = page.locator('.artboard')
  await expect(artboard).toBeVisible()
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
  await page.getByRole('button', { name: 'Fit to screen' }).click()
  await page.waitForTimeout(400)
  const box = (await artboard.boundingBox())!
  return (x: number, y: number) => ({
    x: box.x + (x / 1920) * box.width,
    y: box.y + (y / 1080) * box.height,
  })
}

/** Go to slide `index` and give the canvas the keyboard (an empty spot). */
async function toSlide(
  page: Page,
  index: number,
  at: (x: number, y: number) => { x: number; y: number },
) {
  await page.locator('[data-slide-index]').nth(index).click()
  const empty = at(1800, 1000)
  await page.mouse.click(empty.x, empty.y)
}

/** A deck: slide 1 with a text box whose first word is italic, and an empty slide 2. */
async function deckWithText(request: APIRequestContext, title: string) {
  const { id: deckId } = await command<{ id: string }>(request, {}, 'deck.create', { title })
  await command(request, { deckId }, 'slide.add', {})
  const { objectId } = await command<{ objectId: string }>(request, { deckId }, 'object.create', {
    slide: { index: 0 },
    object: {
      type: 'text',
      x: 300,
      y: 300,
      width: 600,
      height: 120,
      fontSize: 48,
      text: { paragraphs: [{ runs: [{ text: 'Hello', italic: true }, { text: ' world' }] }] },
    },
  })
  return { deckId, objectId }
}

test('copy a formatted text box and paste it onto another slide', async ({ page }) => {
  const { deckId } = await deckWithText(page.request, `obj clip copy ${Date.now()}`)
  const at = await openDeck(page, deckId, 2)
  const text = at(600, 360)
  await page.mouse.click(text.x, text.y)
  await page.keyboard.press('ControlOrMeta+c')
  await toSlide(page, 1, at)
  await page.keyboard.press('ControlOrMeta+v')

  await expect.poll(async () => (await objectsOn(page.request, deckId, 1)).length).toBe(1)
  const [copy] = await objectsOn(page.request, deckId, 1)
  expect(copy).toMatchObject({ type: 'text', x: 310, y: 310, text: 'Hello world' })
  expect((copy!['paragraphs'] as Array<{ runs: unknown[] }>)[0]!.runs[0]).toMatchObject({
    text: 'Hello',
    italic: true,
  })
  // The source is still there.
  expect(await objectsOn(page.request, deckId, 0)).toHaveLength(1)
})

test('cut then paste recreates the objects from the clipboard', async ({ page }) => {
  const { deckId } = await deckWithText(page.request, `obj clip cut ${Date.now()}`)
  const at = await openDeck(page, deckId, 2)
  const text = at(600, 360)
  await page.mouse.click(text.x, text.y)
  await page.mouse.click(text.x, text.y, { button: 'right' })
  await page.getByRole('menuitem', { name: 'Cut' }).click()
  await expect.poll(async () => (await objectsOn(page.request, deckId, 0)).length).toBe(0)

  await toSlide(page, 1, at)
  await page.keyboard.press('ControlOrMeta+v')
  await expect.poll(async () => (await objectsOn(page.request, deckId, 1)).length).toBe(1)
  const [pasted] = await objectsOn(page.request, deckId, 1)
  expect(pasted).toMatchObject({ type: 'text', text: 'Hello world' })
  expect((pasted!['paragraphs'] as Array<{ runs: unknown[] }>)[0]!.runs[0]).toMatchObject({
    italic: true,
  })
})

test('an image pasted into another deck brings its picture along', async ({ page }) => {
  const { id: sourceId } = await command<{ id: string }>(page.request, {}, 'deck.create', {
    title: `obj clip source ${Date.now()}`,
  })
  const { assetId } = await command<{ assetId: string }>(
    page.request,
    { deckId: sourceId },
    'media.upload',
    {
      file: { base64: PNG_1PX, filename: 'red.png' },
    },
  )
  await command(page.request, { deckId: sourceId }, 'object.create', {
    slide: { index: 0 },
    object: { type: 'image', assetId, x: 400, y: 200, width: 400, height: 400 },
  })
  const { id: targetId } = await command<{ id: string }>(page.request, {}, 'deck.create', {
    title: `obj clip target ${Date.now()}`,
  })

  const atSource = await openDeck(page, sourceId, 1)
  const img = atSource(600, 400)
  await page.mouse.click(img.x, img.y)
  await page.keyboard.press('ControlOrMeta+c')

  const atTarget = await openDeck(page, targetId, 1)
  const empty = atTarget(1800, 1000)
  await page.mouse.click(empty.x, empty.y)
  await page.keyboard.press('ControlOrMeta+v')

  await expect.poll(async () => (await objectsOn(page.request, targetId, 0)).length).toBe(1)
  const [pasted] = await objectsOn(page.request, targetId, 0)
  expect(pasted).toMatchObject({ type: 'image', x: 410, y: 210 })
  // A copy of the picture, owned by the target deck.
  expect(pasted!['assetId']).not.toBe(assetId)
  // The target deck serves it (media.url refuses an asset of another deck).
  const media = await command<{ url: string }>(page.request, { deckId: targetId }, 'media.url', {
    assetId: pasted!['assetId'],
  })
  expect(media.url).toBeTruthy()
})
