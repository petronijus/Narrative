/**
 * e2e/pptx-append.spec.ts
 *
 * "I uploaded it as append and nothing happened."
 *
 * Append writes a new `deck_updates` row straight into Postgres. The question
 * this settles is whether the deck you are looking at ever hears about it:
 * the open document is held in memory by Hocuspocus, so a row appearing in
 * the database underneath it is not, on its own, something the editor sees.
 *
 * Slide counts are read from the live Y.Doc through the dev test API, before
 * and after the append, and then again after a reload — which separates "the
 * append did nothing" from "the append worked and the open editor was never
 * told".
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'import-test.pptx')

test('appending a .pptx shows the new slides in the open deck', async ({ page }) => {
  test.setTimeout(180_000)

  const res = await page.request.post(`${API_BASE}/decks`, { data: { title: 'append-test' } })
  expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
  const { id: deckId } = (await res.json()) as { id: string }

  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')

  const before = await page.evaluate(() => window.__narrative_test_api!.listSlideIds().length)

  // Use the toolbar's own hidden input, so this drives the real feature
  // rather than calling the API behind its back.
  await page.setInputFiles(
    'input[type="file"][accept*="presentationml"]',
    {
      name: 'import-test.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: readFileSync(FIXTURE),
    },
    { timeout: 15_000 },
  )

  // The button shows a spinner while the request is in flight; wait for it to
  // finish rather than guessing a duration.
  await expect(page.getByRole('button', { name: 'Append .pptx slides to this deck' })).toBeEnabled({
    timeout: 120_000,
  })

  // Give the open document a generous chance to notice on its own.
  let live = before
  for (let i = 0; i < 20; i++) {
    live = await page.evaluate(() => window.__narrative_test_api!.listSlideIds().length)
    if (live > before) break
    await page.waitForTimeout(500)
  }

  // And the same deck after a reload, which rebuilds the doc from the rows.
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')
  let afterReload = 0
  for (let i = 0; i < 20; i++) {
    afterReload = await page.evaluate(() => window.__narrative_test_api!.listSlideIds().length)
    if (afterReload > before) break
    await page.waitForTimeout(500)
  }

  console.log(
    `[append] slides before=${before} live-after-append=${live} after-reload=${afterReload}`,
  )

  expect(afterReload, 'the append must reach the database at all').toBeGreaterThan(before)
  expect(live, 'the open deck must show appended slides without a reload').toBeGreaterThan(before)
})
