/**
 * e2e/slide-multi-select.spec.ts
 *
 * Selecting a run of slides in the panel: click the first, shift-click the
 * last, then delete or move them together.
 *
 * Shift used to toggle the one slide it was clicking, so "click the first,
 * shift-click the last" selected exactly those two and nothing between, and
 * Delete then took only one of them. Both are gestures, and the focus model
 * they run through is a real browser's — jsdom's is approximate, which is
 * why this lives in e2e (see CLAUDE.md, "What NOT to test").
 *
 * Selection is read off the ring each row draws, which is what the user
 * actually sees; the resulting slide order is read from the live Y.Doc.
 */

import { test, expect, type Page } from '@playwright/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'

/**
 * Assert which rows draw a selection ring — active or multi-select.
 *
 * Polled, never read once: `click()` resolves when the event has been
 * dispatched, not when React has re-rendered off the back of it, so a plain
 * read races the render and intermittently returns the pre-click selection.
 */
async function expectRingedRows(page: Page, expected: number[]): Promise<void> {
  await expect.poll(() => ringedRows(page), { timeout: 5_000 }).toEqual(expected)
}

/** Indices of the rows drawing a selection ring — active or multi-select. */
async function ringedRows(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const out: number[] = []
    document.querySelectorAll('[data-slide-index]').forEach((el, i) => {
      if (el.querySelector('.border-blue-500, [class*="border-blue-400/80"]')) out.push(i)
    })
    return out
  })
}

/**
 * True once the panel's scroll position has held still across two samples.
 *
 * Changing the active slide scrolls it into view with `behavior: 'smooth'`,
 * and six rows do not fit the panel, so the list really does travel. A click
 * issued while that animation is in flight is measured against one layout and
 * delivered against another: it lands half a row off and selects the
 * neighbour, which reads exactly like "the click was ignored".
 */
async function waitForPanelStill(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const list = document.querySelector('ul[role="listbox"]')
          if (list === null) return false
          const before = list.scrollTop
          await new Promise((resolve) => setTimeout(resolve, 120))
          return list.scrollTop === before
        }),
      { timeout: 10_000 },
    )
    .toBe(true)
}

/** Click a slide row, but only once the list has stopped moving. */
async function clickRow(
  page: Page,
  index: number,
  modifiers?: Array<'Shift' | 'Meta'>,
): Promise<void> {
  await waitForPanelStill(page)
  const row = page.locator('[data-slide-index]').nth(index)
  await (modifiers === undefined ? row.click() : row.click({ modifiers }))
}

async function openDeckWithSlides(page: Page, count: number): Promise<string[]> {
  const res = await page.request.post(`${API_BASE}/decks`, { data: { title: 'multi-select' } })
  expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
  const { id } = (await res.json()) as { id: string }

  await page.goto(`/deck/${id}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')
  // A new deck starts with one slide.
  await page.evaluate((n) => {
    for (let i = 1; i < n; i++) window.__narrative_test_api!.addSlide()
  }, count)
  await expect(page.locator('[data-slide-index]')).toHaveCount(count, { timeout: 15_000 })
  // Wait for the deck to settle on an active slide before touching it. The
  // panel resolves that asynchronously once the document has loaded, and a
  // click that lands first is racing an initialisation rather than testing
  // a selection.
  await expect.poll(() => ringedRows(page), { timeout: 15_000 }).toEqual([0])
  return page.evaluate(() => window.__narrative_test_api!.listSlideIds())
}

test('shift-click selects the whole run between the two clicks', async ({ page }) => {
  test.setTimeout(120_000)
  await openDeckWithSlides(page, 6)
  const rows = page.locator('[data-slide-index]')

  await clickRow(page, 1)
  await expectRingedRows(page, [1])

  // The point of the whole thing: everything between, not just the ends.
  await clickRow(page, 4, ['Shift'])
  await expectRingedRows(page, [1, 2, 3, 4])

  // The anchor stays where the gesture started, so moving the far end
  // resizes the one range instead of ratcheting a new one onto it.
  await clickRow(page, 2, ['Shift'])
  await expectRingedRows(page, [1, 2])

  // Backwards from the anchor reads the same.
  await clickRow(page, 4)
  await clickRow(page, 0, ['Shift'])
  await expectRingedRows(page, [0, 1, 2, 3, 4])
})

test('cmd-click adds and removes one slide without disturbing the rest', async ({ page }) => {
  test.setTimeout(120_000)
  await openDeckWithSlides(page, 6)
  const rows = page.locator('[data-slide-index]')

  await clickRow(page, 1)
  await clickRow(page, 2, ['Shift'])
  await clickRow(page, 5, ['Meta'])
  await expectRingedRows(page, [1, 2, 5])

  await clickRow(page, 2, ['Meta'])
  await expectRingedRows(page, [1, 5])

  // The selection may not be emptied out from under the panel — something
  // always has to be current.
  await clickRow(page, 1, ['Meta'])
  await clickRow(page, 5, ['Meta'])
  await expect.poll(() => ringedRows(page).then((r) => r.length)).toBeGreaterThan(0)
})

test('deleting a multi-selection removes every slide in it', async ({ page }) => {
  test.setTimeout(120_000)
  const before = await openDeckWithSlides(page, 6)
  const rows = page.locator('[data-slide-index]')

  await clickRow(page, 1)
  await clickRow(page, 3, ['Shift'])
  await expectRingedRows(page, [1, 2, 3])

  await page.keyboard.press('Delete')
  await expect(page.locator('[data-slide-index]')).toHaveCount(3, { timeout: 10_000 })

  // Exactly the three selected ones went, and the survivors kept their order.
  const after = await page.evaluate(() => window.__narrative_test_api!.listSlideIds())
  expect(after).toEqual([before[0], before[4], before[5]])
})

test('dragging a multi-selection moves the whole block', async ({ page }) => {
  test.setTimeout(120_000)
  const before = await openDeckWithSlides(page, 5)
  const rows = page.locator('[data-slide-index]')

  await clickRow(page, 0)
  await clickRow(page, 1, ['Shift'])
  await expectRingedRows(page, [0, 1])

  // Drag the pair down past the last slide. The panel's reorder is a pointer
  // gesture, so this is a real press-move-release, past the 4px threshold
  // that separates a drag from a click.
  const from = await rows.nth(0).boundingBox()
  const last = await rows.nth(4).boundingBox()
  expect(from && last).toBeTruthy()
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
  await page.mouse.down()
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2 + 20, { steps: 5 })
  await page.mouse.move(last!.x + last!.width / 2, last!.y + last!.height - 2, { steps: 12 })
  await page.mouse.up()

  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api!.listSlideIds()), {
      timeout: 10_000,
    })
    .toEqual([before[2], before[3], before[4], before[0], before[1]])
})
