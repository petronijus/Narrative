import { test, expect, type Page } from './fixtures/test'

/**
 * Repro: edit slide 1 → thumbnail updates. Switch to slide 2 → both
 * slides' thumbnails stop updating + Yjs sync stops working.
 *
 * Each step waits for what it needs — the thumbnail of the slide just edited
 * to be a new picture, the slide clicked to be the active one — instead of
 * fixed sleeps: a thumbnail is rendered in idle time after a debounce, and
 * in the full suite (three workers) 1.5 s was not always enough for slide
 * B's (2026-11-01; it passed alone).
 */

/** Each slide's thumbnail (its object URL), by slide id. */
function thumbnails(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll<HTMLImageElement>('[data-slide-id] img'))
        .filter((img) => img.src.startsWith('blob:'))
        .map((img) => [img.closest('[data-slide-id]')!.getAttribute('data-slide-id')!, img.src]),
    ),
  )
}

/** Wait until slide `id`'s thumbnail is a picture other than `before` (one is there at all when `before` is ''). */
async function thumbnailChanges(
  page: Page,
  id: string,
  before: string,
  why: string,
): Promise<string> {
  await expect
    .poll(async () => (await thumbnails(page))[id] ?? '', { timeout: 15_000, message: why })
    .not.toBe(before)
  return (await thumbnails(page))[id]!
}

/** Click slide `id` in the slides panel and wait until it is the active one. */
async function activate(page: Page, id: string): Promise<void> {
  const row = page.locator(`[data-slide-id="${id}"]`).first()
  await row.click()
  await expect(row).toHaveAttribute('aria-selected', 'true')
}

async function createDeckAndOpen(page: Page): Promise<void> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'Thumb after switch' },
  })
  const { id } = (await res.json()) as { id: string }
  await page.goto(`/deck/${id}`)
  await page.waitForFunction(
    () =>
      (window as unknown as { __narrative_test_api?: unknown }).__narrative_test_api !== undefined,
    null,
    { timeout: 15_000 },
  )
}

test('thumbnails keep updating after switching active slide', async ({ page }) => {
  test.setTimeout(60_000)

  await createDeckAndOpen(page)

  // Start with one slide. Add rect on slide 1.
  await page.evaluate(() => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'rect-A1', x: 200, y: 200, w: 300, h: 200, fill: 0xff5555 })
  })

  // Now mid-session add slide 2 (this is the path the user takes).
  const seeded = await page.evaluate(() => {
    const api = window.__narrative_test_api!
    const ids = api.listSlideIds()
    const fromSlideId = ids[0]!
    const toSlideId = api.addSlide()
    return { fromSlideId, toSlideId }
  })

  // Both slides have their first pictures.
  const a0 = await thumbnailChanges(page, seeded.fromSlideId, '', 'slide A has no thumbnail')
  const b0 = await thumbnailChanges(page, seeded.toSlideId, '', 'slide B has no thumbnail')

  // Edit slide 1 — add a second rect.
  await page.evaluate((fromId: string) => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'rect-A2', x: 800, y: 400, w: 200, h: 200, fill: 0x00ff00 }, fromId)
  }, seeded.fromSlideId)
  const a1 = await thumbnailChanges(
    page,
    seeded.fromSlideId,
    a0,
    'slide A thumbnail did not update after first edit',
  )

  // Switch to slide 2 in the slides panel, then edit it.
  await activate(page, seeded.toSlideId)
  await page.evaluate((toId: string) => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'rect-B1', x: 400, y: 400, w: 200, h: 200, fill: 0x0000ff }, toId)
  }, seeded.toSlideId)
  await thumbnailChanges(
    page,
    seeded.toSlideId,
    b0,
    'slide B thumbnail did not update after switching + editing',
  )

  // Switch back to slide 1, edit again.
  await activate(page, seeded.fromSlideId)
  await page.evaluate((fromId: string) => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'rect-A3', x: 1200, y: 200, w: 200, h: 200, fill: 0xff00ff }, fromId)
  }, seeded.fromSlideId)
  await thumbnailChanges(
    page,
    seeded.fromSlideId,
    a1,
    'slide A thumbnail did not update on second round-trip',
  )
})
