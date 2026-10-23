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
  expect(r.ok, `the scene settled: ${r.reason ?? ''}`).toBe(true)
}

async function open(browser: Browser, deckId: string, dpr: number): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: dpr })
  await context.addInitScript(() => {
    ;(globalThis as { __narrative_textEngine?: string }).__narrative_textEngine = 'runs'
  })
  const page = await context.newPage()
  await page.goto(`/deck/${deckId}?perf=1`)
  await expect
    .poll(() => page.evaluate(() => window.__narrative_perf_harness?.version ?? 0), {
      timeout: 30_000,
    })
    .toBe(1)
  await expect.poll(() => page.evaluate(() => window.__narrative_runText !== undefined)).toBe(true)
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

test.describe('canvas text from glyph runs', () => {
  test.setTimeout(20 * 60_000)

  test('draws the corpus as HTMLText does, text by text', async ({
    browser,
    browserName,
    request,
  }) => {
    const deckId = await createDeck(request, `text runs parity ${Date.now()}`)
    const { ops, slides } = textCorpusOps()
    await applyOps(request, deckId, ops)
    const rows: Row[] = []
    for (const dpr of [1, 2]) {
      const page = await open(browser, deckId, dpr)
      for (const [i, s] of slides.entries()) {
        await showSlide(page, i, s)
        for (const [state, go] of [
          ['fit', fit],
          ['100%', zoomTo100],
          ['zoomed', zoomIn],
        ] as const) {
          await go(page)
          const diffs = await page.evaluate(() => window.__narrative_runText!.compare())
          for (const d of diffs) rows.push({ ...d, slide: s.name, state, dpr })
        }
      }
      await page.context().close()
    }
    const info = test.info()
    writeFileSync(info.outputPath('parity.json'), JSON.stringify(rows, null, 1))
    await info.attach('parity.json', { path: info.outputPath('parity.json') })

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
    const worst = [...runs].sort((a, b) => b.over32 - a.over32).slice(0, 25)
    for (const r of worst)
      console.log(
        `${r.slide}/${r.state}/dpr${r.dpr} ${r.objectId ?? '?'}: differing ${r.differing}, >8 ${r.over8}, ` +
          `>32 ${r.over32}, max ${r.maxDelta}, ink ${r.inkHtml}/${r.inkCanvas} — ${r.text.slice(0, 60)}`,
      )
    expect(runs.length, 'texts drawn from runs').toBeGreaterThan(0)
  })
})
