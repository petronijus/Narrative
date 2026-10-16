/**
 * e2e/slide-clipboard.spec.ts
 *
 * Copy slides in the slides panel and paste them — into the same deck and
 * into another one.
 *
 * Pasting into another deck used to rebuild the slides from a JSON snapshot
 * in the browser, which kept the source deck's asset ids: media is
 * deck-scoped, so a pasted image pointed at an asset the target deck does
 * not own and rendered broken. Paste now goes through the server's slide
 * insert (`deck.insertFrom`'s deck source), which copies the media into the
 * target deck; within one deck it is `slide.copyTo`, whole slides in one
 * undo step. Both are read back through the command API.
 */

import { test, expect, type APIRequestContext, type Page } from './fixtures/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

/** A 1×1 red PNG. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

/** Run one command through the command API as the (BYPASS_AUTH) dev user. */
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

interface SlideView {
  id: string
  name?: string
  objects: Array<{ id: string; type: string; assetId?: string }>
}

/** A deck whose first slide ("With image") shows an uploaded image. */
async function deckWithImage(
  request: APIRequestContext,
  title: string,
): Promise<{ deckId: string; assetId: string }> {
  const { id: deckId } = await command<{ id: string }>(request, {}, 'deck.create', { title })
  const { assetId } = await command<{ assetId: string }>(request, { deckId }, 'media.upload', {
    file: { base64: PNG_1PX, filename: 'red.png' },
  })
  await command(request, { deckId }, 'object.create', {
    slide: { index: 0 },
    object: { type: 'image', assetId, x: 100, y: 100, width: 400, height: 400 },
  })
  await command(request, { deckId }, 'slide.rename', { slide: { index: 0 }, name: 'With image' })
  return { deckId, assetId }
}

async function openDeck(page: Page, deckId: string, slides: number): Promise<void> {
  await page.goto(`/deck/${deckId}`)
  await expect(page.locator('[data-slide-index]')).toHaveCount(slides, { timeout: 30_000 })
}

async function rowMenu(page: Page, index: number, item: 'Copy slide' | 'Paste slide') {
  await page.locator('[data-slide-index]').nth(index).click({ button: 'right' })
  await page.getByRole('menuitem', { name: item }).click()
}

function readSlide(request: APIRequestContext, deckId: string, index: number) {
  return command<SlideView>(request, { deckId }, 'query.slide', { slide: { index } })
}

test('a slide pasted into another deck brings its image along', async ({ page }) => {
  const source = await deckWithImage(page.request, `clipboard source ${Date.now()}`)
  const { id: targetId } = await command<{ id: string }>(page.request, {}, 'deck.create', {
    title: `clipboard target ${Date.now()}`,
  })

  await openDeck(page, source.deckId, 1)
  await rowMenu(page, 0, 'Copy slide')

  await openDeck(page, targetId, 1)
  await rowMenu(page, 0, 'Paste slide')
  await expect(page.locator('[data-slide-index]')).toHaveCount(2, { timeout: 30_000 })

  const pasted = await readSlide(page.request, targetId, 1)
  expect(pasted.name).toBe('With image')
  const image = pasted.objects.find((o) => o.type === 'image')
  expect(image?.assetId).toBeDefined()
  // A copy of the asset, owned by the target deck: its URL resolves there.
  expect(image!.assetId).not.toBe(source.assetId)
  const { url } = await command<{ url: string }>(page.request, { deckId: targetId }, 'media.url', {
    assetId: image!.assetId,
  })
  expect(url).toMatch(/^https?:\/\//)
})

test('a slide pasted into its own deck is a whole copy after the target row', async ({ page }) => {
  const deck = await deckWithImage(page.request, `clipboard same ${Date.now()}`)
  await command(page.request, { deckId: deck.deckId }, 'slide.add', {})

  await openDeck(page, deck.deckId, 2)
  await rowMenu(page, 0, 'Copy slide')
  await rowMenu(page, 1, 'Paste slide')
  await expect(page.locator('[data-slide-index]')).toHaveCount(3, { timeout: 15_000 })

  const original = await readSlide(page.request, deck.deckId, 0)
  const copy = await readSlide(page.request, deck.deckId, 2)
  expect(copy.id).not.toBe(original.id)
  expect(copy.name).toBe('With image')
  // Same objects, same ids (Magic Move pairs them), same asset — same deck.
  expect(copy.objects).toEqual(original.objects)
})
