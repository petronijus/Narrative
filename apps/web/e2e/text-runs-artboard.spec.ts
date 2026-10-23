/**
 * text-runs-artboard.spec.ts — a slide drawn with canvas text from glyph runs
 * (ADR 0018) looks exactly as it does with HTMLText: the whole artboard, not
 * text by text.
 *
 * text-runs-parity.spec.ts compares each text's two rasters on one node; that
 * cannot see a text placed differently — its bounds (vertical alignment,
 * autofit, the clip mask, a grow-down box's height) come from the run
 * layout's measurement in both of its rasters. Here the corpus deck
 * (fixtures/textCorpus.ts) is opened twice, side by side: one page with
 * HTMLText (`__narrative_textEngine = 'html'`), one with the run engine. On
 * every slide the artboard's canvas pixels are compared at the fitted zoom,
 * at 100 % and after a zoom commit, and at the end the thumbnails of a slide
 * drawn offscreen. The editor's chrome is hidden for the shots (each page
 * shows its own presence avatar). Differences are written as images to the
 * test output; the measured maximum is printed.
 *
 * DPR 1 by default; `TEXT_RUNS_DPR=2` for the 2× run.
 */

import { writeFileSync } from 'node:fs'
import type { Browser, Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { expect, test } from './fixtures/test'
import { textCorpusOps, type CorpusSlide } from './fixtures/textCorpus'
import { applyOps, createDeck } from './perf/lib/seed'
import type { PerfHarnessApi } from '../src/perf/harness'

declare global {
  interface Window {
    __narrative_perf_harness?: PerfHarnessApi
  }
}

const VIEWPORT = { width: 1600, height: 1000 }
const DPR = Number(process.env['TEXT_RUNS_DPR'] ?? '1')

async function settle(page: Page): Promise<void> {
  const r = await page.evaluate(() =>
    window.__narrative_perf_harness!.settle({ quietMs: 800, timeoutMs: 60_000 }),
  )
  expect(r.ok, `the scene settled: ${r.reason ?? ''}`).toBe(true)
}

async function open(browser: Browser, deckId: string, engine: 'html' | 'runs'): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR })
  await context.addInitScript((e) => {
    ;(globalThis as { __narrative_textEngine?: string }).__narrative_textEngine = e
  }, engine)
  const page = await context.newPage()
  await page.goto(`/deck/${deckId}?perf=1`)
  await expect
    .poll(() => page.evaluate(() => window.__narrative_perf_harness?.version ?? 0), {
      timeout: 30_000,
    })
    .toBe(1)
  return page
}

async function showSlide(page: Page, index: number, s: CorpusSlide): Promise<void> {
  await page.locator('[role="option"][data-slide-id]').nth(index).click()
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
  await page.mouse.move(2, VIEWPORT.height - 2)
  await settle(page)
}

const ONLY_CANVAS_PIXELS =
  '* { visibility: hidden !important } .artboard canvas { visibility: visible !important }'
const ONLY_THUMBNAIL_PIXELS =
  '* { visibility: hidden !important } [role="option"][data-slide-id] img, ' +
  '[role="option"][data-slide-id] canvas { visibility: visible !important }'

async function shot(page: Page, selector: string, style: string, nth = 0): Promise<PNG> {
  await page.mouse.move(2, VIEWPORT.height - 2)
  await settle(page)
  const box = await page.locator(selector).nth(nth).boundingBox()
  expect(box, `${selector} on the page`).not.toBeNull()
  const clip = {
    x: Math.max(0, box!.x),
    y: Math.max(0, box!.y),
    width: Math.min(VIEWPORT.width, box!.x + box!.width) - Math.max(0, box!.x),
    height: Math.min(VIEWPORT.height, box!.y + box!.height) - Math.max(0, box!.y),
  }
  return PNG.sync.read(await page.screenshot({ clip, animations: 'disabled', style }))
}

interface Diff {
  pixels: number
  over8: number
  over32: number
  maxDelta: number
  sameSize: boolean
}

