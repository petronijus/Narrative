/**
 * e2e/slide-duplicate.spec.ts
 *
 * A duplicated slide draws on the canvas like its original.
 *
 * Duplicating a slide and moving the editor to the copy unmounts every
 * object and mounts the copies — the same images, so the same textures —
 * in one go. Releasing the last reference to a texture started Pixi's
 * asynchronous unload; the copy's image, asking for the same URL a moment
 * later, got the texture Pixi was about to destroy. The first frame that
 * drew it threw, Pixi's render group was left half-updated, every later
 * frame threw too, and the canvas stayed blank (while selection, driven by
 * the model, still worked). The render error was swallowed as well.
 */

import { Buffer } from 'node:buffer'
import { test, expect, type Page } from './fixtures/test'
import { PNG } from 'pngjs'

const API = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const CANVAS = '[data-shortcut-scope="canvas"]'

function bluePng(): Buffer {
  const size = 64
  const png = new PNG({ width: size, height: size })
  for (let i = 0; i < size * size; i++) {
    png.data[i * 4] = 30
    png.data[i * 4 + 1] = 90
    png.data[i * 4 + 2] = 230
    png.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(png)
}

/** Pixels of the canvas area that show the blue image. */
async function bluePixels(page: Page): Promise<number> {
  const png = PNG.sync.read(await page.locator(CANVAS).first().screenshot())
  let n = 0
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i]!
    const g = png.data[i + 1]!
    const b = png.data[i + 2]!
    if (b > 180 && r < 90 && g < 140) n++
  }
  return n
}

test('Mod+D: the copy of a slide with an image draws on the canvas', async ({ page }) => {
  test.setTimeout(90_000)
  const renderFailures: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('[RenderScheduler]'))
      renderFailures.push(m.text())
  })
  page.on('pageerror', (e) => renderFailures.push(`pageerror: ${e.message}`))

  const res = await page.request.post(`${API}/decks`, { data: { title: 'slide-duplicate' } })
  expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
  const { id: deckId } = (await res.json()) as { id: string }
  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')

  // Blue the editor's own chrome shows (selection outlines, buttons): the
  // image is measured above it.
  const chrome = await bluePixels(page)
  const deselect = () => page.evaluate(() => window.__narrative_test_api!.setSelection([]))

  await page
    .locator('input[type="file"][accept^="image"]')
    .first()
    .setInputFiles({ name: 'blue.png', mimeType: 'image/png', buffer: bluePng() })
  await expect.poll(() => bluePixels(page), { timeout: 30_000 }).toBeGreaterThan(chrome + 500)
  await deselect()
  await expect.poll(() => bluePixels(page)).toBeGreaterThan(chrome + 500)
  const image = (await bluePixels(page)) - chrome

  const [source] = await page.evaluate(() => window.__narrative_test_api!.listSlideIds())
  await page.locator(`[role="option"][data-slide-id="${source}"]`).click()
  await page.keyboard.press('ControlOrMeta+d')

  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api!.listSlideIds().length))
    .toBe(2)
  const copy = (await page.evaluate(() => window.__narrative_test_api!.listSlideIds()))[1]!
  await expect(
    page.locator(`[role="option"][aria-selected="true"][data-slide-id="${copy}"]`),
  ).toHaveCount(1)
  await deselect()

  // The copy shows the image as the original did…
  await expect
    .poll(async () => (await bluePixels(page)) - chrome, { timeout: 15_000 })
    .toBeGreaterThan(image * 0.9)
  // …and keeps drawing: an edit on the copy reaches the canvas.
  const [imageId] = await page.evaluate((id) => window.__narrative_test_api!.objectIds(id), copy)
  await page.evaluate(
    ([id, slide]) => window.__narrative_test_api!.updateObject(id!, { opacity: 0 }, slide),
    [imageId, copy] as const,
  )
  await expect
    .poll(async () => (await bluePixels(page)) - chrome, { timeout: 5_000 })
    .toBeLessThan(image * 0.1)
  expect(renderFailures).toEqual([])
})
