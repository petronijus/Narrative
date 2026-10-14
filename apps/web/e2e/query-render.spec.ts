/**
 * e2e/query-render.spec.ts
 *
 * `query.render` — the agent looks at slides (agentic A3.4,
 * docs/plans/a3-render-worker.md) — through the command API, against the
 * render worker: a slide downscaled to what a model reads, a region at full
 * resolution, a numbered contact sheet, and a look right after an edit
 * showing that edit (the worker's page waits for the live state, also when
 * it is a page kept from the previous look); a compare of a slide before
 * the run that changed it and now (A3.6: the "before" drawn on a frozen
 * page); the text boxes whose text overflows, measured with the real fonts, and a box sized exactly to
 * its text (150% and 80% line spacing) reported as fitting; a picture's `focus` (A5.1) choosing
 * which band of it covers a frame of another shape. Needs the whole dev stack, the
 * render worker included (`just dev`).
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

async function command<T>(request: APIRequestContext, id: string, input: unknown): Promise<T> {
  const res = await request.post(`${API}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target: { deckId }, command: id, input },
    timeout: 120_000,
  })
  const body = (await res.json()) as { ok: boolean; result: T; error?: { message: string } }
  expect(body.ok, `${id}: ${body.error?.message}`).toBe(true)
  return body.result
}

interface Look {
  mode: string
  width: number
  height: number
  slides: Array<{ slideId: string; index: number; failedLoads: number }>
  overflow: Array<{
    slideId: string
    index: number
    objectId: string
    boxHeight: number
    textHeight: number
  }>
  newSlide?: boolean
  failedFonts: string[]
  image: { mimeType: string; base64: string }
}

const look = async (request: APIRequestContext, input: unknown) => {
  const out = await command<Look>(request, 'query.render', input)
  expect(out.image.mimeType).toBe('image/png')
  const png = PNG.sync.read(Buffer.from(out.image.base64, 'base64'))
  expect([png.width, png.height]).toEqual([out.width, out.height])
  return { out, png }
}

function pixelOf(png: PNG, x: number, y: number) {
  const i = (png.width * Math.round(y) + Math.round(x)) << 2
  return { r: png.data[i]!, g: png.data[i + 1]!, b: png.data[i + 2]! }
}

const near = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) =>
  Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 24

/** Two slides: a red block on the first (200,200 400×200), a text on the second. */
async function seedDeck(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${API}/decks`, { data: { title: 'e2e query render' } })
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
    object: { type: 'text', x: 200, y: 200, width: 900, height: 200, text: 'Second', fontSize: 96 },
  })
}

test('the agent sees a slide, downscaled to what a model reads', async ({ request }) => {
  test.setTimeout(120_000)
  await seedDeck(request)
  const { out, png } = await look(request, { slide: { index: 0 } })
  expect(out).toMatchObject({
    mode: 'slide',
    width: 1430,
    height: 804,
    slides: [{ index: 0, failedLoads: 0 }],
    failedFonts: [],
  })
  const scale = 1430 / 1920
  expect(near(pixelOf(png, 400 * scale, 300 * scale), RED)).toBe(true)
  expect(near(pixelOf(png, 1500 * scale, 800 * scale), { r: 255, g: 255, b: 255 })).toBe(true)
})

test('a region comes at full resolution', async ({ request }) => {
  test.setTimeout(120_000)
  await seedDeck(request)
  const { out, png } = await look(request, {
    slide: { index: 0 },
    region: { x: 150, y: 150, width: 300, height: 100 },
  })
  expect(out).toMatchObject({ mode: 'region', width: 300, height: 100 })
  // The block's corner at (200, 200) is at (50, 50) of the crop, 1:1.
  expect(near(pixelOf(png, 10, 10), { r: 255, g: 255, b: 255 })).toBe(true)
  expect(near(pixelOf(png, 60, 60), RED)).toBe(true)
  expect(near(pixelOf(png, 40, 60), { r: 255, g: 255, b: 255 })).toBe(true)
})

test("a picture's focus keeps its side in view when it covers a frame of another shape", async ({
  request,
}) => {
  test.setTimeout(120_000)
  await seedDeck(request)
  // A square picture, red above green, covering a 4:1 frame: only a band
  // of it shows, which band is the focus's.
  const picture = new PNG({ width: 100, height: 100 })
  for (let y = 0; y < 100; y++)
    for (let x = 0; x < 100; x++) {
      const c = y < 50 ? RED : GREEN
      const i = (y * 100 + x) << 2
      picture.data[i] = c.r
      picture.data[i + 1] = c.g
      picture.data[i + 2] = c.b
      picture.data[i + 3] = 255
    }
  const { assetId } = await command<{ assetId: string }>(request, 'media.upload', {
    file: { base64: PNG.sync.write(picture).toString('base64'), filename: 'halves.png' },
  })
  const frame = { x: 800, y: 600, width: 400, height: 100 }
  const shown = async (focus: 'top' | 'bottom' | null) => {
    await command(request, 'object.create', {
      slide: { index: 0 },
      id: `pic-${focus ?? 'centre'}`,
      object: { type: 'image', ...frame, assetId, fit: 'cover', ...(focus ? { focus } : {}) },
    })
    const { png } = await look(request, { slide: { index: 0 }, region: frame })
    await command(request, 'object.delete', {
      slide: { index: 0 },
      objects: [`pic-${focus ?? 'centre'}`],
    })
    return { top: pixelOf(png, 200, 10), bottom: pixelOf(png, 200, 90) }
  }
  const top = await shown('top')
  expect(near(top.top, RED) && near(top.bottom, RED)).toBe(true)
  const bottom = await shown('bottom')
  expect(near(bottom.top, GREEN) && near(bottom.bottom, GREEN)).toBe(true)
  // Centred: the middle band, red over green.
  const centre = await shown(null)
  expect(near(centre.top, RED) && near(centre.bottom, GREEN)).toBe(true)
})

test('a sheet shows the slides numbered, in one picture', async ({ request }) => {
  test.setTimeout(120_000)
  await seedDeck(request)
  const { out, png } = await look(request, { slides: 'all' })
  expect(out.mode).toBe('sheet')
  expect(out.slides.map((s) => s.index)).toEqual([0, 1])
  expect(out.width * out.height).toBeLessThanOrEqual(1_150_000)
  // Two tiles stacked (sheetLayout): the first slide's block in the top one,
  // and each tile's number on a dark tab at its top-left corner.
  const tileW = out.width - 16
  const tileH = Math.round((tileW * 1080) / 1920)
  const s = tileW / 1920
  expect(near(pixelOf(png, 8 + 400 * s, 8 + 300 * s), RED)).toBe(true)
  expect(near(pixelOf(png, 8 + 400 * s, 16 + tileH + 300 * s), RED)).toBe(false)
  const tab = pixelOf(png, 9, 9)
  expect(tab.r + tab.g + tab.b).toBeLessThan(250)
  const secondTab = pixelOf(png, 9, 17 + tileH)
  expect(secondTab.r + secondTab.g + secondTab.b).toBeLessThan(250)
})

test('a look right after an edit shows the edit, also on the page kept from the last look', async ({
  request,
}) => {
  test.setTimeout(120_000)
  await seedDeck(request)
  const scale = 1430 / 1920
  const first = await look(request, { slide: { index: 0 } })
  expect(near(pixelOf(first.png, 400 * scale, 300 * scale), RED)).toBe(true)
  await command(request, 'object.update', {
    slide: { index: 0 },
    object: 'block',
    patch: { fill: '#43A047' },
  })
  const second = await look(request, { slide: { index: 0 } })
  expect(near(pixelOf(second.png, 400 * scale, 300 * scale), GREEN)).toBe(true)
  // And a slide added a moment ago is there to look at.
  await command(request, 'slide.add', {})
  const third = await look(request, { slide: { index: 2 } })
  expect(third.out.slides[0]!.index).toBe(2)
})

test('a compare shows the slide before this run changed it and now, side by side', async ({
  request,
}) => {
  test.setTimeout(150_000)
  // The seeding writes are this API session's run on the deck: "before" is
  // the deck at its first write — slide 1 without its block.
  await seedDeck(request)
  const { out, png } = await look(request, { slide: { index: 0 }, compare: 'before' })
  expect(out.mode).toBe('compare')
  expect(out.newSlide).toBeUndefined()
  expect(out.width).toBeLessThanOrEqual(1568)
  // Two tiles side by side (compareLayout): the block (200,200 400×200) is
  // in "Now" on the right, not in "Before" on the left.
  const tileW = (out.width - 24) / 2
  const s = tileW / 1920
  const atBlock = (left: number) => pixelOf(png, left + 400 * s, 8 + 300 * s)
  expect(near(atBlock(8), { r: 255, g: 255, b: 255 })).toBe(true)
  expect(near(atBlock(16 + tileW), RED)).toBe(true)
  // A slide this run added has no "before".
  const added = await look(request, { slide: { index: 1 }, compare: 'before' })
  expect(added.out.newSlide).toBe(true)
})

test('reports text boxes whose text runs below them, with the real fonts', async ({ request }) => {
  test.setTimeout(120_000)
  await seedDeck(request)
  await command(request, 'object.create', {
    slide: { index: 0 },
    id: 'cramped',
    object: {
      type: 'text',
      x: 200,
      y: 600,
      width: 500,
      height: 60,
      text: 'A sentence far too long for a box this small, set large',
      fontSize: 64,
    },
  })
  // A box with room to spare at 150% line spacing, its text at the bottom:
  // the line offset and the alignment move glyphs, they do not overflow.
  await command(request, 'object.create', {
    slide: { index: 0 },
    id: 'roomy',
    object: {
      type: 'text',
      x: 1000,
      y: 600,
      width: 700,
      height: 160,
      text: 'Fits',
      fontSize: 40,
      lineSpacing: 1.5,
      vAlign: 'bottom',
    },
  })
  const { out } = await look(request, { slide: { index: 0 } })
  expect(out.overflow).toHaveLength(1)
  expect(out.overflow[0]).toMatchObject({ index: 0, objectId: 'cramped', boxHeight: 60 })
  expect(out.overflow[0]!.textHeight).toBeGreaterThan(150)
  // The second slide's text fits its box.
  const second = await look(request, { slide: { index: 1 } })
  expect(second.out.overflow).toEqual([])
})

test('a box sized exactly to its text fits, at 150% and at 80% line spacing', async ({
  request,
}) => {
  test.setTimeout(180_000)
  await seedDeck(request)
  const spacings = { loose: 1.5, tight: 0.8 } as const
  // Three wrapped lines each; first squeezed to 20 px, so the page reports
  // how tall the laid-out text really is.
  for (const [id, lineSpacing] of Object.entries(spacings)) {
    await command(request, 'object.create', {
      slide: { index: 0 },
      id,
      object: {
        type: 'text',
        x: id === 'loose' ? 200 : 1000,
        y: 500,
        width: 600,
        height: 20,
        text: 'One line of words, then another line, then a third one',
        fontSize: 48,
        lineSpacing,
      },
    })
  }
  const squeezed = await look(request, { slide: { index: 0 } })
  const measured = Object.fromEntries(squeezed.out.overflow.map((o) => [o.objectId, o.textHeight]))
  expect(Object.keys(measured).sort()).toEqual(['loose', 'tight'])
  // The spacing reaches the measurement: three lines at 150% stand taller than at 80%.
  expect(measured.loose!).toBeGreaterThan(measured.tight! * 1.5)

  // Sized to the measured height, top and bottom aligned: no overflow — the
  // PowerPoint line offset and the alignment move glyphs, they add no height.
  for (const vAlign of ['top', 'bottom'] as const) {
    await command(request, 'object.update', {
      slide: { index: 0 },
      updates: Object.keys(spacings).map((id) => ({
        object: id,
        patch: { height: measured[id], vAlign },
      })),
    })
    const exact = await look(request, { slide: { index: 0 } })
    expect(exact.out.overflow, `vAlign ${vAlign}`).toEqual([])
  }

  // Four pixels short is reported, with the same text height.
  await command(request, 'object.update', {
    slide: { index: 0 },
    updates: Object.keys(spacings).map((id) => ({
      object: id,
      patch: { height: measured[id]! - 4, vAlign: 'top' },
    })),
  })
  const short = await look(request, { slide: { index: 0 } })
  expect(short.out.overflow.map((o) => o.objectId).sort()).toEqual(['loose', 'tight'])
  for (const o of short.out.overflow) {
    expect(o.boxHeight).toBe(measured[o.objectId]! - 4)
    expect(Math.abs(o.textHeight - measured[o.objectId]!)).toBeLessThanOrEqual(1)
  }
})

test('refuses a slide that does not exist', async ({ request }) => {
  test.setTimeout(60_000)
  await seedDeck(request)
  const res = await request.post(`${API}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target: { deckId }, command: 'query.render', input: { slide: { index: 9 } } },
  })
  const body = (await res.json()) as { ok: boolean; error?: { code: string } }
  expect(body.error?.code).toBe('not_found')
})

