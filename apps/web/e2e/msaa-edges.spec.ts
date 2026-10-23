/**
 * msaa-edges.spec.ts — what multisampling (MSAA) does to a slide's edges at
 * a device scale of 2 (docs/plans/performance.md → W4, F2).
 *
 * The canvas asks WebGL for `antialias: true` (renderer/Canvas.tsx). Pixi
 * tessellates shapes without antialiasing of its own, so the multisampled
 * framebuffer is what smooths every geometric edge on the canvas: a shape's
 * outline, a stroke, a picture's quad when it is rotated or sits between
 * device pixels. In WebKit at 2× it is also what makes a drag's frame twice
 * as long, so switching it off was proposed — on the condition that the
 * slide looks the same.
 *
 * This spec answers that with pixels: one slide of shapes (rectangles at
 * fractional positions, a rounded rectangle, an ellipse, a triangle, a
 * heptagon, rotated shapes, outlines only, a dashed stroke, a diagonal line,
 * bezier paths, a rotated picture) is presented at devicePixelRatio 2 twice
 * — as shipped, and in a context whose WebGL contexts are created without
 * `antialias` (the perf harness's PERF_ANTIALIAS=off, as an init script) —
 * and the two screenshots are compared region by region. It prints the
 * comparison (and attaches the difference as an image), and it pins what
 * the renderer relies on: with MSAA on, edges are smooth (pixels between the
 * shape's colour and the background along a diagonal edge), so a context
 * that silently came without MSAA, or a change that turned it off, fails.
 *
 * Runs in Chromium (`just e2e -g msaa-edges`; ANGLE Metal on a Mac, as the
 * perf runs draw) and WebKit (`just e2e-webkit -g msaa-edges`).
 */

import type { APIRequestContext, Browser, BrowserContext, Page, TestInfo } from '@playwright/test'
import { PNG } from 'pngjs'
import { expect, test } from './fixtures/test'
import { uploadTestPicture } from './fixtures/media'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

/** The slide at 1:1 (present mode scales it to the viewport), drawn at 2 device pixels per slide pixel. */
const VIEWPORT = { width: 1920, height: 1080 }
const SCALE = 2

/** The perf harness's PERF_ANTIALIAS=off (e2e/perf/lib/driver.ts): every WebGL context without MSAA. */
const ANTIALIAS_OFF = `(() => {
  const get = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl2' || type === 'webgl') attrs = { ...(attrs || {}), antialias: false }
    return get.call(this, type, attrs)
  }
})()`

// On a Mac the Chromium runs draw on the GPU (ANGLE Metal), as a person's
// Chrome does and as the perf runs measure; elsewhere, and in WebKit, the
// browser's default backend.
test.use({
  launchOptions: [
    async ({ browserName }, use) => {
      await use(
        browserName === 'chromium' && process.platform === 'darwin'
          ? {
              args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
              // playwright.config.ts's own launch option, kept.
              ...(process.env['PLAYWRIGHT_CHROME_EXECUTABLE']
                ? { executablePath: process.env['PLAYWRIGHT_CHROME_EXECUTABLE'] }
                : {}),
            }
          : {},
      )
    },
    { scope: 'worker' },
  ],
})

interface Region {
  name: string
  /** Slide px. */
  x: number
  y: number
  width: number
  height: number
}

/** An object id for a region's name (object ids take no dots). */
const objectId = (name: string): string => `msaa-${name.replace(/\./g, '-')}`

const BG = '#ffffff'
const INK = '#1d3557'
const rad = (deg: number): number => (deg * Math.PI) / 180

