import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

/**
 * E2E: Magic Move slide transition moves a matched rectangle from its
 * outgoing transform to its incoming transform.
 *
 * Strategy: seed a 2-slide deck via the dev-only `window.__narrative_test_api`
 * — bypassing flaky editor-UI locators — then drive the real present-mode
 * orchestrator. Detect motion by comparing the x-centroid of the rectangle's
 * fill colour (saturated blue) between a screenshot taken before the
 * transition and one taken after.
 *
 * Robust against incidental UI chrome: the centroid is computed on pixels
 * that match the rectangle's fill colour within a loose Chebyshev tolerance,
 * so a blue button or scrollbar outside the transition path doesn't pollute
 * the measurement as long as the rectangle itself is on-screen.
 */

const RECT_COLOR = { r: 0x3b, g: 0x82, b: 0xf6 } // tailwind blue-500 (#3b82f6)

async function createDeckAndOpen(page: Page): Promise<string> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'E2E Magic Move' },
  })
  if (!res.ok()) {
    throw new Error(`POST /decks failed: ${res.status()} ${await res.text()}`)
  }
  const { id } = (await res.json()) as { id: string }
  await page.goto(`/deck/${id}`)
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10_000 })
  // The test API is installed inside SlideDocProvider.onSynced, which fires
  // after Hocuspocus finishes the first sync round. Wait for that.
  await page.waitForFunction(() => window.__narrative_test_api !== undefined, null, {
    timeout: 10_000,
  })
  return id
}

async function seedMagicMove(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = window.__narrative_test_api
    if (api === undefined) throw new Error('test api missing')
    api.seedMagicMoveFixture({
      objectId: 'e2e-rect',
      fill: '#3b82f6',
      durationMs: 600,
      from: { x: 200, y: 400, width: 300, height: 200, opacity: 1 },
      to: { x: 1200, y: 400, width: 300, height: 200, opacity: 1 },
    })
  })
}

function centroidOfColour(
  pngBuffer: Buffer,
  target: { r: number; g: number; b: number },
  tolerance = 30,
): { x: number; y: number; count: number } {
  const png = PNG.sync.read(pngBuffer)
  const d = png.data
  const w = png.width
  let sumX = 0
  let sumY = 0
  let count = 0
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!
    const g = d[i + 1]!
    const b = d[i + 2]!
    const a = d[i + 3]!
    if (a < 200) continue
    if (
      Math.abs(r - target.r) <= tolerance &&
      Math.abs(g - target.g) <= tolerance &&
      Math.abs(b - target.b) <= tolerance
    ) {
      const px = (i / 4) % w
      const py = Math.floor(i / 4 / w)
      sumX += px
      sumY += py
      count++
    }
  }
  if (count === 0) return { x: 0, y: 0, count: 0 }
  return { x: sumX / count, y: sumY / count, count }
}

test('Magic Move transition moves a matched rect from left to right', async ({ page }) => {
  test.setTimeout(60_000)

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })

  const deckId = await createDeckAndOpen(page)
  await seedMagicMove(page)

  // Yjs update → render loop is rAF-driven; give the renderer a moment to
  // mount the rectangles.
  await page.waitForTimeout(1000)

  // Enter present mode. navigateToSlide on first entry mounts slide 1.
  await page.goto(`/deck/${deckId}/present`)
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(1500)

  const before = await page.screenshot({ fullPage: true })
  const beforeCentroid = centroidOfColour(before, RECT_COLOR)
  console.log(
    `[e2e] before: count=${beforeCentroid.count} x=${beforeCentroid.x.toFixed(0)} y=${beforeCentroid.y.toFixed(0)}`,
  )
  expect(
    beforeCentroid.count,
    `Rectangle not visible before transition — errors: ${errors.join(' | ') || 'none'}`,
  ).toBeGreaterThan(100)

  // Trigger the transition.
  await page.keyboard.press('ArrowRight')
  // Wait for transition (600ms) + settle margin.
  await page.waitForTimeout(1500)

  const after = await page.screenshot({ fullPage: true })
  const afterCentroid = centroidOfColour(after, RECT_COLOR)
  console.log(
    `[e2e] after:  count=${afterCentroid.count} x=${afterCentroid.x.toFixed(0)} y=${afterCentroid.y.toFixed(0)}`,
  )

  expect(
    afterCentroid.count,
    `Rectangle not visible after transition — errors: ${errors.join(' | ') || 'none'}`,
  ).toBeGreaterThan(100)

  // The seeded transforms place slide 1 rect at x=200 and slide 2 rect at
  // x=1200 (canvas coords). In screen pixels the centroid must therefore
  // move to the right by a large margin. Use a conservative threshold of
  // 100 px to absorb canvas scaling without false negatives.
  const deltaX = afterCentroid.x - beforeCentroid.x
  expect(
    deltaX,
    `Rectangle did not move right across the Magic Move transition. ` +
      `before.x=${beforeCentroid.x.toFixed(0)} after.x=${afterCentroid.x.toFixed(0)} ` +
      `delta=${deltaX.toFixed(0)} errors: ${errors.join(' | ') || 'none'}`,
  ).toBeGreaterThan(100)
})
