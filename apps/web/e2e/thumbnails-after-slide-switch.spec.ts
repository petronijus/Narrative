import { test, expect, type Page } from './fixtures/test'

/**
 * Repro: edit slide 1 → thumbnail updates. Switch to slide 2 → both
 * slides' thumbnails stop updating + Yjs sync stops working.
 */

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

  const errors: string[] = []
  const consoleLines: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    consoleLines.push(`[${msg.type()}] ${msg.text()}`)
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
    if (msg.text().startsWith('[thumb]')) console.log(msg.text())
  })

  await createDeckAndOpen(page)

  // Start with one slide. Add rect on slide 1.
  await page.evaluate(() => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'rect-A1', x: 200, y: 200, w: 300, h: 200, fill: 0xff5555 })
  })
  await page.waitForTimeout(500)

  // Now mid-session add slide 2 (this is the path the user takes).
  const seeded = await page.evaluate(() => {
    const api = window.__narrative_test_api!
    const ids = api.listSlideIds()
    const fromSlideId = ids[0]
    const toSlideId = api.addSlide()
    return { fromSlideId, toSlideId }
  })
  await page.waitForTimeout(800)
  console.log('seeded slides:', seeded)

  // Wait long enough that initial thumbnail renders should have fired.
  await page.waitForTimeout(1500)
  const thumbsBefore = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('[data-slide-id] img'))
    return imgs.map((img) => ({
      slideId: img.closest('[data-slide-id]')?.getAttribute('data-slide-id'),
      hasSrc: img.src.startsWith('data:image/png;'),
      length: img.src.length,
    }))
  })
  console.log('thumbs initial:', thumbsBefore)

  // Edit slide 1 — add a second rect.
  await page.evaluate((fromId: string) => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'rect-A2', x: 800, y: 400, w: 200, h: 200, fill: 0x00ff00 }, fromId)
  }, seeded.fromSlideId)
  await page.waitForTimeout(1500)
  const thumbsAfterEdit1 = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('[data-slide-id] img'))
    return imgs.map((img) => ({
      slideId: img.closest('[data-slide-id]')?.getAttribute('data-slide-id'),
      length: img.src.length,
    }))
  })
  console.log('thumbs after edit slide 1:', thumbsAfterEdit1)

  // Switch to slide 2 by clicking its thumbnail in the slide panel. We
  // don't have a programmatic test-api for this; click the second
  // [data-slide-id] item.
  await page.evaluate((toId: string) => {
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-slide-id]'))
    const target = items.find((el) => el.getAttribute('data-slide-id') === toId)
    target?.click()
  }, seeded.toSlideId)
  await page.waitForTimeout(800)

  // Edit slide 2 — add rect (now active slide is slide 2).
  await page.evaluate((toId: string) => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'rect-B1', x: 400, y: 400, w: 200, h: 200, fill: 0x0000ff }, toId)
  }, seeded.toSlideId)
  await page.waitForTimeout(1500)
  const thumbsAfterEdit2 = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('[data-slide-id] img'))
    return imgs.map((img) => ({
      slideId: img.closest('[data-slide-id]')?.getAttribute('data-slide-id'),
      length: img.src.length,
    }))
  })
  console.log('thumbs after edit slide 2:', thumbsAfterEdit2)

  // Switch back to slide 1, edit again.
  await page.evaluate((fromId: string) => {
    const items = Array.from(document.querySelectorAll<HTMLElement>('[data-slide-id]'))
    const target = items.find((el) => el.getAttribute('data-slide-id') === fromId)
    target?.click()
  }, seeded.fromSlideId)
  await page.waitForTimeout(300)
  await page.evaluate((fromId: string) => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'rect-A3', x: 1200, y: 200, w: 200, h: 200, fill: 0xff00ff }, fromId)
  }, seeded.fromSlideId)
  await page.waitForTimeout(1500)
  const thumbsAfterEdit3 = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('[data-slide-id] img'))
    return imgs.map((img) => ({
      slideId: img.closest('[data-slide-id]')?.getAttribute('data-slide-id'),
      length: img.src.length,
    }))
  })
  console.log('thumbs after edit slide 1 again:', thumbsAfterEdit3)

  // Print interesting console lines.
  console.log(
    '== console excerpts ==',
    consoleLines
      .filter(
        (l) =>
          l.includes('thumbnail') ||
          l.includes('renderSlide') ||
          l.includes('error') ||
          l.includes('Error'),
      )
      .slice(0, 40)
      .join('\n'),
  )

  // Diagnostic assertions per stage.
  const lookup = (snapshot: typeof thumbsBefore, id: string) =>
    snapshot.find((t) => t.slideId === id)?.length ?? 0

  console.log('slide A initial len:', lookup(thumbsBefore, seeded.fromSlideId))
  console.log('slide A after edit-A len:', lookup(thumbsAfterEdit1, seeded.fromSlideId))
  console.log('slide B initial len:', lookup(thumbsBefore, seeded.toSlideId))
  console.log('slide B after edit-B len:', lookup(thumbsAfterEdit2, seeded.toSlideId))
  console.log('slide A after edit-A2 len:', lookup(thumbsAfterEdit3, seeded.fromSlideId))

  expect(
    lookup(thumbsAfterEdit1, seeded.fromSlideId),
    'slide A thumbnail did not update after first edit',
  ).not.toBe(lookup(thumbsBefore, seeded.fromSlideId))

  expect(
    lookup(thumbsAfterEdit2, seeded.toSlideId),
    'slide B thumbnail did not update after switching + editing',
  ).not.toBe(lookup(thumbsBefore, seeded.toSlideId))

  expect(
    lookup(thumbsAfterEdit3, seeded.fromSlideId),
    'slide A thumbnail did not update on second round-trip',
  ).not.toBe(lookup(thumbsAfterEdit1, seeded.fromSlideId))
})
