/**
 * e2e/render-export.spec.ts
 *
 * Slides rendered by the render worker (agentic A3,
 * docs/plans/a3-render-worker.md): `deck.exportPng` through the command API
 * (links and inline), the editor's "Export as PNG" on a slide, a render
 * right after an edit showing that edit — the worker reads the live document —
 * and the folder's fonts in the picture, set on a text box and on a run.
 * Needs the whole dev stack, the render worker included (`just dev`).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { PNG } from 'pngjs'

const API = 'http://localhost:3001'
const WEB_ORIGIN = 'http://localhost:5173'
const RED = { r: 0xe5, g: 0x39, b: 0x35 }
const GREEN = { r: 0x43, g: 0xa0, b: 0x47 }

/** Every letter a solid block (fixtures/make-block-font.py): no fallback face looks like it. */
const BLOCK_FONT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'block-font.ttf')

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
  commandId: string,
  input: unknown,
  target: Record<string, string> = { deckId },
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

/** A deck of two slides: a red block on the first, a text on the second. */
async function seedDeck(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${API}/decks`, { data: { title: 'e2e render export' } })
  expect(res.ok()).toBe(true)
  deckId = ((await res.json()) as { id: string }).id
  await command(request, 'object.create', {
    slide: { index: 0 },
    id: 'block',
    object: { type: 'rectangle', x: 200, y: 200, width: 400, height: 200, fill: '#E53935' },
  })
  await command(request, 'slide.add', {})
  await command(request, 'object.create', {
    slide: { index: 1 },
    object: {
      type: 'text',
      x: 200,
      y: 200,
      width: 900,
      height: 200,
      text: 'Second slide',
      fontSize: 96,
    },
  })
}

function pixelOf(png: PNG, x: number, y: number) {
  const i = (png.width * y + x) << 2
  return { r: png.data[i]!, g: png.data[i + 1]!, b: png.data[i + 2]! }
}

/** Dark pixels (drawn text) in a box, sampled every second pixel. */
function darkPixels(png: PNG, box: { x0: number; y0: number; x1: number; y1: number }): number {
  let dark = 0
  for (let y = box.y0; y < box.y1; y += 2)
    for (let x = box.x0; x < box.x1; x += 2) {
      const p = pixelOf(png, x, y)
      if (p.r + p.g + p.b < 200) dark += 1
    }
  return dark
}

const near = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) =>
  Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 24

interface Rendered {
  slideId: string
  index: number
  width: number
  height: number
  failedLoads: number
}

test('deck.exportPng renders every slide, as links and inline', async ({ request }) => {
  test.setTimeout(180_000)
  await seedDeck(request)

  const asLinks = await command<{ delivery: 'url'; slides: Array<Rendered & { url: string }> }>(
    request,
    'deck.exportPng',
    {},
  )
  expect(asLinks.slides.map((s) => s.index)).toEqual([0, 1])
  const first = await request.get(asLinks.slides[0]!.url)
  expect(first.ok()).toBe(true)
  const png = PNG.sync.read(await first.body())
  expect([png.width, png.height]).toEqual([1920, 1080])
  expect(near(pixelOf(png, 400, 300), RED)).toBe(true)
  expect(near(pixelOf(png, 1500, 800), { r: 255, g: 255, b: 255 })).toBe(true)

  // The second slide of the same job — the page switched to it in place: its
  // text is drawn, and the first slide's block is gone.
  const secondLink = await request.get(asLinks.slides[1]!.url)
  const second = PNG.sync.read(await secondLink.body())
  expect(darkPixels(second, { x0: 200, y0: 200, x1: 1100, y1: 400 })).toBeGreaterThan(100)
  expect(near(pixelOf(second, 400, 300), RED)).toBe(false)

  const inline = await command<{
    delivery: 'base64'
    slides: Array<Rendered & { base64: string }>
  }>(request, 'deck.exportPng', { slides: [{ index: 1 }], delivery: 'base64' })
  expect(inline.slides).toHaveLength(1)
  const inlinePng = PNG.sync.read(Buffer.from(inline.slides[0]!.base64, 'base64'))
  expect([inlinePng.width, inlinePng.height]).toEqual([1920, 1080])
  expect(darkPixels(inlinePng, { x0: 200, y0: 200, x1: 1100, y1: 400 })).toBeGreaterThan(100)
})

test('a render right after an edit shows the edit (the live document)', async ({ request }) => {
  test.setTimeout(180_000)
  await seedDeck(request)
  await command(request, 'object.update', {
    slide: { index: 0 },
    object: 'block',
    patch: { fill: '#43A047' },
  })
  const out = await command<{ delivery: 'base64'; slides: Array<{ base64: string }> }>(
    request,
    'deck.exportPng',
    { slides: [{ index: 0 }], delivery: 'base64' },
  )
  const png = PNG.sync.read(Buffer.from(out.slides[0]!.base64, 'base64'))
  expect(near(pixelOf(png, 400, 300), GREEN)).toBe(true)
})

test('an unknown slide is refused before anything renders', async ({ request }) => {
  test.setTimeout(60_000)
  await seedDeck(request)
  const res = await request.post(`${API}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target: { deckId }, command: 'deck.exportPng', input: { slides: ['no-such-slide'] } },
  })
  const body = (await res.json()) as { ok: boolean; error?: { code: string } }
  expect(body.ok).toBe(false)
  expect(body.error?.code).toBe('not_found')
})