test('an autofit text box in an embedded face settles', async ({ request }) => {
  // Regression (A4, 2026-10-13): HTMLText's measurements load the faces it
  // embeds again, each load re-laid autofit boxes out, which measured again:
  // the render page never settled and the look timed out.
  test.setTimeout(120_000)
  const folder = await request.post(`${API}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target: {}, command: 'folder.create', input: { name: `Autofit token ${Date.now()}` } },
  })
  const folderId = ((await folder.json()) as { result: { id: string } }).result.id
  try {
    const token = await request.post(`${API}/commands`, {
      headers: { Origin: WEB_ORIGIN },
      data: {
        target: { folderId },
        command: 'token.create',
        input: { category: 'colors', name: 'Ink', value: '#43A047' },
      },
    })
    const { tokenId } = ((await token.json()) as { result: { tokenId: string } }).result
    const deck = await request.post(`${API}/commands`, {
      headers: { Origin: WEB_ORIGIN },
      data: { target: {}, command: 'deck.create', input: { title: 'Autofit token', folderId } },
    })
    deckId = ((await deck.json()) as { result: { id: string } }).result.id
    for (const autofit of ['grow-down', 'shrink'] as const) {
      await command(request, 'object.create', {
        slide: { index: 0 },
        id: autofit,
        object: {
          type: 'text',
          x: autofit === 'shrink' ? 1000 : 200,
          y: 200,
          width: 600,
          height: 120,
          text: 'Green ink in a box that fits itself to its text',
          fontSize: 72,
          fontFamily: 'Inter',
          autofit,
          color: { $token: `colors.${tokenId}` },
        },
      })
    }
    const { out } = await look(request, { slide: { index: 0 } })
    expect(out.slides).toHaveLength(1)
  } finally {
    if (deckId !== '') await request.delete(`${API}/decks/${deckId}`).catch(() => undefined)
    deckId = ''
    await request.delete(`${API}/folders/${folderId}`, { headers: { Origin: WEB_ORIGIN } })
  }
})
