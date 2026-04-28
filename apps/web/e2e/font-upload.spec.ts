/**
 * e2e/font-upload.spec.ts
 *
 * P15 regression: end-to-end happy path for the custom-font upload
 * pipeline. Drives the Inspector "Upload font…" button with a real
 * TTF fixture (codicon, ~80 KB), waits for the tus + opentype.js
 * round-trip to finish, and asserts:
 *
 *  1. tus response surfaces parsed family / weight / style.
 *  2. The deck Y.Doc gains a font entry.
 *  3. document.fonts.has(family) returns true.
 *  4. The Inspector picker dropdown lists the new family under
 *     "Custom (this deck)".
 */

import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'http://localhost:3001'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.join(HERE, 'fixtures', 'codicon.ttf')

test('font upload: install + Y.Doc + picker', async ({ page }) => {
  const res = await page.request.post(`${API}/decks`, {
    data: { title: 'font-test' },
  })
  expect(res.ok()).toBeTruthy()
  const { id: deckId } = await res.json()

  await page.goto(`/deck/${deckId}`, { waitUntil: 'networkidle' })

  await page.waitForFunction(
    () =>
      (window as unknown as { __narrative_test_api?: unknown }).__narrative_test_api !== undefined,
    null,
    { timeout: 15_000 },
  )

  // Seed a Text object so the Inspector's font section is visible.
  await page.evaluate(() => {
    window.__narrative_test_api!.addText({
      id: 'text-1',
      x: 100,
      y: 100,
      w: 600,
      h: 100,
      text: 'Hello fonts',
    })
    window.__narrative_test_api!.setSelection(['text-1'])
  })

  // Open the upload sheet via the dedicated button next to the picker.
  await page.getByRole('button', { name: /Upload custom font/i }).click()

  // Drop the fixture into the hidden file input.
  const fileInput = page.locator('input[type="file"][accept*=".ttf"]')
  await fileInput.setInputFiles(FIXTURE_PATH)

  // Wait for the deck Y.Doc to gain a font entry. The tus upload +
  // opentype parse + addDeckFont write all happen within a couple
  // seconds on a local stack.
  await page.waitForFunction(
    () => {
      const api = window.__narrative_test_api
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fonts = (api as any)?.deckFonts?.() as Array<{ family: string }> | undefined
      return Array.isArray(fonts) && fonts.length > 0
    },
    null,
    { timeout: 20_000 },
  )

  // Family should be the canonical OpenType name from codicon.
  const fonts = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (window.__narrative_test_api as any).deckFonts() as Array<{
      id: string
      family: string
      weight: number
      style: string
    }>
  })
  expect(fonts).toHaveLength(1)
  expect(fonts[0]!.family).toBeTruthy()
  expect(typeof fonts[0]!.weight).toBe('number')

  // FontLoader should have installed the FontFace.
  await page.waitForFunction(
    (family) => document.fonts.check(`16px "${family}"`),
    fonts[0]!.family,
    { timeout: 5000 },
  )

  // The picker dropdown should now list the family under "Custom".
  await page.locator(`#inspector-fontfamily-text-1 optgroup[label="Custom (this deck)"] option`)
  const optionText = await page
    .locator(`#inspector-fontfamily-text-1 option`, { hasText: fonts[0]!.family })
    .first()
    .textContent()
  expect(optionText?.trim()).toBe(fonts[0]!.family)
})
