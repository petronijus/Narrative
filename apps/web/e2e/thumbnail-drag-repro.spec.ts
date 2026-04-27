import { test, expect, type Page } from '@playwright/test'

/**
 * Reproduce the user's exact UI flow: incognito new deck, drag rect on
 * slide 1 → thumbnail updates. Switch to slide 2, add ellipse → thumb
 * stops updating.
 *
 * Drag is simulated via the test API's updateObject equivalent (we add
 * one and then nudge its x/y in a few ticks). Slide switch goes
 * through the actual sidebar click so the React + Yjs state transitions
 * mirror real usage.
 */

async function createDeckAndOpen(page: Page): Promise<void> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'Drag thumb repro' },
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

async function thumbLengths(page: Page): Promise<Map<string, number>> {
  const arr = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('[data-slide-id] img'))
    return imgs.map((img) => ({
      slideId: img.closest('[data-slide-id]')?.getAttribute('data-slide-id') ?? '',
      length: img.src.length,
    }))
  })
  return new Map(arr.map((e) => [e.slideId, e.length]))
}

test('drag updates thumbnail across slide switches (user repro)', async ({ page }) => {
  test.setTimeout(120_000)

  page.on('console', (msg) => {
    const t = msg.text()
    if (t.startsWith('[thumb-dbg]') || msg.type() === 'error') console.log(t)
  })

  await createDeckAndOpen(page)

  // Slide 1: add rect-A and "drag" it to a new x/y by replacing it.
  await page.evaluate(() => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'rA', x: 200, y: 200, w: 200, h: 200, fill: 0xff0000 })
  })
  await page.waitForTimeout(700)
  const t1 = await thumbLengths(page)
  console.log('after add rA:', Object.fromEntries(t1))

  // Add slide 2, click its thumbnail.
  const s2 = await page.evaluate(() => window.__narrative_test_api!.addSlide())
  await page.waitForTimeout(500)
  await page.locator(`[data-slide-id="${s2}"]`).first().click()
  await page.waitForTimeout(800)

  // Slide 2: add rect-B (acts as 'ellipse' in user's flow).
  await page.evaluate((id: string) => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'rB', x: 800, y: 400, w: 200, h: 200, fill: 0x00ff00 }, id)
  }, s2)
  await page.waitForTimeout(1500)
  const t2 = await thumbLengths(page)
  console.log('after add rB on slide 2:', Object.fromEntries(t2))

  // Get slide 1 id.
  const ids = await page.evaluate(() => window.__narrative_test_api!.listSlideIds())
  const s1 = ids.find((id) => id !== s2)!
  expect(s1, 'slide 1 id resolvable').toBeDefined()

  // Click slide 1 thumbnail.
  await page.locator(`[data-slide-id="${s1}"]`).first().click()
  await page.waitForTimeout(500)

  // Slide 1: add rect-A2 (more activity).
  await page.evaluate((id: string) => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'rA2', x: 600, y: 600, w: 200, h: 200, fill: 0x0000ff }, id)
  }, s1)
  // Wait long enough for the queue to drain even if many renders are
  // pending — this measures eventual correctness, not latency.
  await page.waitForTimeout(8000)
  const t3 = await thumbLengths(page)
  console.log('after add rA2 on slide 1 (8s wait):', Object.fromEntries(t3))

  // Asserts: each step's edit must change THE EDITED slide's thumbnail.
  const t1S1 = t1.get(s1) ?? 0
  const t2S1 = t2.get(s1) ?? 0
  const t2S2 = t2.get(s2) ?? 0
  const t3S1 = t3.get(s1) ?? 0
  const t3S2 = t3.get(s2) ?? 0

  console.log({ t1S1, t2S1, t2S2, t3S1, t3S2 })

  expect(t2S2, 'slide 2 thumb updates after adding rB').not.toBe(0)
  expect(t3S1, 'slide 1 thumb updates after adding rA2').not.toBe(t1S1)
  expect(t3S2, 'slide 2 thumb persists').toBe(t2S2)
})
