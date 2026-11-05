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
 * Since 2026-10-27 the run engine places each raster where the page (the
 * edit overlay) puts the text, up to a device px from where HTMLText drew it
 * (ADR 0018 → Placement); this spec turns that off on both pages
 * (`__narrative_textHtmlTextCompatible`) and so still measures the painter
 * alone. The placement is held by text-edit-parity.spec.ts.
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
    window.__narrative_perf_harness!.settle({ quietMs: 1500, timeoutMs: 60_000 }),
  )
  if (!r.ok) {
    const counters = await page.evaluate(() =>
      Object.entries(window.__narrative_perf_harness!.counters()).filter(([k]) =>
        k.includes('raster'),
      ),
    )
    const engine = await page.evaluate(
      () => (globalThis as { __narrative_textEngine?: string }).__narrative_textEngine,
    )
    console.log(`settle failed (${engine}): ${r.reason ?? ''} ${JSON.stringify(counters)}`)
  }
  expect(r.ok, `the scene settled: ${r.reason ?? ''}`).toBe(true)
}

/**
 * A page of the deck with the given text engine. `startSlideId` opens it on
 * that slide (the editor keeps the active slide per deck in localStorage,
 * state/ActiveSlideContext.tsx) instead of the first.
 */
async function open(
  browser: Browser,
  deckId: string,
  engine: 'html' | 'runs',
  startSlideId?: string,
): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR })
  await context.addInitScript(
    ({ e, deck, start }) => {
      ;(globalThis as { __narrative_textEngine?: string }).__narrative_textEngine = e
      // The painter against HTMLText's pixels: runs drawn as HTMLText placed
      // them, not on the device grid where the edit overlay puts text
      // (runText/flag.ts → htmlTextCompatible; text-edit-parity.spec.ts holds
      // that placement).
      ;(
        globalThis as { __narrative_textHtmlTextCompatible?: boolean }
      ).__narrative_textHtmlTextCompatible = true
      if (start !== null) window.localStorage.setItem(`narrative.activeSlideId.${deck}`, start)
    },
    { e: engine, deck: deckId, start: startSlideId ?? null },
  )
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
  await page.locator(selector).nth(nth).scrollIntoViewIfNeeded()
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
  // Where a wheel gesture leaves the view depends on how the events were
  // coalesced (the two pages showed different texts, 2026-10-27): both are
  // centred on the artboard's middle, and the region follows the scroll.
  await page.evaluate(() => {
    const art = document.querySelector('.artboard') as HTMLElement
    let el: HTMLElement | null = art.parentElement
    while (el !== null && !/(auto|scroll)/u.test(getComputedStyle(el).overflow))
      el = el.parentElement
    if (el === null) return
    const a = art.getBoundingClientRect()
    const v = el.getBoundingClientRect()
    el.scrollLeft = Math.round(el.scrollLeft + a.left + a.width / 2 - (v.left + v.width / 2))
    el.scrollTop = Math.round(el.scrollTop + a.top + a.height / 2 - (v.top + v.height / 2))
  })
  await settle(page)
}

/**
 * The gate (Chromium; ADR 0018 → Fidelity): these slides are bit-identical in
 * every state and thumbnail but where a budget names one; the others may
 * differ by at most these many pixels (the measured residue with a quarter's
 * headroom), per DPR. A change that moves any of them is a change of how
 * slides look.
 *
 * DPR 1 re-taken 2026-10-27: the canvas draws at the zoom's own resolution
 * below 100 % now (ADR 0018 → Placement; was 1× shrunk by the compositor),
 * so the fitted zoom's rasters are 0.53× rasters in both pages, and the
 * thumbnails are drawn at the slide panel's width (F10). DPR 2 is the
 * 2026-10-26 measurement, not re-taken.
 */
/** Slides exact at 100 % and zoomed whatever a budget says (the fitted zoom and thumbnails may have one). */
const EXACT = new Set(['spacing', 'alignment', 'autofit', 'lists', 'table'])
const RESIDUE: Record<number, Record<string, number>> = {
  1: {
    'families/fit': 460,
    'families/100%': 1810,
    'families/thumbnail': 410,
    'sizes/fit': 3925,
    'sizes/thumbnail': 440,
    'spacing/thumbnail': 15,
    'alignment/fit': 17,
    'alignment/thumbnail': 5,
    'lists/thumbnail': 3,
    'runs/thumbnail': 70,
    'scripts/fit': 525,
    'scripts/100%': 530,
    'scripts/thumbnail': 45,
    'underline/fit': 3140,
    'underline/100%': 5,
    'underline/thumbnail': 29,
    'table/fit': 23,
    'crowded/fit': 48,
    'crowded/thumbnail': 60,
  },
  2: {
    'families/fit': 2090,
    'families/100%': 4760,
    'families/thumbnail': 260,
    'sizes/fit': 7170,
    'sizes/thumbnail': 860,
    'scripts/fit': 115,
    'scripts/100%': 235,
    'scripts/thumbnail': 130,
    'underline/fit': 5,
    'underline/100%': 8,
    'underline/thumbnail': 25,
    'runs/fit': 315,
    'runs/100%': 775,
    'crowded/zoomed': 40,
    'lists/fit': 5,
    'spacing/fit': 2,
    'spacing/100%': 3,
  },
}

