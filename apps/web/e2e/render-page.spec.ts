/**
 * e2e/render-page.spec.ts
 *
 * The page the render worker screenshots (agentic A3,
 * docs/plans/a3-render-worker.md): `/deck/:id/render?slide=` paints one slide
 * of the live deck at 1920×1080, reports `ready` only once it is settled,
 * resolves `?slide=` by id or index, and never shows up as a collaborator in
 * the deck's editors.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { uploadTestPicture } from './fixtures/media.js'

const API = 'http://localhost:3001'
const RED = { r: 0xe5, g: 0x39, b: 0x35 }
const BLUE = { r: 0x1e, g: 0x88, b: 0xe5 }

test.use({ viewport: { width: 1920, height: 1080 } })

const WEB_ORIGIN = 'http://localhost:5173'
const FONT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codicon.ttf')

let deckId = ''
let folderId = ''

test.afterEach(async ({ request }) => {
  if (deckId !== '') await request.delete(`${API}/decks/${deckId}`).catch(() => undefined)
  if (folderId !== '') await request.delete(`${API}/folders/${folderId}`).catch(() => undefined)
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
  })
  const body = (await res.json()) as { ok: boolean; result: T; error?: { message: string } }
  expect(body.ok, `${commandId}: ${body.error?.message}`).toBe(true)
  return body.result
}

/** A deck of two slides: a red block on the first, a blue block and a text on the second. */
async function seedDeck(page: Page): Promise<{ firstSlideId: string; secondSlideId: string }> {
  const res = await page.request.post(`${API}/decks`, { data: { title: 'e2e render page' } })
  expect(res.ok()).toBe(true)
  deckId = ((await res.json()) as { id: string }).id
  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')
  const ids = await page.evaluate(
    ({ red, blue }) => {
      const api = window.__narrative_test_api!
      const firstSlideId = api.listSlideIds()[0]!
      api.addRect({ id: 'red-block', x: 200, y: 200, w: 400, h: 200, fill: red }, firstSlideId)
      const secondSlideId = api.addSlide()
      api.addRect({ id: 'blue-block', x: 1200, y: 700, w: 300, h: 200, fill: blue }, secondSlideId)
      api.addText(
        { id: 'caption', x: 200, y: 200, w: 800, h: 120, text: 'Rendered' },
        secondSlideId,
      )
      return { firstSlideId, secondSlideId }
    },
    { red: (RED.r << 16) | (RED.g << 8) | RED.b, blue: (BLUE.r << 16) | (BLUE.g << 8) | BLUE.b },
  )
  return ids
}

async function openRender(page: Page, slide?: string): Promise<void> {
  const query = slide === undefined ? '' : `?slide=${encodeURIComponent(slide)}`
  await page.goto(`/deck/${deckId}/render${query}`)
  await expect(page.locator('html')).toHaveAttribute('data-render-status', /^(ready|error)$/, {
    timeout: 45_000,
  })
}

async function pixel(
  page: Page,
  x: number,
  y: number,
): Promise<{ r: number; g: number; b: number }> {
  const png = PNG.sync.read(await page.getByTestId('render-slide').screenshot())
  expect([png.width, png.height]).toEqual([1920, 1080])
  const i = (png.width * y + x) << 2
  return { r: png.data[i]!, g: png.data[i + 1]!, b: png.data[i + 2]! }
}

const near = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) =>
  Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 24

test('paints the requested slide and reports it settled', async ({ page, context }) => {
  test.setTimeout(120_000)
  await seedDeck(page)
  const render = await context.newPage()
  await openRender(render, '1')

  const status = await render.evaluate(() => window.__narrativeRender)
  expect(status?.status).toBe('ready')
  if (status?.status !== 'ready') return
  expect(status.slideIndex).toBe(1)
  expect(status.settle.settled).toBe(true)

  expect(near(await pixel(render, 1350, 800), BLUE)).toBe(true)
  // The first slide's block is not on this one.
  expect(near(await pixel(render, 400, 300), RED)).toBe(false)
  // No editor chrome over the slide.
  await expect(render.getByRole('button', { name: /theme/i })).toHaveCount(0)
})