/** A folder with the block font, and a deck in it: "Wide" in the font on a box and on a run, a red block. */
async function seedFontDeck(request: APIRequestContext): Promise<string> {
  folderId = (
    await command<{ id: string }>(
      request,
      'folder.create',
      { name: `e2e render fonts ${Date.now()}` },
      {},
    )
  ).id
  const { family } = await command<{ family: string }>(
    request,
    'folder.fonts.upload',
    { file: { base64: readFileSync(BLOCK_FONT).toString('base64'), filename: 'block-font.ttf' } },
    { folderId },
  )
  const res = await request.post(`${API}/decks`, {
    data: { title: 'e2e render fonts', folderId },
  })
  expect(res.ok()).toBe(true)
  deckId = ((await res.json()) as { id: string }).id
  // The whole box in the folder font…
  await command(request, 'object.create', {
    slide: { index: 0 },
    id: 'box',
    object: { type: 'text', x: 200, y: 150, width: 1000, height: 200, text: 'Wide', fontSize: 100 },
  })
  await command(request, 'text.setBoxTypography', {
    slide: { index: 0 },
    objects: ['box'],
    style: { fontFamily: family },
  })
  // …and one run of another box, as an imported deck has it (a family with
  // a space in its name: Pixi's own scan of the run markup never found it).
  await command(request, 'object.create', {
    slide: { index: 0 },
    id: 'runs',
    object: { type: 'text', x: 200, y: 550, width: 1000, height: 200, text: 'x', fontSize: 100 },
  })
  await command(request, 'text.set', {
    target: { slide: { index: 0 }, object: 'runs' },
    text: { paragraphs: [{ runs: [{ text: 'Run ' }, { text: 'Wide', fontFamily: family }] }] },
  })
  // …and a table cell (drawn by the same HTMLText, inside the table's node).
  const { objectId: table } = await command<{ objectId: string }>(request, 'table.insert', {
    slide: { index: 0 },
    x: 200,
    y: 820,
    width: 900,
    height: 200,
    rows: 1,
    cols: 1,
    defaults: { fontFamily: family, fontSize: 100 },
  })
  await command(request, 'text.set', {
    target: { slide: { index: 0 }, object: table, cell: { row: 0, col: 0 } },
    text: 'Wide',
  })
  await command(request, 'object.create', {
    slide: { index: 0 },
    object: { type: 'rectangle', x: 1300, y: 150, width: 300, height: 150, fill: '#E53935' },
  })
  return family
}

