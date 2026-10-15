/**
 * slides-panel-drag.spec.ts — a slide dragged in the slides panel lands
 * where the pointer is, whatever the panel did meanwhile.
 *
 * Reported 2026-10-02: scrolling the panel with the wheel (or a trackpad)
 * while dragging made the drop point lag behind the pointer. The drop was
 * computed from how far the pointer had moved on screen since the press, so
 * content scrolled under a still pointer did not count, and the gaps between
 * thumbnails made it drift on long drags even without scrolling.
 */

import { expect, test, type Page } from './fixtures/test'

const API = 'http://localhost:3001'
const SLIDE_COUNT = 16

async function openDeckWithSlides(page: Page): Promise<string[]> {
  const res = await page.request.post(`${API}/decks`, { data: { title: 'Slide drag' } })
  const { id } = (await res.json()) as { id: string }
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`/deck/${id}`)
  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api?.listSlideIds().length ?? 0), {
      timeout: 15_000,
    })
    .toBe(1)
  await page.evaluate((n) => {
    for (let i = 1; i < n; i++) window.__narrative_test_api!.addSlide()
  }, SLIDE_COUNT)
  await expect(page.locator('[role="option"][data-slide-id]')).toHaveCount(SLIDE_COUNT)
  return page.evaluate(() => window.__narrative_test_api!.listSlideIds())
}

function row(page: Page, slideId: string) {
  return page.locator(`[role="option"][data-slide-id="${slideId}"]`)
}

/** The centre of a row, as it is on screen right now. */
async function centre(page: Page, slideId: string): Promise<{ x: number; y: number }> {
  const box = await row(page, slideId).boundingBox()
  if (box === null) throw new Error(`row ${slideId} has no box`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test.describe('slides panel drag', () => {
  test('a long drag drops the slide where the pointer is', async ({ page }) => {
    const ids = await openDeckWithSlides(page)
    const moved = ids[0]!
    const start = await centre(page, moved)
    // Just past the middle of the sixth row: the slide lands after it.
    const target = await centre(page, ids[5]!)

    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x, start.y + 20, { steps: 4 })
    await page.mouse.move(target.x, target.y + 6, { steps: 12 })
    await page.mouse.up()

    await expect
      .poll(() => page.evaluate(() => window.__narrative_test_api!.listSlideIds()))
      .toEqual([...ids.slice(1, 6), moved, ...ids.slice(6)])
  })

  test('scrolling the panel with the wheel mid-drag keeps the drop under the pointer', async ({
    page,
  }) => {
    const ids = await openDeckWithSlides(page)
    const moved = ids[0]!
    const start = await centre(page, moved)

    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x, start.y + 20, { steps: 4 })
    // Scroll the panel under the pointer, as a wheel or a trackpad does.
    await page.mouse.wheel(0, 600)
    await expect
      .poll(() => page.evaluate(() => document.querySelector('[role="listbox"]')?.scrollTop ?? 0))
      .toBeGreaterThan(300)

    // Whichever row is now under the pointer: the drop goes just after it.
    const under = await page.evaluate(
      ({ x, y }) =>
        document
          .elementsFromPoint(x, y)
          .map((el) => el.closest('[role="option"][data-slide-id]'))
          .find((el) => el !== null)
          ?.getAttribute('data-slide-id') ?? null,
      { x: start.x, y: start.y + 20 },
    )
    expect(under, 'a row is under the pointer after scrolling').not.toBeNull()
    const underCentre = await centre(page, under!)
    await page.mouse.move(underCentre.x, underCentre.y + 6, { steps: 4 })
    await page.mouse.up()

    const at = ids.indexOf(under!)
    await expect
      .poll(() => page.evaluate(() => window.__narrative_test_api!.listSlideIds()))
      .toEqual([...ids.slice(1, at + 1), moved, ...ids.slice(at + 1)])
  })
})
