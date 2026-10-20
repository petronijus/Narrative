/**
 * e2e/text-align-reraster.spec.ts
 *
 * A bottom- or middle-aligned text keeps its place in its box when it is
 * rasterised again with other metrics: when its font arrives after the text
 * was first drawn in the fallback face, and when a zoom then draws it at a
 * new resolution. The block's offset is computed from the text's measured
 * height (textRenderer `applyVerticalAlign`); a re-raster that comes with
 * another measurement must lay the text out again
 * (`realignIfMeasureMoved`), or the block sits at the old offset with the
 * new size — the defect recorded in .claude/agents/renderer.md.
 *
 * The font is the block font (fixtures/make-block-font.py: every letter a
 * solid 1-em block, so the text wraps into far more lines than in any
 * fallback face). Its download is held back until the slide has painted in
 * the fallback; the reference is the same deck opened with the font there
 * from the start. Pixels are sampled from the scene rendered at slide
 * scale, so the zoom does not move the coordinates. Needs the dev stack
 * (`__narrative_scene_graph`).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type APIRequestContext, type Browser, type Page } from './fixtures/test'

const API = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'
const BLOCK_FONT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'block-font.ttf')
/** The folder font's file, wherever storage serves it from (a presigned URL). */
const FONT_FILE = /\/fonts\/[^?]*\/original\.ttf/

const TEXT = 'Block font words wrap differently here'
/** The boxes on the slide (slide px) and how they align. */
const BOXES = {
  bottom: { x: 100, y: 100, w: 700, h: 600 },
  middle: { x: 1000, y: 100, w: 700, h: 600 },
  /** A bottom-aligned table cell… */
  cell: { x: 100, y: 760, w: 600, h: 300 },
  /** …and its twin, top-aligned: the block's full height whatever happens (its room is below it). */
  cellTop: { x: 800, y: 760, w: 600, h: 300 },
} as const
type BoxId = keyof typeof BOXES
/** Ink extents in slide px (sampled at half scale: a 2 px step) may differ by this much. */
const TOLERANCE = 3

let deckId = ''
let folderId = ''
let fontFamily = ''

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
  })
  const body = (await res.json()) as { ok: boolean; result: T; error?: { message: string } }
  expect(body.ok, `${commandId}: ${body.error?.message}`).toBe(true)
  return body.result
}

/** A folder with the block font and a deck in it: a bottom- and a middle-aligned box, a bottom- and a top-aligned table cell. */
async function seed(request: APIRequestContext): Promise<void> {
  folderId = (
    await command<{ id: string }>(request, 'folder.create', { name: `e2e align ${Date.now()}` }, {})
  ).id
  const { family } = await command<{ family: string }>(
    request,
    'folder.fonts.upload',
    { file: { base64: readFileSync(BLOCK_FONT).toString('base64'), filename: 'block-font.ttf' } },
    { folderId },
  )
  fontFamily = family
  const res = await request.post(`${API}/decks`, { data: { title: 'e2e align', folderId } })
  expect(res.ok()).toBe(true)
  deckId = ((await res.json()) as { id: string }).id
  for (const id of ['bottom', 'middle'] as const) {
    const b = BOXES[id]
    await command(request, 'object.create', {
      slide: { index: 0 },
      id,
      object: {
        type: 'text',
        x: b.x,
        y: b.y,
        width: b.w,
        height: b.h,
        text: TEXT,
        fontSize: 60,
        vAlign: id,
      },
    })
  }
  await command(request, 'text.setBoxTypography', {
    slide: { index: 0 },
    objects: ['bottom', 'middle'],
    style: { fontFamily: family },
  })
  for (const [id, vAlign] of [
    ['cell', 'bottom'],
    ['cellTop', 'top'],
  ] as const) {
    const b = BOXES[id]
    const { objectId: table } = await command<{ objectId: string }>(request, 'table.insert', {
      slide: { index: 0 },
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      rows: 1,
      cols: 1,
    })
    await command(request, 'table.style.table', {
      slide: { index: 0 },
      table,
      style: { fontFamily: family, fontSize: 40, vAlign },
    })
    await command(request, 'text.set', {
      target: { slide: { index: 0 }, object: table, cell: { row: 0, col: 0 } },
      text: TEXT,
    })
  }
}

