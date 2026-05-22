import { test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', '..', '..', 'tests', 'pptx-import', 'r2-check')

test('editor-mode slide 7 canvas-only screenshot', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await mkdir(OUT, { recursive: true })
  const deckId = process.env['FIDELITY_DECK_ID']
  if (!deckId) throw new Error('Set FIDELITY_DECK_ID')

  page.on('console', (msg) => {
    if (msg.text().includes('videoRenderer') || msg.text().includes('R2'))
      console.log(`[browser] ${msg.text()}`)
  })

  await page.goto(`/deck/${deckId}`)
  await page.waitForSelector('[data-slide-index]', { timeout: 30_000 })
  await page.locator('[data-slide-index="6"]').click() // slide 7
  await page.waitForTimeout(8_000) // long settle for async poster

  await page
    .locator('canvas')
    .first()
    .screenshot({ path: join(OUT, 'editor-slide7-canvas-only.png') })
  console.log('saved canvas-only screenshot')
})
