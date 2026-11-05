/**
 * text-export-parity.spec.ts — an exported slide puts every text where the
 * editor's canvas does (ADR 0018 → Decision: Petr, 2026-10-26).
 *
 * The deck: the text corpus (fixtures/textCorpus.ts) and its custom-font
 * slide, in a folder with the test fonts (fixtures/customFonts.ts). Each slide
 * is drawn three ways:
 *
 *   - the editor's canvas at 100 % zoom and DPR 1, read back from the Pixi
 *     stage (slide px 1:1 — what the user sees, with the text rasters at the
 *     same resolution an export uses);
 *   - `deck.exportPng` (the render worker: headless Chromium on the render
 *     page) — PNG, 1920 × 1080;
 *   - `deck.exportPdf` (the same render page; the slides as JPEG pages).
 *
 * For every text box and table, its region of the export is compared with
 * the editor's: identical, or — where the pixels differ (the PDF's JPEG, a
 * different headless Chromium) — the shift that best maps one onto the other
 * (sum of squared differences over integer offsets, refined to sub-pixel by a
 * parabola), which must stay within 0.5 px. Together with
 * text-edit-parity.spec.ts (canvas = edit overlay) this pins the export to
 * the edit overlay as well.
 *
 * Needs the whole dev stack, the render worker included (`just dev`).
 * `TEXT_EXPORT_SLIDES=` filters slides by name.
 */

import { writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { expect, test } from './fixtures/test'
import { createDeckInFolder, seedFontFolder } from './fixtures/customFonts'
import { customFontSlide, textCorpusOps } from './fixtures/textCorpus'
import { applyOps, command } from './perf/lib/seed'
import type { PerfHarnessApi } from '../src/perf/harness'

declare global {
  interface Window {
    __narrative_perf_harness?: PerfHarnessApi
  }
}

const ONLY = (process.env['TEXT_EXPORT_SLIDES'] ?? '').split(',').filter((s) => s !== '')
const TOLERANCE = 0.5
const W = 1920
const H = 1080

interface Rgba {
  width: number
  height: number
  data: Uint8Array
}

/** The editor's canvas of the shown slide, 1920 × 1080 at resolution 1. */
async function editorSlide(page: Page): Promise<Rgba> {
  const out = await page.evaluate(async () => {
    const w = window as unknown as {
      __narrative_perf: {
        app: {
          stage: unknown
          renderer: {
            extract: {
              pixels(o: unknown): { pixels: Uint8ClampedArray; width: number; height: number }
            }
          }
        }
      }
      __narrative_scene_graph: { slideOriginX: number; slideOriginY: number }
    }
    // Pixi's Rectangle, from one the app already has (no module import in the page).
    const Rectangle = (w.__narrative_perf.app as unknown as { screen: object }).screen
      .constructor as new (x: number, y: number, w: number, h: number) => unknown
    const sg = w.__narrative_scene_graph
    const app = w.__narrative_perf.app
    const px = app.renderer.extract.pixels({
      target: app.stage,
      frame: new Rectangle(sg.slideOriginX, sg.slideOriginY, 1920, 1080),
      resolution: 1,
    })
    let s = ''
    const bytes = new Uint8Array(px.pixels.buffer, px.pixels.byteOffset, px.pixels.byteLength)
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return { width: px.width, height: px.height, base64: btoa(s) }
  })
  return { width: out.width, height: out.height, data: Buffer.from(out.base64, 'base64') }
}

/** A JPEG decoded by the browser. */
async function decodeJpeg(page: Page, jpeg: Buffer): Promise<Rgba> {
  const out = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const g = canvas.getContext('2d')!
    g.drawImage(bitmap, 0, 0)
    const d = g.getImageData(0, 0, bitmap.width, bitmap.height).data
    let s = ''
    for (let i = 0; i < d.length; i += 0x8000)
      s += String.fromCharCode(...d.subarray(i, i + 0x8000))
    return { width: bitmap.width, height: bitmap.height, base64: btoa(s) }
  }, jpeg.toString('base64'))
  return { width: out.width, height: out.height, data: Buffer.from(out.base64, 'base64') }
}