interface Ink {
  top: number
  bottom: number
}

/** The topmost and lowest dark pixel inside each box, in slide px, from the scene drawn at half scale. */
function inkExtents(page: Page): Promise<Record<BoxId, Ink>> {
  return page.evaluate((boxes) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the dev-only scene graph handle
    const sg = (window as any).__narrative_scene_graph
    const app = sg.getApp()
    const root = sg.getRoot()
    const scale = 0.5
    const canvas = app.renderer.extract.canvas({ target: root, resolution: scale })
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    const { width, height } = canvas
    const px = ctx.getImageData(0, 0, width, height).data
    // The extract's origin is the root's bounds; the root's own origin is slide (0, 0).
    const origin = root.getLocalBounds()
    const out: Record<string, { top: number; bottom: number }> = {}
    for (const [id, b] of Object.entries(boxes)) {
      let top = Infinity
      let bottom = -Infinity
      const x0 = Math.max(0, Math.floor((b.x - origin.x) * scale))
      const x1 = Math.min(width, Math.ceil((b.x + b.w - origin.x) * scale))
      const y0 = Math.max(0, Math.floor((b.y - 40 - origin.y) * scale))
      const y1 = Math.min(height, Math.ceil((b.y + b.h + 40 - origin.y) * scale))
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4
          if (px[i + 3]! > 128 && px[i]! < 100 && px[i + 1]! < 100 && px[i + 2]! < 100) {
            const sy = y / scale + origin.y
            top = Math.min(top, sy)
            bottom = Math.max(bottom, sy)
          }
        }
      }
      out[id] = { top, bottom }
    }
    return out as Record<'bottom' | 'middle' | 'cell' | 'cellTop', { top: number; bottom: number }>
  }, BOXES)
}

/** Every text of the scene drawn at the renderer's resolution, none waiting for one. */
function textsSettled(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi internals: _resolution, _gpuData
    const sg = (window as any).__narrative_scene_graph
    const renderer = sg.getApp().renderer
    let ok = sg.pendingTextRestage === 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (c: any): void => {
      if (c.anchor !== undefined && '_didTextUpdate' in c) {
        const gpu = c._gpuData?.[renderer.uid]
        const res = c._resolution ?? renderer.resolution
        if (
          gpu === undefined ||
          gpu.generatingTexture === true ||
          gpu.currentKey !== c.styleKey ||
          Math.abs(res - renderer.resolution) > 0.01
        )
          ok = false
      }
      for (const ch of c.children ?? []) walk(ch)
    }
    walk(sg.getRoot())
    return ok
  })
}

/** The folder's face is installed in the page (the loader adds it once its bytes are in). */
function fontInstalled(page: Page, family: string): Promise<boolean> {
  return page.evaluate(
    (f) =>
      [...document.fonts].some(
        (face) => face.family.replace(/"/g, '') === f && face.status === 'loaded',
      ),
    family,
  )
}

/** Open the deck; with `holdFont`, the folder font's download waits for the returned release. */
async function open(
  browser: Browser,
  holdFont: boolean,
): Promise<{ page: Page; release: () => void; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  if (holdFont) {
    await page.route(FONT_FILE, async (route) => {
      await held
      await route.continue()
    })
  }
  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).__narrative_scene_graph?.getContainer('middle') !== undefined,
        ),
      { timeout: 30_000 },
    )
    .toBe(true)
  await expect.poll(() => textsSettled(page), { timeout: 15_000 }).toBe(true)
  return { page, release, close: () => context.close() }
}

