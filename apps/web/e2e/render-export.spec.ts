/**
 * e2e/render-export.spec.ts
 *
 * Slides rendered by the render worker (agentic A3,
 * docs/plans/a3-render-worker.md): `deck.exportPng` through the command API
 * (links and inline), the editor's "Export as PNG" on a slide, and a render
 * right after an edit showing that edit — the worker reads the live document.
 * Needs the whole dev stack, the render worker included (`just dev`).
 */

import { test, expect, type APIRequestContext } from '@playwright/test'
import { PNG } from 'pngjs'

const API = 'http://localhost:3001'
const WEB_ORIGIN = 'http://localhost:5173'
const RED = { r: 0xe5, g: 0x39, b: 0x35 }
const GREEN = { r: 0x43, g: 0xa0, b: 0x47 }

let deckId = ''

test.afterEach(async ({ request }) => {
  if (deckId !== '') await request.delete(`${API}/decks/${deckId}`).catch(() => undefined)
  deckId = ''
})

async function command<T>(
  request: APIRequestContext,
  commandId: string,
  input: unknown,
): Promise<T> {
  const res = await request.post(`${API}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target: { deckId }, command: commandId, input },
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

test('the editor exports a slide as a PNG from its menu', async ({ page }) => {
  test.setTimeout(180_000)
  await seedDeck(page.request)
  await page.goto(`/deck/${deckId}`)
  const firstSlide = page.locator('[role="option"][data-slide-id]').first()
  await expect(firstSlide).toBeVisible({ timeout: 30_000 })
  await firstSlide.click({ button: 'right' })
  const download = page.waitForEvent('download', { timeout: 120_000 })
  await page.getByRole('menuitem', { name: 'Export as PNG' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('e2e render export - slide 1.png')
  const png = PNG.sync.read(
    await new Promise<Buffer>((resolve, reject) => {
      void file.createReadStream().then((stream) => {
        const chunks: Buffer[] = []
        stream.on('data', (c: Buffer) => chunks.push(c))
        stream.on('end', () => resolve(Buffer.concat(chunks)))
        stream.on('error', reject)
      }, reject)
    }),
  )
  expect([png.width, png.height]).toEqual([1920, 1080])
  expect(near(pixelOf(png, 400, 300), RED)).toBe(true)
})
