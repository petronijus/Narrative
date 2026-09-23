/**
 * e2e/pptx-drop-import.spec.ts
 *
 * Dropping a .pptx on the background of a deck list imports it as a new deck.
 *
 * The folders home page had this; the page you land on *inside* a folder —
 * the one you are actually looking at when you think "I'll put a deck here" —
 * did not. Both now share `usePptxImport`, so this covers the page that was
 * missing it and the drop path that both rely on.
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'import-test.pptx')

/**
 * Playwright cannot drag a file in from the desktop, so the drop is
 * synthesised: build a DataTransfer from the file's bytes and dispatch the
 * same event sequence a real drag produces. The handlers under test are
 * ordinary DOM listeners, so they cannot tell the difference.
 */
async function dropFileOnBody(
  page: import('@playwright/test').Page,
  bytes: Buffer,
  name: string,
): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ({ data, filename }) => {
      const dt = new DataTransfer()
      dt.items.add(
        new File([new Uint8Array(data)], filename, {
          type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        }),
      )
      return dt
    },
    { data: [...bytes], filename: name },
  )

  const root = page.locator('div.h-screen').first()
  await root.dispatchEvent('dragenter', { dataTransfer })
  await root.dispatchEvent('dragover', { dataTransfer })
  await root.dispatchEvent('drop', { dataTransfer })
}

test('dropping a .pptx inside a folder imports it as a new deck', async ({ page }) => {
  test.setTimeout(180_000)

  // A folder to land in. The drafts folder always exists, but a fresh one
  // keeps the assertion about "a new deck appeared" unambiguous.
  const res = await page.request.post(`${API_BASE}/folders`, {
    data: { name: `drop-import-${Date.now()}` },
  })
  expect(res.ok(), `folder creation failed: ${res.status()}`).toBe(true)
  const { id: folderId } = (await res.json()) as { id: string }

  await page.goto(`/folder/${folderId}`)
  await page.waitForSelector('text=All folders', { timeout: 30_000 })

  const bytes = readFileSync(FIXTURE)

  // Dragging over the page announces the drop target.
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer()
    d.items.add(new File([new Uint8Array([1, 2, 3])], 'x.pptx'))
    return d
  })
  const root = page.locator('div.h-screen').first()
  await root.dispatchEvent('dragenter', { dataTransfer: dt })
  await expect(page.getByText('Drop a .pptx to import')).toBeVisible()

  // Now the real thing.
  await dropFileOnBody(page, bytes, 'import-test.pptx')

  // Inside a folder the page is the choice: the dialog opens already
  // importing into it — no folder list, no "create folder", no confirm click.
  const dialog = page.getByRole('dialog', { name: /Import PowerPoint deck/i })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await expect(dialog.getByText(/Importing into/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: /Create new folder/ })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: /^Import$/ })).toHaveCount(0)

  // A deck whose content did not survive the import cleanly pauses on a
  // warnings summary and waits to be acknowledged, so dismiss it if it shows.
  const openDeck = page.getByRole('button', { name: /open deck/i })
  await Promise.race([
    page.waitForURL(/\/deck\/[\w-]+/, { timeout: 120_000 }),
    openDeck
      .waitFor({ state: 'visible', timeout: 120_000 })
      .then(() => openDeck.click())
      .catch(() => undefined),
  ])

  // Lands in the new deck.
  await page.waitForURL(/\/deck\/[\w-]+/, { timeout: 60_000 })
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 60_000 })
    .toBe('object')
  const slideCount = await page.evaluate(() => window.__narrative_test_api!.listSlideIds().length)
  console.log(`[drop-import] landed on ${page.url()} with ${slideCount} slides`)
  expect(slideCount, 'the imported deck should have slides').toBeGreaterThan(0)
})

test('dropping a .pptx on the folders home still works after the refactor', async ({ page }) => {
  test.setTimeout(120_000)

  await page.goto('/')
  await page.waitForSelector('text=New deck', { timeout: 30_000 })

  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer()
    d.items.add(new File([new Uint8Array([1, 2, 3])], 'x.pptx'))
    return d
  })
  const root = page.locator('div.h-screen').first()
  await root.dispatchEvent('dragenter', { dataTransfer: dt })

  await expect(page.getByText('Drop a .pptx to import')).toBeVisible()
  // Home offers a folder choice, unlike a folder page which already has one.
  await expect(page.getByText(/pick a folder on the next step/i)).toBeVisible()

  // Dragging back out clears the prompt rather than leaving it stuck.
  await root.dispatchEvent('dragleave', { dataTransfer: dt })
  await expect(page.getByText('Drop a .pptx to import')).toBeHidden()
})