function expectSameInk(actual: Record<BoxId, Ink>, expected: Record<BoxId, Ink>): void {
  for (const id of Object.keys(BOXES) as BoxId[]) {
    expect(Number.isFinite(expected[id].top), `${id}: the reference has ink`).toBe(true)
    expect(Math.abs(actual[id].top - expected[id].top), `${id} top`).toBeLessThanOrEqual(TOLERANCE)
    expect(Math.abs(actual[id].bottom - expected[id].bottom), `${id} bottom`).toBeLessThanOrEqual(
      TOLERANCE,
    )
  }
}

test('a late font and a zoom leave bottom- and middle-aligned blocks where they belong', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000)
  await seed(request)

  // The reference: the font there before the text is drawn.
  const ref = await open(browser, false)
  await expect.poll(() => fontInstalled(ref.page, fontFamily), { timeout: 15_000 }).toBe(true)
  await expect.poll(() => textsSettled(ref.page), { timeout: 15_000 }).toBe(true)
  const expected = await inkExtents(ref.page)
  console.log(`reference ink: ${JSON.stringify(expected)}`)
  await ref.close()
  // The bottom-aligned cell shows its whole block — as tall as its top-aligned
  // twin's — ending at the cell's bottom. (Before 2026-10-18 a cell drawn
  // before its font arrived kept the offset of the fallback's two lines: the
  // block font's four were drawn from there and clipped by the cell.)
  const height = (i: Ink): number => i.bottom - i.top
  expect(
    Math.abs(height(expected.cell) - height(expected.cellTop)),
    'cell block height',
  ).toBeLessThanOrEqual(TOLERANCE)
  expect(BOXES.cell.y + BOXES.cell.h - expected.cell.bottom).toBeLessThan(40)
  // Bottom-aligned blocks end at their box's bottom, the middle one is centred.
  expect(BOXES.bottom.y + BOXES.bottom.h - expected.bottom.bottom).toBeLessThan(60)
  expect(
    Math.abs(
      (expected.middle.top + expected.middle.bottom) / 2 - (BOXES.middle.y + BOXES.middle.h / 2),
    ),
  ).toBeLessThan(60)

  const late = await open(browser, true)
  try {
    // Drawn in the fallback face first: far fewer lines than in the block font.
    const fallback = await inkExtents(late.page)
    expect(expected.bottom.bottom - expected.bottom.top).toBeGreaterThan(
      fallback.bottom.bottom - fallback.bottom.top + 40,
    )

    expect(await fontInstalled(late.page, fontFamily)).toBe(false)
    late.release()
    await expect.poll(() => fontInstalled(late.page, fontFamily), { timeout: 15_000 }).toBe(true)
    await expect
      .poll(
        async () =>
          (await textsSettled(late.page)) &&
          (await inkExtents(late.page)).bottom.top < fallback.bottom.top - 40,
        { timeout: 15_000 },
      )
      .toBe(true)
    expectSameInk(await inkExtents(late.page), expected)

    // A zoom draws every text again at the new resolution: nothing moves.
    const before = await late.page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__narrative_scene_graph.getApp().renderer.resolution as number,
    )
    const a = (await late.page.locator('.artboard').boundingBox())!
    await late.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await late.page.keyboard.down('ControlOrMeta')
    for (let i = 0; i < 6; i++) {
      await late.page.mouse.wheel(0, -100)
      await late.page.waitForTimeout(30)
    }
    await late.page.keyboard.up('ControlOrMeta')
    await expect
      .poll(
        () =>
          late.page.evaluate(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            () => (window as any).__narrative_scene_graph.getApp().renderer.resolution as number,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(before + 0.5)
    await expect.poll(() => textsSettled(late.page), { timeout: 15_000 }).toBe(true)
    expectSameInk(await inkExtents(late.page), expected)
  } finally {
    late.release()
    await late.close()
  }
})