/** The shapes, each in a region of its own (the regions leave a margin for strokes and rotation). */
function shapeOps(pictureId: string): { ops: unknown[]; regions: Region[] } {
  const ops: unknown[] = []
  const regions: Region[] = []
  const slide = { index: 0 }
  const add = (
    name: string,
    region: Omit<Region, 'name'>,
    object: Record<string, unknown>,
  ): void => {
    ops.push({
      command: 'object.create',
      input: { slide, id: objectId(name), object: { opacity: 1, rotation: 0, ...object } },
    })
    regions.push({ name, ...region })
  }
  const cell = (col: number, row: number): Omit<Region, 'name'> => ({
    x: 40 + col * 370,
    y: 40 + row * 330,
    width: 360,
    height: 320,
  })
  const box = (col: number, row: number, inset = 60) => {
    const c = cell(col, row)
    return {
      x: c.x + inset,
      y: c.y + inset,
      width: c.width - 2 * inset,
      height: c.height - 2 * inset,
    }
  }

  // Axis-aligned, between device pixels: only the fractional edges can differ.
  add('rect.fractional', cell(0, 0), {
    type: 'rectangle',
    ...box(0, 0),
    x: box(0, 0).x + 0.3,
    y: box(0, 0).y + 0.7,
    width: box(0, 0).width + 0.45,
    fill: INK,
  })
  add('rect.rounded', cell(1, 0), { type: 'rectangle', ...box(1, 0), fill: INK, cornerRadius: 48 })
  add('ellipse', cell(2, 0), { type: 'ellipse', ...box(2, 0), fill: INK })
  add('triangle', cell(3, 0), { type: 'triangle', ...box(3, 0), fill: INK })
  add('polygon.7', cell(4, 0), { type: 'polygon', ...box(4, 0), fill: INK, sides: 7 })

  add('rect.rotated', cell(0, 1), { type: 'rectangle', ...box(0, 1), fill: INK, rotation: rad(17) })
  add('ellipse.stroke', cell(1, 1), {
    type: 'ellipse',
    ...box(1, 1),
    fill: BG,
    fillAlpha: 0,
    stroke: INK,
    strokeWidth: 3,
  })
  add('rect.stroke.rotated', cell(2, 1), {
    type: 'rectangle',
    ...box(2, 1),
    fill: BG,
    fillAlpha: 0,
    stroke: INK,
    strokeWidth: 2,
    rotation: rad(-8),
  })
  add('rect.dashed', cell(3, 1), {
    type: 'rectangle',
    ...box(3, 1),
    fill: BG,
    fillAlpha: 0,
    stroke: INK,
    strokeWidth: 4,
    strokeDash: true,
    cornerRadius: 24,
  })
  add('triangle.rotated', cell(4, 1), {
    type: 'triangle',
    ...box(4, 1),
    fill: INK,
    stroke: '#e63946',
    strokeWidth: 3,
    rotation: rad(33),
  })

  const l = box(0, 2, 40)
  add('line.diagonal', cell(0, 2), {
    type: 'line',
    x: l.x,
    y: l.y,
    width: l.width,
    height: l.height,
    p1: { x: 0, y: l.height },
    p2: { x: l.width, y: 0 },
    stroke: INK,
    strokeWidth: 3,
  })
  const p = box(1, 2, 40)
  add('path.closed', cell(1, 2), {
    type: 'path',
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    closed: true,
    fill: INK,
    stroke: INK,
    strokeWidth: 1,
    anchors: [
      { x: 0, y: p.height / 2, cpOut: { x: 30, y: -120 } },
      { x: p.width, y: p.height / 3, cpIn: { x: -40, y: -90 }, cpOut: { x: 20, y: 90 } },
      { x: p.width / 2, y: p.height, cpIn: { x: 90, y: 10 }, cpOut: { x: -90, y: -10 } },
    ],
  })
  const q = box(2, 2, 40)
  add('path.open', cell(2, 2), {
    type: 'path',
    x: q.x,
    y: q.y,
    width: q.width,
    height: q.height,
    stroke: INK,
    strokeWidth: 5,
    anchors: [
      { x: 0, y: q.height, cpOut: { x: 60, y: -200 } },
      { x: q.width, y: 0, cpIn: { x: -60, y: 200 } },
    ],
  })
  add('image.rotated', cell(3, 2), {
    type: 'image',
    ...box(3, 2),
    assetId: pictureId,
    rotation: rad(12),
  })
  return { ops, regions }
}

