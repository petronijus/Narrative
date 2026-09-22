/**
 * e2e/pptx-drop-into-panel.spec.ts
 *
 * Drop a `.pptx` between two thumbnails and its slides have to land THERE,
 * not at the end of the deck.
 *
 * Nothing below the UI can answer that question. The index is computed from
 * where the pointer was against the live row rectangles, travels to the
 * server as tus upload metadata, and is applied to the live Y.Doc — so the
 * only honest test drives a real file drag against a real browser and then
 * reads the resulting slide order out of the document.
 *
 * The assertion is about ORDER, not count: appending would also grow the
 * deck, and did, which is exactly the bug this guards.
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'import-test.pptx')

test('a .pptx dropped between two slides is imported at that position', async ({ page }) => {
  test.setTimeout(180_000)

  const res = await page.request.post(`${API_BASE}/decks`, { data: { title: 'drop-import-test' } })
  expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
  const { id: deckId } = (await res.json()) as { id: string }

  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')

  // Three slides, so there is a real middle to aim at.
  await page.evaluate(() => {
    window.__narrative_test_api!.addSlide()
    window.__narrative_test_api!.addSlide()
  })
  const before = await page.evaluate(() => window.__narrative_test_api!.listSlideIds())
  expect(before).toHaveLength(3)

  const rows = page.locator('[data-slide-index]')
  await expect(rows).toHaveCount(3, { timeout: 15_000 })

  // Aim at the gap ABOVE the second slide: just inside its top edge, which
  // is the half of the row that resolves to "insert before me".
  const secondRow = await rows.nth(1).boundingBox()
  expect(secondRow, 'second slide row must be visible').not.toBeNull()
  const dropX = secondRow!.x + secondRow!.width / 2
  const dropY = secondRow!.y + 2

  const fixtureBase64 = readFileSync(FIXTURE).toString('base64')

  // A real file drag: the browser's own DataTransfer, carrying a real File,
  // dispatched at the coordinates above. `setInputFiles` would bypass the
  // very code under test (the pointer → index computation).
  await page.evaluate(
    ({ base64, x, y }) => {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const file = new File([bytes], 'import-test.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      })
      const dt = new DataTransfer()
      dt.items.add(file)

      const list = document.querySelector('ul[role="listbox"]')
      if (list === null) throw new Error('slides panel list not found')

      for (const type of ['dragenter', 'dragover', 'drop']) {
        list.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientX: x,
            clientY: y,
          }),
        )
      }
    },
    { base64: fixtureBase64, x: dropX, y: dropY },
  )

  // The placeholder appears in the gap while the file uploads and imports.
  await expect(page.getByTestId('pptx-import-row')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('pptx-import-row')).toHaveCount(0, { timeout: 120_000 })

  let after: string[] = []
  for (let i = 0; i < 40; i++) {
    after = await page.evaluate(() => window.__narrative_test_api!.listSlideIds())
    if (after.length > before.length) break
    await page.waitForTimeout(500)
  }

  const importedCount = after.length - before.length
  expect(importedCount, 'the drop must import at least one slide').toBeGreaterThan(0)

  const imported = after.filter((id) => !before.includes(id))
  expect(imported).toHaveLength(importedCount)

  // The shape that matters: original[0], then everything imported, then the
  // remaining originals in their old order.
  expect(after).toEqual([before[0], ...imported, before[1], before[2]])

  // And it survives the round trip through the database.
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')
  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api!.listSlideIds()), {
      timeout: 30_000,
    })
    .toEqual(after)
})

test('a legacy .ppt is refused in place, with a sentence that says what to do', async ({
  page,
}) => {
  test.setTimeout(120_000)

  const res = await page.request.post(`${API_BASE}/decks`, { data: { title: 'legacy-ppt-test' } })
  expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
  const { id: deckId } = (await res.json()) as { id: string }

  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')
  await expect(page.locator('[data-slide-index]')).toHaveCount(1, { timeout: 15_000 })

  const before = await page.evaluate(() => window.__narrative_test_api!.listSlideIds())

  await page.evaluate(() => {
    // Content is irrelevant — the refusal is on the extension, before a byte
    // is uploaded, because the parser reads OOXML out of a ZIP and a .ppt is
    // an OLE compound file.
    const file = new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])], 'old-deck.ppt', {
      type: 'application/vnd.ms-powerpoint',
    })
    const dt = new DataTransfer()
    dt.items.add(file)
    const list = document.querySelector('ul[role="listbox"]')
    if (list === null) throw new Error('slides panel list not found')
    for (const type of ['dragenter', 'dragover', 'drop']) {
      list.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    }
  })

  const row = page.getByTestId('pptx-import-row')
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).toHaveAttribute('data-status', 'error')
  await expect(row).toContainText('save it as .pptx')

  // Nothing was imported, and the row goes away when dismissed.
  expect(await page.evaluate(() => window.__narrative_test_api!.listSlideIds())).toEqual(before)
  await page.getByRole('button', { name: /Dismiss import error/ }).click()
  await expect(row).toHaveCount(0)
})