function diff(a: PNG, b: PNG): Diff {
  if (a.width !== b.width || a.height !== b.height)
    return { pixels: -1, over8: -1, over32: -1, maxDelta: -1, sameSize: false }
  let pixels = 0
  let over8 = 0
  let over32 = 0
  let maxDelta = 0
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i + c]! - b.data[i + c]!))
    if (d > 0) pixels++
    if (d > 8) over8++
    if (d > 32) over32++
    maxDelta = Math.max(maxDelta, d)
  }
  return { pixels, over8, over32, maxDelta, sameSize: true }
}

async function attachDiff(name: string, a: PNG, b: PNG): Promise<void> {
  if (a.width !== b.width || a.height !== b.height) return
  const map = new PNG({ width: a.width, height: a.height })
  for (let i = 0; i < a.data.length; i += 4) {
    const differs = [0, 1, 2, 3].some((c) => a.data[i + c] !== b.data[i + c])
    map.data[i] = differs ? 255 : 128 + (a.data[i]! >> 1)
    map.data[i + 1] = differs ? 0 : 128 + (a.data[i + 1]! >> 1)
    map.data[i + 2] = differs ? 0 : 128 + (a.data[i + 2]! >> 1)
    map.data[i + 3] = 255
  }
  const info = test.info()
  const file = (n: string) => `${name.replace(/[^a-z0-9]+/gi, '-')}-${n}.png`
  for (const [n, png] of [
    ['html', a],
    ['runs', b],
    ['diff', map],
  ] as const) {
    const path = info.outputPath(file(n))
    writeFileSync(path, PNG.sync.write(png))
    await info.attach(file(n), { path, contentType: 'image/png' })
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

test('the corpus looks the same with canvas text from glyph runs as with HTMLText', async ({
  browser,
  browserName,
  request,
}) => {
  test.setTimeout(30 * 60_000)
  const deckId = await createDeck(request, `text runs artboard ${Date.now()}`)
  const { ops, slides } = textCorpusOps()
  await applyOps(request, deckId, ops)
  const html = await open(browser, deckId, 'html')
  const runs = await open(browser, deckId, 'runs')
  const results: Array<{ slide: string; state: string } & Diff> = []
  for (const [i, s] of slides.entries()) {
    for (const p of [html, runs]) await showSlide(p, i, s)
    for (const [state, go] of [
      ['fit', fit],
      ['100%', zoomTo100],
      ['zoomed', zoomIn],
    ] as const) {
      for (const p of [html, runs]) await go(p)
      const [a, b] = [
        await shot(html, '.artboard', ONLY_CANVAS_PIXELS),
        await shot(runs, '.artboard', ONLY_CANVAS_PIXELS),
      ]
      const d = diff(a, b)
      results.push({ slide: s.name, state, ...d })
      if (d.pixels !== 0) await attachDiff(`${s.name} ${state}`, a, b)
    }
  }
  // Thumbnails drawn offscreen: show the last slide, so the others' come from
  // the thumbnail renderer in both pages.
  const last = slides.length - 1
  for (const p of [html, runs]) await showSlide(p, last, slides[last]!)
  for (let i = 0; i < last; i++) {
    const [a, b] = [
      await shot(html, '[role="option"][data-slide-id]', ONLY_THUMBNAIL_PIXELS, i),
      await shot(runs, '[role="option"][data-slide-id]', ONLY_THUMBNAIL_PIXELS, i),
    ]
    const d = diff(a, b)
    results.push({ slide: slides[i]!.name, state: 'thumbnail', ...d })
    if (d.pixels !== 0) await attachDiff(`${slides[i]!.name} thumbnail`, a, b)
  }
  const info = test.info()
  writeFileSync(info.outputPath('artboard.json'), JSON.stringify(results, null, 1))
  console.log(`${browserName} dpr${DPR}:`)
  for (const r of results)
    console.log(
      `  ${r.slide}/${r.state}: differing ${r.pixels}, >8 ${r.over8}, >32 ${r.over32}, max ${r.maxDelta}`,
    )
  for (const p of [html, runs]) await p.context().close()
  expect(results.every((r) => r.sameSize)).toBe(true)
})
