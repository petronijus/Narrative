/**
 * text-import-parity.spec.ts — imported PowerPoint text lands where it did
 * before the run engine (ADR 0018 → Decision: Petr, 2026-10-26).
 *
 * Decks: `TEXT_IMPORT_PPTX` (comma-separated paths), by default
 * fixtures/import-test.pptx, every real deck under tests/fixtures/pptx/
 * (kept out of the repo; they reference fonts the folder does not have —
 * the fallback path), and the text corpus exported with `deck.exportPptx`
 * and imported again (autofit, line spacing, lists, CJK, Times New Roman, the
 * custom fonts — through the importer). Each is imported into a folder with
 * the test fonts.
 *
 * Per slide, at the fitted zoom and at 100 %: every text the canvas shows is
 * drawn both ways by the fidelity probe (renderer/runText/fidelityProbe.ts:
 * the run raster against a fresh HTMLText raster — the path before) and their
 * ink placement compared (inkCentres.ts: word-centre x, line-centre y, in
 * device px), plus how far the node's vertical alignment moves with the run
 * layout's height (`alignDy`).
 *
 * A report, not a gate: since 2026-10-27 the run rasters are painted for
 * where they land (ADR 0018 → Placement), up to a device px from where
 * HTMLText drew them — towards the edit overlay, which is what the text is
 * held to. The gate for imported decks is text-edit-parity.spec.ts with
 * `TEXT_EDIT_PPTX=<file>` (canvas against the edit overlay). There are no
 * PowerPoint or LibreOffice reference renders in the repo
 * (tests/fixtures/pptx/README.md → reference/ is empty).
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { seedFontFolder } from './fixtures/customFonts'
import { exportedCorpusPptx, importPptx } from './fixtures/importPptx'
import type { PerfHarnessApi } from '../src/perf/harness'
import type { RunTextDebugApi } from '../src/renderer/runText/runTextSystem'

declare global {
  interface Window {
    __narrative_perf_harness?: PerfHarnessApi
    __narrative_runText?: RunTextDebugApi
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const REAL_DECKS = join(HERE, '..', '..', '..', 'tests', 'fixtures', 'pptx')
const TOLERANCE = 0.5

function decks(): string[] {
  const env = (process.env['TEXT_IMPORT_PPTX'] ?? '').split(',').filter((s) => s !== '')
  if (env.length > 0) return env
  const real = existsSync(REAL_DECKS)
    ? readdirSync(REAL_DECKS)
        .filter((f) => f.endsWith('.pptx'))
        .map((f) => join(REAL_DECKS, f))
    : []
  return [join(HERE, 'fixtures', 'import-test.pptx'), ...real, 'corpus']
}

interface Row {
  deck: string
  slide: number
  state: string
  object: string | null
  text: string
  runs: boolean
  wordDx: number
  lineDy: number
  lines: number
  linesHtml: number
  alignDy: number
}

async function compareSlide(page: Page): Promise<
  Array<{
    objectId: string | null
    text: string
    runs: boolean
    placement?: { wordDx: number; lineDy: number; lines: number; linesOther: number }
    alignDy?: number
  }>
> {
  return await page.evaluate(async () => (await window.__narrative_runText!.compare()) as never)
}

test('imported decks put their text where the HTMLText path did', async ({ browser, request }) => {
  test.setTimeout(90 * 60_000)
  const { folderId, families } = await seedFontFolder(request, `text import parity ${Date.now()}`)
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  const rows: Row[] = []
  for (const deck of decks()) {
    const name = deck === 'corpus' ? 'corpus (exported, imported)' : deck.split('/').pop()!
    const file = deck === 'corpus' ? await exportedCorpusPptx(request, folderId, families) : deck
    const { deckId, slideCount } = await importPptx(
      request,
      browser,
      folderId,
      file,
      `import parity ${Date.now()}`,
    )
    await page.goto(`/deck/${deckId}?perf=1`)
    await expect
      .poll(() => page.evaluate(() => window.__narrative_runText !== undefined), {
        timeout: 60_000,
      })
      .toBe(true)
    for (let i = 0; i < slideCount; i++) {
      await page.locator('[role="option"][data-slide-id]').nth(i).click()
      for (const [state, button] of [
        ['fit', 'Fit to screen'],
        ['100%', 'Reset zoom to 100%'],
      ] as const) {
        await page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
        await page.getByRole('button', { name: button }).click()
        await page.mouse.move(2, 998)
        const settled = await page.evaluate(() =>
          window.__narrative_perf_harness!.settle({ quietMs: 600, timeoutMs: 90_000 }),
        )
        expect(settled.ok, `${name} slide ${i + 1} settled`).toBe(true)
        for (const d of await compareSlide(page)) {
          if (d.placement === undefined) continue
          rows.push({
            deck: name,
            slide: i + 1,
            state,
            object: d.objectId,
            text: d.text.replace(/<[^>]+>/g, '').slice(0, 50),
            runs: d.runs,
            wordDx: d.placement.wordDx,
            lineDy: d.placement.lineDy,
            lines: d.placement.linesOther,
            linesHtml: d.placement.lines,
            alignDy: d.alignDy ?? 0,
          })
        }
      }
    }
  }
  await context.close()
  writeFileSync(test.info().outputPath('import-parity.json'), JSON.stringify(rows, null, 1))
  const over = rows.filter(
    (r) =>
      r.wordDx > TOLERANCE ||
      r.lineDy > TOLERANCE ||
      Math.abs(r.alignDy) > TOLERANCE ||
      r.lines !== r.linesHtml,
  )
  for (const deck of [...new Set(rows.map((r) => r.deck))]) {
    const mine = rows.filter((r) => r.deck === deck)
    const worst = (k: 'wordDx' | 'lineDy' | 'alignDy'): string =>
      mine.reduce((m, r) => Math.max(m, Math.abs(r[k])), 0).toFixed(2)
    console.log(
      `${deck}: ${mine.length} texts (${mine.filter((r) => !r.runs).length} fell back), worst word Δx ${worst('wordDx')}, line Δy ${worst('lineDy')}, align Δy ${worst('alignDy')}`,
    )
  }
  for (const r of over)
    console.log(
      `  over: ${r.deck} s${r.slide} ${r.state} ${r.object ?? '?'} "${r.text}": word Δx ${r.wordDx.toFixed(2)} line Δy ${r.lineDy.toFixed(2)} align Δy ${r.alignDy.toFixed(2)} lines ${r.linesHtml}→${r.lines}`,
    )
  // Report only (see the header): every text over 0.5 px is listed above.
  expect(rows.length, 'texts compared').toBeGreaterThan(0)
})