test('waits for the pictures, the text and the folder fonts before it reports ready', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  // A folder of its own with one uploaded face, and a deck in it.
  folderId = (
    await command<{ id: string }>(page.request, {}, 'folder.create', {
      name: `e2e render page ${Date.now()}`,
    })
  ).id
  const { family } = await command<{ family: string }>(
    page.request,
    { folderId },
    'folder.fonts.upload',
    { file: { base64: readFileSync(FONT).toString('base64'), filename: 'codicon.ttf' } },
  )
  const res = await page.request.post(`${API}/decks`, {
    data: { title: 'e2e render page media', folderId },
  })
  expect(res.ok()).toBe(true)
  deckId = ((await res.json()) as { id: string }).id
  const assetId = await uploadTestPicture(page.request, deckId)

  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')
  await page.evaluate(
    ({ assetId }) => {
      const api = window.__narrative_test_api!
      // A 1×1 red picture stretched over a block, and a text box.
      api.addImage({ id: 'picture', assetId, x: 1000, y: 600, w: 400, h: 200 })
      api.addText({ id: 'caption', x: 200, y: 200, w: 800, h: 160, text: 'Rendered', fontSize: 96 })
    },
    { assetId },
  )

  const render = await context.newPage()
  await openRender(render)
  const status = await render.evaluate(() => window.__narrativeRender)
  expect(status).toMatchObject({ status: 'ready', settle: { settled: true, failedLoads: 0 } })

  // The picture is on the canvas, not its grey placeholder.
  expect(near(await pixel(render, 1200, 700), { r: 255, g: 0, b: 0 })).toBe(true)
  // The text is drawn: dark pixels inside its box.
  const png = PNG.sync.read(await render.getByTestId('render-slide').screenshot())
  let dark = 0
  for (let y = 200; y < 360; y += 2)
    for (let x = 200; x < 1000; x += 2) {
      const i = (png.width * y + x) << 2
      if (png.data[i]! + png.data[i + 1]! + png.data[i + 2]! < 200) dark += 1
    }
  expect(dark).toBeGreaterThan(100)
  // The folder's face was loaded before the page called the slide ready.
  const faces = await render.evaluate(() =>
    [...document.fonts].map((f) => ({ family: f.family.replace(/"/g, ''), status: f.status })),
  )
  expect(faces).toContainEqual({ family, status: 'loaded' })
})

test('resolves ?slide= by id, defaults to the first slide, and reports an unknown slide', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  const { secondSlideId } = await seedDeck(page)
  // The seeding editor stays open: leaving it at once could drop edits still
  // on their way to the server.
  const render = await context.newPage()

  await openRender(render)
  const first = await render.evaluate(() => window.__narrativeRender)
  expect(first?.status === 'ready' && first.slideIndex).toBe(0)
  expect(near(await pixel(render, 400, 300), RED)).toBe(true)

  await openRender(render, secondSlideId)
  const second = await render.evaluate(() => window.__narrativeRender)
  expect(second?.status === 'ready' && second.slideId).toBe(secondSlideId)

  await openRender(render, 'no-such-slide')
  const missing = await render.evaluate(() => window.__narrativeRender)
  expect(missing).toMatchObject({ status: 'error', reason: 'slide-not-found' })
})

/** A render token for the current deck, minted as the server mints one for a render job (dev only). */
async function renderToken(request: APIRequestContext, forDeck: string): Promise<string> {
  const res = await request.post(`${API}/dev/render-token`, { data: { deckId: forDeck } })
  expect(res.ok(), `POST /dev/render-token: ${res.status()}`).toBe(true)
  return ((await res.json()) as { token: string }).token
}

test('opened with a render token, as the worker does: paints, and never shows as a collaborator', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await seedDeck(page)
  const collaborators = page
    .getByRole('list', { name: 'Connected collaborators' })
    .getByRole('listitem')
  const before = await collaborators.count()

  const token = await renderToken(page.request, deckId)
  const render = await context.newPage()
  await render.goto(`/deck/${deckId}/render?slide=1&share_token=${token}`)
  await expect(render.locator('html')).toHaveAttribute('data-render-status', 'ready', {
    timeout: 45_000,
  })
  expect(near(await pixel(render, 1350, 800), BLUE)).toBe(true)
  // Awareness travels within a second; give it three.
  await page.waitForTimeout(3_000)
  await expect(collaborators).toHaveCount(before)

  // Control: a second editor does appear, so the count above means something.
  const editor = await context.newPage()
  await editor.goto(`/deck/${deckId}`)
  await expect(collaborators).toHaveCount(before + 1, { timeout: 15_000 })
})

test('a render token for another deck is refused, and the page says so', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await seedDeck(page)
  const other = await page.request.post(`${API}/decks`, { data: { title: 'e2e render other' } })
  const otherId = ((await other.json()) as { id: string }).id
  try {
    const token = await renderToken(page.request, otherId)
    const render = await context.newPage()
    await render.goto(`/deck/${deckId}/render?share_token=${token}`)
    await expect(render.locator('html')).toHaveAttribute('data-render-status', 'error', {
      timeout: 45_000,
    })
    expect(await render.evaluate(() => window.__narrativeRender)).toMatchObject({
      status: 'error',
      reason: 'access-refused',
    })
    // The refused socket retries; close it before it counts against the
    // WebSocket's per-IP failed-authentication limit for the other specs.
    await render.close()
  } finally {
    await page.request.delete(`${API}/decks/${otherId}`).catch(() => undefined)
  }
})
