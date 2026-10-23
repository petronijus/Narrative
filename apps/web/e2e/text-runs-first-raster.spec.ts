/**
 * text-runs-first-raster.spec.ts — a text's first raster in a registered face
 * is never blank (ADR 0018, phase 1).
 *
 * HTMLText in WebKit drew some texts in an embedded face (Inter) as nothing
 * on their first rasters (performance.md → E7: 1–5 of 24 present texts per
 * run, after Pixi's 100 ms wait). The run engine never embeds a face: the
 * workers get every face's bytes once and a paint waits for the faces posted
 * before it (runText/textRasterWorker.ts). Each run opens a fresh page (no
 * face loaded anywhere yet) on the present scene's Inter slides, waits for the
 * scene, and checks every text on the canvas has ink — and how many of the
 * same texts HTMLText, rasterised fresh in that page, drew blank (reported:
 * the failure the engine removes).
 *
 * `just e2e-webkit -g text-runs-first-raster` is the run that matters;
 * Chromium runs it too.
 */

import type { Browser, Page } from '@playwright/test'
import { presentTextOps } from '@narrative/perf'
import { expect, test } from './fixtures/test'
import { applyOps, createDeck } from './perf/lib/seed'
import type { PerfHarnessApi } from '../src/perf/harness'
import type { RunTextDebugApi } from '../src/renderer/runText/runTextSystem'

declare global {
  interface Window {
    __narrative_perf_harness?: PerfHarnessApi
    __narrative_runText?: RunTextDebugApi
  }
}

async function open(browser: Browser, deckId: string, ids: string[]): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  })
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
  await expect
    .poll(
      () =>
        page.evaluate(
          (want) => want.every((id) => window.__narrative_perf_harness!.mountedIds().includes(id)),
          ids,
        ),
      { timeout: 60_000 },
    )
    .toBe(true)
  const r = await page.evaluate(() =>
    window.__narrative_perf_harness!.settle({ quietMs: 600, timeoutMs: 60_000 }),
  )
  expect(r.ok, `settled: ${r.reason ?? ''}`).toBe(true)
  return page
}

test('every text’s first raster in a registered face has its glyphs', async ({
  browser,
  browserName,
  request,
}) => {
  test.setTimeout(6 * 60_000)
  const deckId = await createDeck(request, `text runs first raster ${Date.now()}`)
  const scene = presentTextOps(2, 'Inter')
  await applyOps(request, deckId, scene.ops)
  const ids = scene.perSlide[0]!
  let blankHtml = 0
  let texts = 0
  for (let run = 0; run < 3; run++) {
    const page = await open(browser, deckId, ids)
    const rows = await page.evaluate(() => window.__narrative_runText!.compare())
    const drawn = rows.filter((r) => r.runs)
    expect(drawn.length, 'texts drawn from runs').toBeGreaterThanOrEqual(ids.length - 1)
    for (const r of drawn) {
      expect(r.inkCanvas, `${r.objectId ?? r.text} has ink (run ${run})`).toBeGreaterThan(0)
    }
    texts += drawn.length
    blankHtml += drawn.filter((r) => r.inkHtml === 0).length
    await page.context().close()
  }
  console.log(
    `${browserName}: ${texts} texts in 3 fresh pages, all with ink; HTMLText drew ${blankHtml} of them blank`,
  )
})