async function command(
  request: APIRequestContext,
  deckId: string,
  name: string,
  input: unknown,
): Promise<void> {
  const res = await request.post(`${API_BASE}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target: { deckId }, command: name, input },
  })
  const body = (await res.json()) as { ok: boolean; error?: { message: string } }
  expect(body.ok, `${name}: ${body.error?.message ?? res.status()}`).toBe(true)
}

/** Present the deck in a fresh 2× context (MSAA on or off) and screenshot the slide. */
async function presentedSlide(
  browser: Browser,
  deckId: string,
  objectIds: readonly string[],
  antialias: boolean,
): Promise<PNG> {
  const context: BrowserContext = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
  })
  try {
    if (!antialias) await context.addInitScript(ANTIALIAS_OFF)
    const page: Page = await context.newPage()
    await page.goto(`/deck/${deckId}/present?perf=1&slide=1`)
    await page.waitForFunction(
      (ids) => {
        const h = window.__narrative_perf_harness
        const el = document.querySelector('[data-testid="slide-container"]')
        if (h === undefined || el?.getAttribute('data-present-ready') !== 'true') return false
        const have = new Set(h.mountedIds())
        return ids.every((id) => have.has(id))
      },
      objectIds,
      { timeout: 60_000 },
    )
    const settled = await page.evaluate(() =>
      window.__narrative_perf_harness!.settle({ quietMs: 800, timeoutMs: 30_000 }),
    )
    expect(settled.ok, `the slide did not settle: ${settled.reason}`).toBe(true)
    const attrs = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="slide-container"] canvas')
      const gl = (c as HTMLCanvasElement | null)?.getContext('webgl2')
      return { antialias: gl?.getContextAttributes()?.antialias ?? null, dpr: devicePixelRatio }
    })
    expect(attrs.dpr).toBe(SCALE)
    expect(attrs.antialias, 'the context was made as this side asked').toBe(antialias)
    const shot = await page.locator('[data-testid="slide-container"]').screenshot()
    return PNG.sync.read(shot)
  } finally {
    await context.close()
  }
}

interface RegionDiff {
  name: string
  /** Device pixels whose largest channel difference is over 8 levels / over 32 levels. */
  over8: number
  over32: number
  max: number
  /** Edge pixels with MSAA on: neither background nor the shape's colours (blended by coverage). */
  blendedOn: number
  blendedOff: number
}

const channelDiff = (a: PNG, b: PNG, i: number): number =>
  Math.max(
    Math.abs(a.data[i]! - b.data[i]!),
    Math.abs(a.data[i + 1]! - b.data[i + 1]!),
    Math.abs(a.data[i + 2]! - b.data[i + 2]!),
  )

/** A pixel that is a mix: not within 24 levels of the background, the ink, the stroke red or the picture red. */
function blended(png: PNG, i: number): boolean {
  const px = [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!]
  const near = (c: readonly number[]): boolean => px.every((v, k) => Math.abs(v - c[k]!) <= 24)
  return ![
    [255, 255, 255],
    [0x1d, 0x35, 0x57],
    [0xe6, 0x39, 0x46],
    [255, 0, 0],
  ].some(near)
}

function compare(on: PNG, off: PNG, regions: readonly Region[]): RegionDiff[] {
  return regions.map((r) => {
    const d: RegionDiff = { name: r.name, over8: 0, over32: 0, max: 0, blendedOn: 0, blendedOff: 0 }
    for (let y = r.y * SCALE; y < (r.y + r.height) * SCALE; y++)
      for (let x = r.x * SCALE; x < (r.x + r.width) * SCALE; x++) {
        const i = (y * on.width + x) * 4
        const c = channelDiff(on, off, i)
        if (c > 8) d.over8++
        if (c > 32) d.over32++
        d.max = Math.max(d.max, c)
        if (blended(on, i)) d.blendedOn++
        if (blended(off, i)) d.blendedOff++
      }
    return d
  })
}

/** The difference as a picture: grey where equal, red by how much a pixel moved. */
function diffImage(on: PNG, off: PNG): Buffer {
  const out = new PNG({ width: on.width, height: on.height })
  for (let i = 0; i < on.data.length; i += 4) {
    const c = channelDiff(on, off, i)
    const grey = Math.round(on.data[i]! * 0.15 + 200)
    out.data[i] = c > 0 ? 255 : grey
    out.data[i + 1] = c > 0 ? Math.max(0, 200 - c * 3) : grey
    out.data[i + 2] = c > 0 ? Math.max(0, 200 - c * 3) : grey
    out.data[i + 3] = 255
  }
  return PNG.sync.write(out)
}

async function attach(info: TestInfo, name: string, body: Buffer | string): Promise<void> {
  await info.attach(name, {
    body,
    contentType: typeof body === 'string' ? 'application/json' : 'image/png',
  })
}

test('shape edges at 2× with and without MSAA', async ({ browser, request }, info) => {
  test.setTimeout(180_000)
  const res = await request.post(`${API_BASE}/decks`, { data: { title: 'msaa-edges-spec' } })
  expect(res.ok()).toBe(true)
  const deckId = ((await res.json()) as { id: string }).id
  const pictureId = await uploadTestPicture(request, deckId)
  const { ops, regions } = shapeOps(pictureId)
  await command(request, deckId, 'ops.apply', { ops })
  const ids = regions.map((r) => objectId(r.name))

  const on = await presentedSlide(browser, deckId, ids, true)
  const off = await presentedSlide(browser, deckId, ids, false)
  expect([on.width, on.height]).toEqual([VIEWPORT.width * SCALE, VIEWPORT.height * SCALE])
  expect([off.width, off.height]).toEqual([on.width, on.height])

  const diffs = compare(on, off, regions)
  const engine = browser.browserType().name()
  const table = diffs
    .map(
      (d) =>
        `${d.name.padEnd(20)} differ>8 ${String(d.over8).padStart(6)}  >32 ${String(d.over32).padStart(6)}  max ${String(d.max).padStart(3)}  blended on/off ${d.blendedOn}/${d.blendedOff}`,
    )
    .join('\n')
  console.log(`MSAA at ${SCALE}× in ${engine} (on vs off, device px per region):\n${table}`)
  await attach(info, `msaa-${engine}-diff.png`, diffImage(on, off))
  await attach(info, `msaa-${engine}-on.png`, PNG.sync.write(on))
  await attach(info, `msaa-${engine}-off.png`, PNG.sync.write(off))
  await attach(info, `msaa-${engine}.json`, JSON.stringify(diffs, null, 2))

  // What the renderer relies on: with MSAA the edges of every shape that has
  // a slanted or curved outline are blended by coverage. Without it a pixel
  // is either the shape's or the background's (the picture's own bilinear
  // filtering aside), which is the staircase W4's switch would bring.
  for (const d of diffs) {
    if (d.name === 'rect.fractional') continue // axis-aligned: MSAA blends only its fractional rows/columns
    expect(d.blendedOn, `${d.name}: MSAA-smoothed edge pixels`).toBeGreaterThan(50)
  }
})