test('the corpus looks the same with canvas text from glyph runs as with HTMLText', async ({
  browser,
  browserName,
  request,
}) => {
  test.setTimeout(30 * 60_000)
  test.skip(
    browserName === 'webkit',
    'WebKit draws its HTML text and its canvas text differently (ADR 0018 → Fidelity, The residue)',
  )
  const deckId = await createDeck(request, `text runs artboard ${Date.now()}`)
  const { ops, slides } = textCorpusOps()
  await applyOps(request, deckId, ops)
  const html = await open(browser, deckId, 'html')
  const runs = await open(browser, deckId, 'runs')
  const results: Array<{ slide: string; state: string; softened?: boolean } & Diff> = []
  /**
   * HTMLText rasters the reference page had to soften so far: a text whose
   * raster is larger than a texture is drawn at a lower resolution there
   * (patchHTMLTextRace.ts → withinTexture; it was a black block), while the
   * runs page paints the part the canvas draws at full density — no exact
   * reference for that state.
   */
  const softenedSoFar = async (): Promise<number> =>
    await html.evaluate(
      () => window.__narrative_perf_harness!.counters()['text.raster.softened'] ?? 0,
    )
  for (const [i, s] of slides.entries()) {
    for (const p of [html, runs]) await showSlide(p, i, s)
    for (const [state, go] of [
      ['fit', fit],
      ['100%', zoomTo100],
      ['zoomed', zoomIn],
    ] as const) {
      const softenedBefore = await softenedSoFar()
      for (const p of [html, runs]) await go(p)
      const softened = (await softenedSoFar()) > softenedBefore
      const [a, b] = [
        await shot(html, '.artboard', ONLY_CANVAS_PIXELS),
        await shot(runs, '.artboard', ONLY_CANVAS_PIXELS),
      ]
      const d = diff(a, b)
      results.push({ slide: s.name, state, ...d, ...(softened ? { softened } : {}) })
      if (d.pixels !== 0) await attachDiff(`${s.name} ${state}`, a, b)
    }
  }
  const print = (): void => {
    console.log(`${browserName} dpr${DPR}:`)
    for (const r of results)
      console.log(
        `  ${r.slide}/${r.state}: differing ${r.pixels}, >8 ${r.over8}, >32 ${r.over32}, max ${r.maxDelta}${r.softened === true ? ' (the HTMLText reference softened a raster larger than a texture: not compared)' : ''}`,
      )
  }
  print()
  // Thumbnails drawn offscreen, in two new pages opened on the last slide.
  // The picture of the slide the editor shows is read from its canvas
  // (renderer/liveThumbnail.ts) when the scene settles in time, and rendered
  // offscreen otherwise — two rasterisations that differ by up to ~35 levels
  // in every glyph's edge (the editor's rasters minified vs rasters at the
  // thumbnail's size, performance.md → F10). The pages above opened on the
  // first slide, whose picture came from either, by timing: the families
  // thumbnail compared a live capture with an offscreen render (7978 pixels,
  // 2026-10-27/30). A page opened on the last slide renders every other one
  // offscreen in its opening pass, and nothing shows them live afterwards.
  const last = slides.length - 1
  const lastSlideId = await html
    .locator('[role="option"][data-slide-id]')
    .nth(last)
    .getAttribute('data-slide-id')
  expect(lastSlideId, 'the last slide has an id').not.toBeNull()
  for (const p of [html, runs]) await p.context().close()
  const thumbs = {
    html: await open(browser, deckId, 'html', lastSlideId!),
    runs: await open(browser, deckId, 'runs', lastSlideId!),
  }
  for (const p of [thumbs.html, thumbs.runs]) await showSlide(p, last, slides[last]!)
  for (let i = 0; i < last; i++) {
    const [a, b] = [
      await shot(thumbs.html, '[role="option"][data-slide-id]', ONLY_THUMBNAIL_PIXELS, i),
      await shot(thumbs.runs, '[role="option"][data-slide-id]', ONLY_THUMBNAIL_PIXELS, i),
    ]
    const d = diff(a, b)
    results.push({ slide: slides[i]!.name, state: 'thumbnail', ...d })
    if (d.pixels !== 0) await attachDiff(`${slides[i]!.name} thumbnail`, a, b)
  }
  const info = test.info()
  writeFileSync(info.outputPath('artboard.json'), JSON.stringify(results, null, 1))
  print()
  for (const p of [thumbs.html, thumbs.runs]) await p.context().close()
  expect(results.every((r) => r.sameSize)).toBe(true)
  const budget = RESIDUE[DPR] ?? {}
  for (const r of results) {
    if (r.softened === true) continue
    const key = `${r.slide}/${r.state}`
    // The exact slides at 100 % and zoomed, and every state without a budget:
    // no pixel may differ.
    const exact = EXACT.has(r.slide) && (r.state === '100%' || r.state === 'zoomed')
    const allowed = exact ? 0 : (budget[key] ?? 0)
    expect.soft(r.pixels, `${key} at DPR ${DPR}: differing pixels`).toBeLessThanOrEqual(allowed)
  }
})