/** "Wide" in blocks: four solid 92×70 px rectangles — about 6,400 of the sampled pixels. */
function expectBlockText(png: PNG): void {
  expect(darkPixels(png, { x0: 200, y0: 150, x1: 1000, y1: 350 })).toBeGreaterThan(4_500)
  // The run: "Run " in the box's own face, then "Wide" in blocks.
  expect(darkPixels(png, { x0: 200, y0: 550, x1: 1200, y1: 750 })).toBeGreaterThan(4_500)
  // The table cell.
  expect(darkPixels(png, { x0: 200, y0: 820, x1: 1100, y1: 1020 })).toBeGreaterThan(4_500)
}

async function readDownload(download: import('@playwright/test').Download): Promise<PNG> {
  return PNG.sync.read(
    await new Promise<Buffer>((resolve, reject) => {
      void download.createReadStream().then((stream) => {
        const chunks: Buffer[] = []
        stream.on('data', (c: Buffer) => chunks.push(c))
        stream.on('end', () => resolve(Buffer.concat(chunks)))
        stream.on('error', reject)
      }, reject)
    }),
  )
}

async function exportFromMenu(page: import('@playwright/test').Page): Promise<PNG> {
  const firstSlide = page.locator('[role="option"][data-slide-id]').first()
  await firstSlide.click({ button: 'right' })
  const download = page.waitForEvent('download', { timeout: 120_000 })
  await page.getByRole('menuitem', { name: 'Export as PNG' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('e2e render fonts - slide 1.png')
  return readDownload(file)
}

test('the editor exports a slide in the browser: what it shows, edits of a moment ago and folder fonts included', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await seedFontDeck(page.request)
  const serverRenders: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/export.png')) serverRenders.push(req.url())
  })
  await page.goto(`/deck/${deckId}`)
  await expect(page.locator('[role="option"][data-slide-id]').first()).toBeVisible({
    timeout: 30_000,
  })
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')
  // An edit made in this editor a moment before the export.
  await page.evaluate(() =>
    window.__narrative_test_api!.addRect({
      id: 'fresh',
      x: 1300,
      y: 800,
      w: 300,
      h: 150,
      fill: 0x43a047,
    }),
  )

  const png = await exportFromMenu(page)
  expect([png.width, png.height]).toEqual([1920, 1080])
  expect(near(pixelOf(png, 1450, 225), RED)).toBe(true)
  expect(near(pixelOf(png, 1450, 875), GREEN)).toBe(true)
  expectBlockText(png)
  // Again: the hidden frame is reused, and still nothing went to the server.
  const again = await exportFromMenu(page)
  expect(near(pixelOf(again, 1450, 875), GREEN)).toBe(true)
  await expect(page.locator('iframe[title="Slide export"]')).toHaveCount(1)
  expect(serverRenders).toEqual([])
})

test('the editor falls back to the render worker when the browser cannot render', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await seedFontDeck(page.request)
  // The hidden frame's page cannot load here.
  await page.route('**/deck/*/render?*', (route) => route.abort())
  const serverRenders: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/export.png')) serverRenders.push(req.url())
  })
  await page.goto(`/deck/${deckId}`)
  await expect(page.locator('[role="option"][data-slide-id]').first()).toBeVisible({
    timeout: 30_000,
  })
  const png = await exportFromMenu(page)
  expect(serverRenders).toHaveLength(1)
  expect([png.width, png.height]).toEqual([1920, 1080])
  expect(near(pixelOf(png, 1450, 225), RED)).toBe(true)
  expectBlockText(png)
})

test('the render worker draws the folder fonts, set on a text box and on a run', async ({
  request,
}) => {
  test.setTimeout(180_000)
  await seedFontDeck(request)
  const out = await command<{
    delivery: 'base64'
    slides: Array<Rendered & { base64: string }>
    failedFonts: string[]
  }>(request, 'deck.exportPng', { slides: [{ index: 0 }], delivery: 'base64' })
  expect(out.failedFonts).toEqual([])
  expectBlockText(PNG.sync.read(Buffer.from(out.slides[0]!.base64, 'base64')))
})
