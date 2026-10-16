/**
 * Diagnostic capture against an imported pptx deck — it needs a deck that only
 * exists after a local import run, so it skips unless FIDELITY_DECK_ID names
 * one. It used to throw instead, which reported a missing opt-in as a suite
 * failure on every machine that had not run the import.
 */

import { test } from './fixtures/test'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', '..', '..', 'tests', 'pptx-import', 'r2-check')
const FIDELITY_DECK_ID = process.env['FIDELITY_DECK_ID'] ?? ''

test('compare slide 7 in editor vs present', async ({ page }) => {
  test.skip(
    FIDELITY_DECK_ID === '',
    'fidelity capture — set FIDELITY_DECK_ID to an imported deck to run it',
  )
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await mkdir(OUT, { recursive: true })
  const deckId = FIDELITY_DECK_ID

  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('videoRenderer')) console.log(`[browser] ${text}`)
  })

  // Editor view → slide 7
  await page.goto(`/deck/${deckId}`)
  await page.waitForSelector('[data-slide-index]', { timeout: 30_000 })
  await page.locator('[data-slide-index="6"]').click()
  await page.waitForTimeout(5_000)
  await page.screenshot({ path: join(OUT, 'editor-slide7.png'), fullPage: false })
  console.log(`[r2] editor slide 7 screenshot saved`)

  // Present view → arrow to slide 7
  await page.goto(`/deck/${deckId}/present`)
  await page.waitForSelector('[data-testid="slide-container"]', { timeout: 30_000 })
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(400)
  }
  await page.waitForTimeout(5_000)
  const container = page.locator('[data-testid="slide-container"]').first()
  await container.screenshot({ path: join(OUT, 'present-slide7.png') })
  console.log(`[r2] present slide 7 screenshot saved`)
})
