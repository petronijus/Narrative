/**
 * layers-panel.spec.ts — the Inspector's Layers list: a row selects its object
 * (shift adds), the × deletes it, and dropping a row on another moves the layer.
 *
 * The rows are memoised (perf/crowded-slide): they get stable callbacks that
 * read the panel's current state, so a stale closure would show up here as a
 * click selecting the wrong object or a drop landing on the wrong slot.
 */

import { expect, test, type Page } from './fixtures/test'
import { provisionDeckWithText } from './fixtures/provisionDeck'

const row = (page: Page, id: string) =>
  page.getByRole('listitem').filter({ hasText: `rectangle-${id}` })

const order = (page: Page) => page.evaluate(() => window.__narrative_test_api!.objectIds())
const selection = (page: Page) => page.evaluate(() => window.__narrative_test_api!.getSelection())

test('layers panel: select, shift-select, reorder by drop, delete', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await provisionDeckWithText(page, { objectId: 'text0', text: 'layers' })
  await page.evaluate(() => {
    const api = window.__narrative_test_api!
    for (const [i, id] of ['aaaa', 'bbbb', 'cccc'].entries()) {
      api.addRect({ id, x: 100 + i * 300, y: 600, w: 200, h: 150 })
    }
    api.setSelection(['aaaa'])
  })
  await expect(page.getByText('Layers (4)')).toBeVisible()
  // Front of the canvas (last object) is the top row.
  expect(await order(page)).toEqual(['text0', 'aaaa', 'bbbb', 'cccc'])

  await row(page, 'bbbb').click()
  expect(await selection(page)).toEqual(['bbbb'])

  await row(page, 'cccc').click({ modifiers: ['Shift'] })
  expect((await selection(page)).sort()).toEqual(['bbbb', 'cccc'])

  // Drop the front layer on the lower half of the last row: it goes to the back.
  const text = page.getByRole('listitem').filter({ hasText: 'text-text' })
  const box = (await text.boundingBox())!
  await row(page, 'cccc').dragTo(text, { targetPosition: { x: box.width / 2, y: box.height - 2 } })
  await expect.poll(() => order(page)).toEqual(['cccc', 'text0', 'aaaa', 'bbbb'])

  // The row's × deletes its layer (and drops it from the selection).
  await row(page, 'aaaa').hover()
  await row(page, 'aaaa').getByRole('button', { name: 'Delete layer' }).click()
  await expect.poll(() => order(page)).toEqual(['cccc', 'text0', 'bbbb'])
  await expect(page.getByText('Layers (3)')).toBeVisible()
})
