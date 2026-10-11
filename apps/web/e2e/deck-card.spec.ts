/**
 * e2e/deck-card.spec.ts
 *
 * A deck's card on the folder page drawn by the render worker (agentic
 * A3.5, docs/plans/a3-render-worker.md): on request (`deck.refreshThumbnail`)
 * and by itself after changes to a deck nobody has open — the agent's
 * writes here go through the command API, with no editor connected
 * (services/deckThumbnails.ts; the server waits until the deck has been
 * quiet for 10 s, and draws one deck at most once a minute — the second
 * test waits for that minute). Checked where a person sees it: the card's picture on the
 * folder page. Needs the whole dev stack, the render worker included
 * (`just dev`).
 *
 * Each test acts as a person of its own (the `narrative_dev_as` cookie, one
 * per parallel slot): background cards take turns by owner, and every other
 * spec's decks belong to `dev-user` — so this one's card is drawn next, not
 * after theirs. That is the fairness the scheduler promises, too.
 */

import {
  test,
  expect,
  type APIRequestContext,
  type Browser,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { PNG } from 'pngjs'

const API = 'http://localhost:3001'
const WEB_ORIGIN = 'http://localhost:5173'
const RED = { r: 0xe5, g: 0x39, b: 0x35 }
const GREEN = { r: 0x43, g: 0xa0, b: 0x47 }
const WHITE = { r: 255, g: 255, b: 255 }

let deckId = ''
let folderId = ''
let owner: Page | null = null

/** A browser context signed in as this slot's own person. */
async function personPage(browser: Browser, info: TestInfo): Promise<Page> {
  const context = await browser.newContext()
  await context.addCookies([
    {
      name: 'narrative_dev_as',
      value: `dev-e2e-card-owner-${info.parallelIndex}`,
      domain: 'localhost',
      path: '/',
    },
  ])
  owner = await context.newPage()
  return owner
}

test.afterEach(async () => {
  const request = owner?.request
  if (request !== undefined) {
    if (deckId !== '') await request.delete(`${API}/decks/${deckId}`).catch(() => undefined)
    if (folderId !== '') await request.delete(`${API}/folders/${folderId}`).catch(() => undefined)
  }
  await owner?.context().close()
  owner = null
  deckId = ''
  folderId = ''
})

async function command<T>(
  request: APIRequestContext,
  target: Record<string, string>,
  commandId: string,
  input: unknown,
): Promise<T> {
  const res = await request.post(`${API}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target, command: commandId, input },
    timeout: 120_000,
  })
  const body = (await res.json()) as { ok: boolean; result: T; error?: { message: string } }
  expect(body.ok, `${commandId}: ${body.error?.message}`).toBe(true)
  return body.result
}

/** A folder of its own, and a deck in it whose first slide is red on the left half, with a caption. */
async function seedDeck(request: APIRequestContext, name: string): Promise<void> {
  folderId = (
    await command<{ id: string }>(request, {}, 'folder.create', {
      name: `e2e deck card ${name} ${Date.now()}`,
    })
  ).id
  const res = await request.post(`${API}/decks`, {
    data: { title: `e2e deck card ${name}`, folderId },
  })
  expect(res.ok()).toBe(true)
  deckId = ((await res.json()) as { id: string }).id
  await command(request, { deckId }, 'object.create', {
    slide: { index: 0 },
    id: 'half',
    object: { type: 'rectangle', x: 0, y: 0, width: 960, height: 1080, fill: '#E53935' },
  })
  // Text on the card's slide: its body is a Y.Text the server hashes.
  await command(request, { deckId }, 'object.create', {
    slide: { index: 0 },
    object: { type: 'text', x: 1100, y: 900, width: 700, height: 120, text: 'Card', fontSize: 72 },
  })
}

interface DeckRow {
  thumbnailUrl: string | null
  thumbnailUpdatedAt: string | null
}

async function deckRow(request: APIRequestContext): Promise<DeckRow> {
  const res = await request.get(`${API}/decks/${deckId}`)
  expect(res.ok()).toBe(true)
  return (await res.json()) as DeckRow
}

const near = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) =>
  // The card comes through imgproxy as a JPEG.
  Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 48

/** The deck's card on its folder page: the colours at a quarter and three quarters across. */
async function cardColours(page: Page) {
  await page.goto(`/folder/${folderId}`)
  // Each picture has a key of its own (`thumb-<random>.png`).
  const card = page.locator(`img[src*="decks/${deckId}/thumb-"]`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => card.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(400)
  const png = PNG.sync.read(await card.screenshot())
  const at = (fx: number) => {
    const i = (png.width * Math.round(png.height / 2) + Math.round(png.width * fx)) << 2
    return { r: png.data[i]!, g: png.data[i + 1]!, b: png.data[i + 2]! }
  }
  return { left: at(0.25), right: at(0.75) }
}

test('the agent redraws a deck’s card from its first slide', async ({ browser }, info) => {
  test.setTimeout(120_000)
  const page = await personPage(browser, info)
  const request = page.request
  await seedDeck(request, 'refresh')
  const result = await command<{ thumbnailUrl: string; updatedAt: string }>(
    request,
    { deckId },
    'deck.refreshThumbnail',
    {},
  )
  expect(result.thumbnailUrl).toMatch(new RegExp(`decks/${deckId}/thumb-[\\w-]{12}\\.png`))
  expect((await deckRow(request)).thumbnailUpdatedAt).toBe(result.updatedAt)
  const { left, right } = await cardColours(page)
  expect(near(left, RED), JSON.stringify(left)).toBe(true)
  expect(near(right, WHITE), JSON.stringify(right)).toBe(true)
})

test('a deck nobody has open gets its card after a change, and a new one after the next', async ({
  browser,
}, info) => {
  test.setTimeout(200_000)
  const page = await personPage(browser, info)
  const request = page.request
  await seedDeck(request, 'background')
  // Quiet for 10 s, then drawn.
  await expect
    .poll(async () => (await deckRow(request)).thumbnailUrl, { timeout: 45_000 })
    .not.toBeNull()
  const first = await deckRow(request)
  expect(near((await cardColours(page)).left, RED)).toBe(true)

  await command(request, { deckId }, 'object.update', {
    slide: { index: 0 },
    object: 'half',
    patch: { fill: '#43A047' },
  })
  // At most once a minute per deck: up to a minute from the first card.
  await expect
    .poll(async () => (await deckRow(request)).thumbnailUpdatedAt, { timeout: 100_000 })
    .not.toBe(first.thumbnailUpdatedAt)
  const { left } = await cardColours(page)
  expect(near(left, GREEN), JSON.stringify(left)).toBe(true)
})
