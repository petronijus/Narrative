/**
 * table-raster-pixels.spec.ts — a table's cells rasterised together through
 * one SVG (renderer/htmlTextGroupRaster.ts, docs/plans/performance.md → E5)
 * draw exactly the pixels Pixi's own raster of each cell draws.
 *
 * The perf harness's table slide (packages/perf scenes.ts → tableSlideOps: a
 * styled 12 × 8 table in Inter, banded rows, a gradient totals row, italic
 * wrapping cells, right-aligned figures) is opened twice, side by side: once
 * as the app runs, once with grouping off (`__narrative_noGroupRaster`, so
 * every cell is Pixi's raster of its own — the drawing before E5). The
 * artboard is compared pixel for pixel at the fitted zoom, at 100 %, after a
 * zoom commit to ~2× (every cell rasterised again at the new resolution) and
 * after one cell's text changed; the table's thumbnail after an edit made
 * while the other slide is shown (drawn offscreen in both pages — the
 * thumbnail of the shown slide comes from either of two drawings, by timing).
 * Only the renderer's pixels are compared: the editor's chrome over the
 * artboard is hidden for the screenshots (each page shows its own presence
 * avatar). `just e2e-webkit -g table-raster-pixels` runs it in WebKit, which
 * does not group (GROUP_RASTER_SUPPORTED): there it checks that both pages
 * raster every cell alone and still draw the same pixels.
 */

import { writeFileSync } from 'node:fs'
import type { Browser, Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { tableSlideOps, TABLE_SCENE } from '@narrative/perf'
import { expect, test } from './fixtures/test'
import { applyOps, command, createDeck } from './perf/lib/seed'
import type { PerfHarnessApi } from '../src/perf/harness'

declare global {
  interface Window {
    __narrative_perf_harness?: PerfHarnessApi
  }
}

const VIEWPORT = { width: 1600, height: 1000 }

async function settle(page: Page): Promise<void> {
  const r = await page.evaluate(() =>
    window.__narrative_perf_harness!.settle({ quietMs: 800, timeoutMs: 60_000 }),
  )
  expect(r.ok, `the scene settled: ${r.reason ?? ''}`).toBe(true)
}

async function open(browser: Browser, deckId: string, grouped: boolean): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  if (!grouped)
    await context.addInitScript(() => {
      ;(globalThis as { __narrative_noGroupRaster?: boolean }).__narrative_noGroupRaster = true
    })
  const page = await context.newPage()
  await page.goto(`/deck/${deckId}?perf=1`)
  await expect
    .poll(() => page.evaluate(() => window.__narrative_perf_harness?.version ?? 0), {
      timeout: 30_000,
    })
    .toBe(1)
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => window.__narrative_perf_harness!.mountedIds().includes(id),
          TABLE_SCENE.id,
        ),
      { timeout: 60_000 },
    )
    .toBe(true)
  await settle(page)
  return page
}

/**
 * What the screenshots may show: the renderer's pixels only. The editor's
 * chrome lies over the artboard's box (the top bar, the panels), and part of
 * it differs per client — each page shows its own presence avatar first, a
 * remote cursor, a selection colour — none of which is the renderer's.
 */
const ONLY_CANVAS_PIXELS =
  '* { visibility: hidden !important } .artboard canvas { visibility: visible !important }'
const ONLY_THUMBNAIL_PIXELS =
  '* { visibility: hidden !important } [role="option"][data-slide-id] img, ' +
  '[role="option"][data-slide-id] canvas { visibility: visible !important }'

interface Shot {
  png: PNG
  name: string
}

type Region = 'artboard' | 'thumbnail'

async function shots(page: Page, regions: readonly Region[]): Promise<Shot[]> {
  // The pointer away from the canvas: no hover outline.
  await page.mouse.move(2, VIEWPORT.height - 2)
  await settle(page)
  // Page screenshots clipped to the boxes: the style hides the elements
  // themselves, which an element screenshot would wait on.
  const shot = async (selector: string, style: string): Promise<PNG> => {
    const box = await page.locator(selector).first().boundingBox()
    expect(box, `${selector} on the page`).not.toBeNull()
    const vis = {
      x: Math.max(0, box!.x),
      y: Math.max(0, box!.y),
      width: Math.min(VIEWPORT.width, box!.x + box!.width) - Math.max(0, box!.x),
      height: Math.min(VIEWPORT.height, box!.y + box!.height) - Math.max(0, box!.y),
    }
    return PNG.sync.read(await page.screenshot({ clip: vis, animations: 'disabled', style }))
  }
  const out: Shot[] = []
  for (const name of regions)
    out.push({
      name,
      png:
        name === 'artboard'
          ? await shot('.artboard', ONLY_CANVAS_PIXELS)
          : await shot('[role="option"][data-slide-id]', ONLY_THUMBNAIL_PIXELS),
    })
  return out
}

/** Pixels that differ, and the largest channel difference among them. */
function diff(a: PNG, b: PNG): { pixels: number; maxDelta: number; sameSize: boolean } {
  if (a.width !== b.width || a.height !== b.height)
    return { pixels: -1, maxDelta: -1, sameSize: false }
  let pixels = 0
  let maxDelta = 0
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i + c]! - b.data[i + c]!))
    if (d > 0) {
      pixels++
      maxDelta = Math.max(maxDelta, d)
    }
  }
  return { pixels, maxDelta, sameSize: true }
}

/**
 * On a mismatch: both pictures and a map of the differing pixels (red, on a
 * faded copy of the grouped one), plus their bounding boxes in the log.
 */
