import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test, expect } from './fixtures/test'

/**
 * Diagnostic: import a real .pptx fixture and screenshot every slide in
 * present mode at 1920×1080. The output PNGs sit next to the
 * LibreOffice reference renders under `tests/fixtures/pptx/reference/`
 * so a separate report script can stitch them into a side-by-side HTML
 * for visual triage.
 *
 * Not a regression test — runtime is dominated by the upload + parse
 * step and the assertions are intentionally loose. Run it on demand:
 *
 *   # full path: upload + parse + capture (slow, 5+ min on 52 MB)
 *   pnpm --filter web test:e2e pptx-import-fidelity
 *
 *   # fast path: reuse an already-imported deck (just capture)
 *   FIDELITY_DECK_ID=c99uHzklHl83 pnpm --filter web test:e2e pptx-import-fidelity
 *
 * Requires the dev stack (web + server + worker) to be up.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..', '..')

// Diagnostic fixture is kept out of the public repo (real-world deck lives in
// the private overlay). Point PPTX_FIDELITY_DECK at your own .pptx under
// tests/fixtures/pptx/ to run this; otherwise the test skips.
const DECK_NAME = process.env['PPTX_FIDELITY_DECK'] ?? 'sample-deck'
const FIXTURE_PATH = join(REPO_ROOT, 'tests', 'fixtures', 'pptx', `${DECK_NAME}.pptx`)
const OUTPUT_DIR = join(REPO_ROOT, 'tests', 'pptx-import', 'imported', DECK_NAME)

test.describe('PPTX import fidelity', () => {
  test('captures one screenshot per imported slide in present mode', async ({ page }) => {
    test.skip(
      !process.env['FIDELITY_DECK_ID'] && !existsSync(FIXTURE_PATH),
      `fidelity fixture ${DECK_NAME}.pptx not present (kept in the private overlay; set PPTX_FIDELITY_DECK)`,
    )
    test.setTimeout(600_000) // 10 min — 52 MB upload + parse + present-mode render

    // 1920×1080 to match the LibreOffice reference PNGs (which are 1920×1081
    // because LibreOffice exports include a 1px footer; the diff harness
    // ignores the last row).
    await page.setViewportSize({ width: 1920, height: 1080 })

    await mkdir(OUTPUT_DIR, { recursive: true })

    page.on('pageerror', (e) => console.error(`pageerror: ${e.message}`))
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error(`console.error: ${msg.text()}`)
    })

    let deckId: string
    let slideCount: number

    const reuseDeckId = process.env['FIDELITY_DECK_ID']

    if (reuseDeckId) {
      // ─── Fast path: skip import, just capture an existing deck ─────────────
      deckId = reuseDeckId
      console.log(`[fidelity] reusing deck id from env: ${deckId}`)

      // Hit the API to count slides so we know how many ArrowRights to send.
      const deckResp = await page.request.get(`http://localhost:3001/decks/${deckId}`)
      expect(deckResp.ok(), `GET /decks/${deckId} failed`).toBe(true)

      // The slide count isn't exposed by GET /decks/:id — open the editor and
      // read it from the SlidesPanel DOM instead.
      await page.goto(`/deck/${deckId}`)
      await page.waitForSelector('[data-slide-index]', { timeout: 15_000 })
      slideCount = await page.locator('[data-slide-index]').count()
      console.log(`[fidelity] reused deck has ${slideCount} slides`)
    } else {
      // ─── Slow path: full upload + parse + import ──────────────────────────
      await page.goto('/')
      await expect(page.getByRole('button', { name: /Import PowerPoint/i })).toBeVisible({
        timeout: 15_000,
      })

      // setInputFiles' inline-buffer path is capped at 50 MB; this fixture
      // is 52 MB, so we pass the path on disk instead. Playwright streams
      // the file directly to the browser without the limit.
      const fileInput = page.locator('input[type="file"][accept*="pptx"]').first()
      await fileInput.setInputFiles(FIXTURE_PATH)

      const dialog = page.getByRole('dialog', { name: /Import PowerPoint deck/i })
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      await dialog.getByRole('button', { name: /^Drafts/ }).click()
      await dialog.getByRole('button', { name: /^Import$/ }).click()

      const successText = dialog.getByText(/Imported \d+ slides/i)
      await expect(successText).toBeVisible({ timeout: 300_000 })

      const summary = (await successText.textContent()) ?? ''
      const slideCountMatch = /Imported (\d+) slides/.exec(summary)
      slideCount = slideCountMatch ? parseInt(slideCountMatch[1]!, 10) : 0
      expect(slideCount).toBeGreaterThan(0)
      console.log(`[fidelity] import finished — ${slideCount} slides`)

      // The dialog stays open when there are notices (missing fonts,
      // compat warnings, font-fallback advisory). The harness isn't
      // exercising the upload UI here — we want the raw fallback
      // render — so dismiss whichever CTA is showing.
      const dismissBtn = dialog.getByRole('button', {
        name: /^(Open deck|Skip & open deck)$/,
      })
      if (await dismissBtn.isVisible().catch(() => false)) {
        await dismissBtn.click()
      }

      await page.waitForURL(/\/deck\/[A-Za-z0-9_-]+/, { timeout: 30_000 })
      deckId = /\/deck\/([A-Za-z0-9_-]+)/.exec(page.url())![1]!
      console.log(`[fidelity] deck id: ${deckId}`)
    }

    // ─── 2. Present mode is the cleanest screenshot surface ─────────────────
    await page.goto(`/deck/${deckId}/present`)
    await page.waitForSelector('[data-testid="slide-container"]', { timeout: 30_000 })
    // Long settle: Pixi reconciler + initial image-fill loads.
    await page.waitForTimeout(3000)

    for (let i = 1; i <= slideCount; i++) {
      const container = page.locator('[data-testid="slide-container"]').first()

      // Wait for any pending in-flight images on this slide. Three networks
      // could matter: imgproxy variant, HLS poster, raw uploaded asset.
      try {
        await page.waitForLoadState('networkidle', { timeout: 8_000 })
      } catch {
        // networkidle can flap when HLS keeps polling; not fatal.
      }
      // Extra paint settle — animations + texture upload + video-poster
      // imgproxy fetch (the imgproxy variant for a fresh asset takes ~1s
      // to generate the first time).
      await page.waitForTimeout(2500)

      await container.screenshot({
        path: join(OUTPUT_DIR, `Slide${i}.png`),
      })
      console.log(`[fidelity] captured Slide${i}.png`)

      if (i < slideCount) {
        await page.keyboard.press('ArrowRight')
        await page.waitForTimeout(600)
      }
    }

    console.log(`[fidelity] done — output in ${OUTPUT_DIR}`)
  })
})