function pdfPages(pdf: Buffer): Buffer[] {
  const text = pdf.toString('latin1')
  const pages: Buffer[] = []
  for (const m of text.matchAll(/\/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length
    pages.push(pdf.subarray(start, start + Number(m[1])))
  }
  return pages
}

function luma(img: Rgba, x: number, y: number): number {
  const i = (y * img.width + x) * 4
  return 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!
}

interface Region {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * How `b` is shifted against `a` within `r`: the integer offset with the least
 * mean squared difference (±4 px), refined by a parabola through it and its
 * neighbours. `identical` when no pixel differs.
 */
function shiftOf(
  a: Rgba,
  b: Rgba,
  r: Region,
): { identical: boolean; dx: number; dy: number; differing: number; residual: number } {
  let differing = 0
  for (let y = r.y0; y < r.y1; y++)
    for (let x = r.x0; x < r.x1; x++) if (Math.abs(luma(a, x, y) - luma(b, x, y)) > 0.5) differing++
  if (differing === 0) return { identical: true, dx: 0, dy: 0, differing, residual: 0 }
  const R = 4
  const ssd = (dx: number, dy: number): number => {
    let s = 0
    let n = 0
    for (let y = r.y0 + R; y < r.y1 - R; y++)
      for (let x = r.x0 + R; x < r.x1 - R; x++) {
        const d = luma(a, x, y) - luma(b, x + dx, y + dy)
        s += d * d
        n++
      }
    return n === 0 ? 0 : s / n
  }
  let best = { dx: 0, dy: 0, v: Infinity }
  const grid = new Map<string, number>()
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const v = ssd(dx, dy)
      grid.set(`${dx},${dy}`, v)
      if (v < best.v) best = { dx, dy, v }
    }
  const at = (dx: number, dy: number): number => grid.get(`${dx},${dy}`) ?? ssd(dx, dy)
  const refine = (m: number, c: number, p: number): number => {
    const den = m - 2 * c + p
    return den <= 0 ? 0 : Math.max(-0.5, Math.min(0.5, (m - p) / (2 * den)))
  }
  const fx = refine(at(best.dx - 1, best.dy), best.v, at(best.dx + 1, best.dy))
  const fy = refine(at(best.dx, best.dy - 1), best.v, at(best.dx, best.dy + 1))
  return { identical: false, dx: best.dx + fx, dy: best.dy + fy, differing, residual: best.v }
}

/** The slide-px region of every text box and table on the shown slide. */
async function textRegions(page: Page, ids: string[]): Promise<Array<{ id: string; r: Region }>> {
  return await page.evaluate((ids) => {
    const sg = (
      window as unknown as {
        __narrative_scene_graph: {
          getBounds(
            id: string,
          ): { world: { x: number; y: number; width: number; height: number } } | null
        }
      }
    ).__narrative_scene_graph
    const out: Array<{ id: string; r: { x0: number; y0: number; x1: number; y1: number } }> = []
    for (const id of ids) {
      const b = sg.getBounds(id)
      if (b === null) continue
      const m = 6
      out.push({
        id,
        r: {
          x0: Math.max(0, Math.floor(b.world.x) - m),
          y0: Math.max(0, Math.floor(b.world.y) - m),
          x1: Math.min(1920, Math.ceil(b.world.x + b.world.width) + m),
          y1: Math.min(1080, Math.ceil(b.world.y + b.world.height) + m),
        },
      })
    }
    return out
  }, ids)
}

function crop(img: Rgba, r: Region): PNG {
  const png = new PNG({ width: r.x1 - r.x0, height: r.y1 - r.y0 })
  for (let y = r.y0; y < r.y1; y++)
    for (let x = r.x0; x < r.x1; x++) {
      const i = (y * img.width + x) * 4
      const o = ((y - r.y0) * png.width + (x - r.x0)) * 4
      for (let k = 0; k < 4; k++) png.data[o + k] = img.data[i + k]!
    }
  return png
}

interface Row {
  slide: string
  id: string
  via: 'png' | 'pdf'
  identical: boolean
  dx: number
  dy: number
  differing: number
}

test('exports put every text where the editor canvas does', async ({
  browser,
  browserName,
  request,
}) => {
  test.setTimeout(60 * 60_000)
  test.skip(
    browserName === 'webkit',
    "Exports are drawn by the render worker's headless Chromium; a WebKit editor lays text out its own way (ADR 0018 → The residue, accepted 2026-10-31)",
  )
  const { folderId, families } = await seedFontFolder(request, `text export parity ${Date.now()}`)
  const deckId = await createDeckInFolder(request, folderId, `text export parity ${Date.now()}`)
  const { ops, slides } = textCorpusOps()
  const fonts = customFontSlide(slides.length, families)
  await applyOps(request, deckId, [...ops, { command: 'slide.add', input: {} }, ...fonts.ops])
  slides.push(fonts)

  const wanted = slides
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => ONLY.length === 0 || ONLY.includes(s.name))
  // As links: inline bytes are capped at 8 MB per call.
  const links = await command<{ slides: Array<{ index: number; url: string }> }>(
    request,
    deckId,
    'deck.exportPng',
    { slides: wanted.map(({ i }) => ({ index: i })) },
  )
  const pngs = new Map<number, PNG>()
  for (const l of links.slides) {
    const res = await request.get(l.url)
    expect(res.ok()).toBe(true)
    pngs.set(l.index, PNG.sync.read(await res.body()))
  }
  let pdfJob = await command<{ status: string; jobId: string; base64?: string }>(
    request,
    deckId,
    'deck.exportPdf',
    { delivery: 'base64', includeSkipped: true },
  )
  while (pdfJob.status !== 'done')
    pdfJob = await command(request, deckId, 'deck.exportPdf', { jobId: pdfJob.jobId })
  const pdf = pdfPages(Buffer.from(pdfJob.base64!, 'base64'))
  expect(pdf).toHaveLength(slides.length)

  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  await page.goto(`/deck/${deckId}?perf=1`)
  await expect
    .poll(() => page.evaluate(() => window.__narrative_perf_harness?.version ?? 0), {
      timeout: 30_000,
    })
    .toBe(1)
  const rows: Row[] = []
  for (const { s, i } of wanted) {
    await page.locator('[role="option"][data-slide-id]').nth(i).click()
    await expect
      .poll(
        () =>
          page.evaluate(
            (ids) => ids.every((id) => window.__narrative_perf_harness!.mountedIds().includes(id)),
            s.ids,
          ),
        { timeout: 60_000 },
      )
      .toBe(true)
    await page.getByRole('button', { name: 'Reset zoom to 100%' }).click()
    await page.mouse.move(2, 998)
    const settled = await page.evaluate(() =>
      window.__narrative_perf_harness!.settle({ quietMs: 600, timeoutMs: 60_000 }),
    )
    expect(settled.ok).toBe(true)
    const editor = await editorSlide(page)
    expect([editor.width, editor.height]).toEqual([W, H])
    const fromPng = pngs.get(i)!
    const exported: Record<'png' | 'pdf', Rgba> = {
      png: { width: fromPng.width, height: fromPng.height, data: fromPng.data },
      pdf: await decodeJpeg(page, pdf[i]!),
    }
    expect([exported.pdf.width, exported.pdf.height]).toEqual([W, H])
    for (const { id, r } of await textRegions(page, s.ids)) {
      for (const via of ['png', 'pdf'] as const) {
        const d = shiftOf(editor, exported[via], r)
        rows.push({
          slide: s.name,
          id,
          via,
          identical: d.identical,
          dx: d.dx,
          dy: d.dy,
          differing: d.differing,
        })
        if (!d.identical && via === 'png') {
          const name = `${s.name}-${id}`.replace(/[^a-z0-9]+/gi, '-')
          writeFileSync(
            test.info().outputPath(`${name}-editor.png`),
            PNG.sync.write(crop(editor, r)),
          )
          writeFileSync(
            test.info().outputPath(`${name}-png.png`),
            PNG.sync.write(crop(exported.png, r)),
          )
        }
      }
    }
  }
  await context.close()
  writeFileSync(test.info().outputPath('export-parity.json'), JSON.stringify(rows, null, 1))
  for (const via of ['png', 'pdf'] as const) {
    const mine = rows.filter((r) => r.via === via)
    const worst = mine.reduce((m, r) => Math.max(m, Math.abs(r.dx), Math.abs(r.dy)), 0)
    console.log(
      `${via}: ${mine.length} texts, ${mine.filter((r) => r.identical).length} identical, largest shift ${worst.toFixed(2)} px`,
    )
    for (const r of mine.filter(
      (r) => !r.identical && (Math.abs(r.dx) > 0.05 || Math.abs(r.dy) > 0.05),
    ))
      console.log(
        `  ${r.slide} ${r.id}: Δ ${r.dx.toFixed(2)}, ${r.dy.toFixed(2)} (${r.differing} px differ)`,
      )
  }
  for (const r of rows) {
    expect.soft(Math.abs(r.dx), `${r.via} ${r.slide} ${r.id}: x`).toBeLessThanOrEqual(TOLERANCE)
    expect.soft(Math.abs(r.dy), `${r.via} ${r.slide} ${r.id}: y`).toBeLessThanOrEqual(TOLERANCE)
  }
})