async function attachDiff(name: string, a: PNG, b: PNG): Promise<void> {
  if (a.width !== b.width || a.height !== b.height) return
  const map = new PNG({ width: a.width, height: a.height })
  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  for (let i = 0; i < a.data.length; i += 4) {
    const differs = [0, 1, 2, 3].some((c) => a.data[i + c] !== b.data[i + c])
    const p = i / 4
    const x = p % a.width
    const y = Math.floor(p / a.width)
    if (differs) {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    map.data[i] = differs ? 255 : 128 + (a.data[i]! >> 1)
    map.data[i + 1] = differs ? 0 : 128 + (a.data[i + 1]! >> 1)
    map.data[i + 2] = differs ? 0 : 128 + (a.data[i + 2]! >> 1)
    map.data[i + 3] = 255
  }
  console.log(`${name}: differing pixels within x ${minX}–${maxX}, y ${minY}–${maxY}`)
  const info = test.info()
  const file = (n: string) => `${name.replace(/[^a-z0-9]+/gi, '-')}-${n}.png`
  for (const [n, png] of [
    ['grouped', a],
    ['per-cell', b],
    ['diff', map],
  ] as const) {
    const path = info.outputPath(file(n))
    writeFileSync(path, PNG.sync.write(png))
    await info.attach(file(n), { path, contentType: 'image/png' })
  }
}

async function compare(
  grouped: Page,
  single: Page,
  state: string,
  regions: readonly Region[] = ['artboard'],
): Promise<void> {
  const [a, b] = [await shots(grouped, regions), await shots(single, regions)]
  for (const [i, shot] of a.entries()) {
    const d = diff(shot.png, b[i]!.png)
    if (d.pixels !== 0) await attachDiff(`${state} ${shot.name}`, shot.png, b[i]!.png)
    expect
      .soft(
        d,
        `${state}, ${shot.name} (${shot.png.width}×${shot.png.height}): grouped vs one raster per cell`,
      )
      .toEqual({ pixels: 0, maxDelta: 0, sameSize: true })
  }
}

async function fit(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
  await page.getByRole('button', { name: 'Fit to screen' }).click()
  await settle(page)
}

async function zoomTo100(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).click()
  await settle(page)
}

async function zoomIn(page: Page): Promise<void> {
  const a = (await page.locator('.artboard').boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.keyboard.down('ControlOrMeta')
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -50)
    await page.waitForTimeout(25)
  }
  await page.keyboard.up('ControlOrMeta')
  await settle(page)
}

const rasters = (page: Page) =>
  page.evaluate(() => window.__narrative_perf_harness!.counters()['text.raster.started'] ?? 0)

test('a table rasterised cell by cell and grouped draws the same pixels', async ({
  browser,
  browserName,
  request,
}) => {
  test.setTimeout(240_000)
  const deckId = await createDeck(request, `table raster pixels ${Date.now()}`)
  await applyOps(request, deckId, tableSlideOps().ops)

  const grouped = await open(browser, deckId, true)
  const single = await open(browser, deckId, false)
  // Grouping is on in one and off in the other: 96 cells, a few images vs 96.
  // WebKit never groups (htmlTextGroupRaster.ts → GROUP_RASTER_SUPPORTED: its
  // shared images lost their embedded face): there both pages raster per cell.
  const [g, s] = [await rasters(grouped), await rasters(single)]
  expect(s, 'one raster per cell without grouping').toBeGreaterThanOrEqual(96)
  if (browserName === 'webkit') expect(g, 'WebKit rasters every cell alone').toBe(s)
  else expect(g * 4, `grouped rasters (${g}) vs one per cell (${s})`).toBeLessThan(s)

  for (const p of [grouped, single]) await fit(p)
  await compare(grouped, single, 'fitted zoom')
  for (const p of [grouped, single]) await zoomTo100(p)
  await compare(grouped, single, '100 %')
  for (const p of [grouped, single]) await zoomIn(p)
  await compare(grouped, single, 'zoom commit')

  // One cell changes: it alone is drawn again (a group of one), the rest stay.
  await command(request, deckId, 'text.set', {
    target: { slide: { index: 0 }, object: TABLE_SCENE.id, cell: { row: 3, col: 1 } },
    text: 'A longer summary that wraps onto a second line',
  })
  for (const p of [grouped, single]) await settle(p)
  await compare(grouped, single, 'after a cell edit')

  // The table's thumbnail. The thumbnail of the slide on the canvas is read
  // from the canvas when its scene settles in time and drawn offscreen
  // otherwise (renderer/liveThumbnail.ts) — a race, two different drawings,
  // so two pages' thumbnails of the shown slide are not comparable. With the
  // other slide shown, an edit to the table is drawn offscreen in both: the
  // thumbnail renderer's own rasters, grouped or per cell.
  for (const p of [grouped, single]) {
    await p.locator('[role="option"][data-slide-id]').nth(1).click()
    await expect
      .poll(() =>
        p.evaluate(
          (id) => !window.__narrative_perf_harness!.mountedIds().includes(id),
          TABLE_SCENE.id,
        ),
      )
      .toBe(true)
  }
  await command(request, deckId, 'text.set', {
    target: { slide: { index: 0 }, object: TABLE_SCENE.id, cell: { row: 6, col: 1 } },
    text: 'Edited while another slide is shown',
  })
  for (const p of [grouped, single]) await settle(p)
  await compare(grouped, single, 'table thumbnail, drawn offscreen', ['thumbnail'])

  for (const p of [grouped, single]) await p.context().close()
})
