/**
 * text-runs-parity.spec.ts — canvas text drawn from glyph runs (ADR 0018)
 * against HTMLText, text by text, over the text corpus
 * (fixtures/textCorpus.ts: families, weights, sizes, spacing, alignment,
 * autofit, lists, runs, transforms, stroke, underline, scripts).
 *
 * The corpus deck is opened with the run engine (`__narrative_textEngine =
 * 'runs'`). On every slide, at the fitted zoom, at 100 % and after a zoom
 * commit, each text on the canvas is drawn both ways in the page
 * (`window.__narrative_runText.compare()`, renderer/runText/fidelityProbe.ts):
 * the texture the canvas shows and a fresh HTMLText raster of the same node,
 * each over white at the text's resolution, compared channel by channel.
 * DPR 1 and 2. The rows go to `parity.json` in the test's output; the
 * assertions are the gate's current bounds (ADR 0018 → Fidelity).
 *
 * `just e2e -g text-runs-parity` (Chromium), `just e2e-webkit -g
 * text-runs-parity` (WebKit).
 */

import { writeFileSync } from 'node:fs'
import type { Browser, Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { textCorpusOps, type CorpusSlide } from './fixtures/textCorpus'
import { applyOps, createDeck } from './perf/lib/seed'
import type { PerfHarnessApi } from '../src/perf/harness'
import type { RunTextDebugApi } from '../src/renderer/runText/runTextSystem'
import type { TextDiff } from '../src/renderer/runText/fidelityProbe'

declare global {
  interface Window {
    __narrative_perf_harness?: PerfHarnessApi
    __narrative_runText?: RunTextDebugApi
  }
}

const VIEWPORT = { width: 1600, height: 1000 }

async function settle(page: Page): Promise<void> {
  const r = await page.evaluate(() =>
    window.__narrative_perf_harness!.settle({ quietMs: 600, timeoutMs: 60_000 }),
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

async function open(browser: Browser, deckId: string, dpr: number): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: dpr })
  await context.addInitScript(() => {
    ;(globalThis as { __narrative_textEngine?: string }).__narrative_textEngine = 'runs'
    // Text by text against HTMLText's raster: drawn as HTMLText placed it,
    // not for the device grid (runText/flag.ts → htmlTextCompatible).
    ;(
      globalThis as { __narrative_textHtmlTextCompatible?: boolean }
    ).__narrative_textHtmlTextCompatible = true
  })
  const page = await context.newPage()
  await page.goto(`/deck/${deckId}?perf=1`)
  await expect
    .poll(() => page.evaluate(() => window.__narrative_perf_harness?.version ?? 0), {
      timeout: 30_000,
    })
    .toBe(1)
  await expect
    .poll(() => page.evaluate(() => window.__narrative_runText !== undefined), { timeout: 60_000 })
    .toBe(true)
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
  await page.mouse.move(2, VIEWPORT.height - 2)
  await settle(page)
}

interface Row extends TextDiff {
  slide: string
  state: string
  dpr: number
}

/** `TEXT_RUNS_SLIDES=autofit,underline`: only those corpus slides (by name). */
const ONLY = (process.env['TEXT_RUNS_SLIDES'] ?? '').split(',').filter((s) => s !== '')
/** `TEXT_RUNS_IMAGES=n`: write both rasters of up to n differing texts per state. */
const IMAGES = Number(process.env['TEXT_RUNS_IMAGES'] ?? '0')

test.describe('canvas text from glyph runs', () => {
  test.setTimeout(40 * 60_000)

  for (const dpr of [1, 2])
    test(`draws the corpus as HTMLText does, text by text (DPR ${dpr})`, async ({
      browser,
      browserName,
      request,
    }) => {
      test.skip(
        browserName === 'webkit',
        'WebKit keeps HTMLText (ADR 0018 → Fidelity); text-runs-first-raster still runs there',
      )
      const deckId = await createDeck(request, `text runs parity ${Date.now()}`)
      const { ops, slides } = textCorpusOps()
      await applyOps(request, deckId, ops)
      const rows: Row[] = []
      {
        const page = await open(browser, deckId, dpr)
        for (const [i, s] of slides.entries()) {
          if (ONLY.length > 0 && !ONLY.includes(s.name)) continue
          await showSlide(page, i, s)
          for (const [state, go] of [
            ['fit', fit],
            ['100%', zoomTo100],
            ['zoomed', zoomIn],
          ] as const) {
            await go(page)
            const diffs = await page.evaluate(
              (n) => window.__narrative_runText!.compare({ images: n }),
              IMAGES,
            )
            for (const d of diffs) {
              if (d.images !== undefined) {
                for (const [k, url] of d.images.entries())
                  writeFileSync(
                    test
                      .info()
                      .outputPath(
                        `${s.name}-${state}-dpr${dpr}-${d.objectId ?? 'x'}-${k === 0 ? 'html' : 'runs'}.png`,
                      ),
                    Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'),
                  )
                delete d.images
              }
              rows.push({ ...d, slide: s.name, state, dpr })
            }
          }
        }
        await page.context().close()
      }
      const info = test.info()
      writeFileSync(info.outputPath(`parity-dpr${dpr}.json`), JSON.stringify(rows, null, 1))

      const runs = rows.filter((r) => r.runs)
      const exact = runs.filter((r) => r.differing === 0)
      const summary = {
        browser: browserName,
        texts: rows.length,
        fromRuns: runs.length,
        fellBack: rows.length - runs.length,
        exact: exact.length,
        over32: runs.filter((r) => r.over32 > 0).length,
        maxDelta: Math.max(0, ...runs.map((r) => r.maxDelta)),
      }
      console.log(JSON.stringify(summary))
      const remeasured = rows.filter(
        (r) =>
          r.measuredHtml.width !== r.measuredRuns.width ||
          r.measuredHtml.height !== r.measuredRuns.height,
      )
      console.log(`measured differently: ${remeasured.length} of ${rows.length}`)
      for (const r of remeasured.slice(0, 25))
        console.log(
          `  ${r.slide}/${r.state}/dpr${r.dpr} ${r.objectId ?? '?'}: html ${r.measuredHtml.width}×${r.measuredHtml.height} runs ${r.measuredRuns.width}×${r.measuredRuns.height} — ${r.text.slice(0, 50)}`,
        )
      const worst = [...runs].sort((a, b) => b.over32 - a.over32).slice(0, 25)
      for (const r of worst)
        console.log(
          `${r.slide}/${r.state}/dpr${r.dpr} ${r.objectId ?? '?'}: differing ${r.differing}, >8 ${r.over8}, ` +
            `measured html ${r.measuredHtml.width}×${r.measuredHtml.height} runs ${r.measuredRuns.width}×${r.measuredRuns.height}, ` +
            `>32 ${r.over32}, max ${r.maxDelta}, ink ${r.inkHtml}/${r.inkCanvas} — ${r.text.slice(0, 60)}`,
        )
      expect(runs.length, 'texts drawn from runs').toBeGreaterThan(0)
      // Bounds, alignment and autofit come from the run layout: it must measure
      // every text as Pixi's own measurement does.
      expect(remeasured.length, 'texts the run layout measured otherwise').toBe(0)
    })
})
