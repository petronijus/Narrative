/**
 * thumbnail-live.spec.ts — the sidebar thumbnail of the slide being edited is
 * drawn from the editor's own canvas (renderer/liveThumbnail.ts), not built
 * again in a second Pixi application. The thumbnail must still be right:
 * shapes where they are, text drawn — also while that text is being edited,
 * when the canvas draws it faded under the editing overlay — and following
 * every change.
 */

import { expect, test, type Page } from './fixtures/test'
import { provisionDeckWithText } from './fixtures/provisionDeck'

const SLIDE_W = 1920
const THUMB_W = 200

/** The first slide's thumbnail, decoded to RGBA (null until it has one). */
async function thumbnailPixels(
  page: Page,
): Promise<{ w: number; h: number; data: number[] } | null> {
  return page.evaluate(async (thumbWidth) => {
    const img = document.querySelector<HTMLImageElement>('[data-slide-id] img')
    if (img === null || !img.src.startsWith('data:image/png')) return null
    // The panel shows a picture the server made until the editor has its own
    // (1920 wide); the editor's thumbnails are THUMB_W wide. The src can change
    // under a decode in flight.
    try {
      await img.decode()
    } catch {
      return null
    }
    if (img.naturalWidth !== thumbWidth) return null
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    return {
      w: canvas.width,
      h: canvas.height,
      data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data),
    }
  }, THUMB_W)
}

type Pixels = NonNullable<Awaited<ReturnType<typeof thumbnailPixels>>>

/** RGB at slide coordinates (x, y). */
function at(p: Pixels, x: number, y: number): [number, number, number] {
  const k = THUMB_W / SLIDE_W
  const i = (Math.floor(y * k) * p.w + Math.floor(x * k)) * 4
  return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!]
}

/** Whether the thumbnail is red (the test rectangle) at slide coordinates (x, y). */
function isRed(p: Pixels, x: number, y: number): boolean {
  const [r, g, b] = at(p, x, y)
  return r > 200 && g < 60 && b < 60
}

/** How many pixels of the slide rectangle are text ink (thumbnail text is small and light: anything clearly darker than the white page). */
function ink(p: Pixels, x: number, y: number, w: number, h: number): number {
  const k = THUMB_W / SLIDE_W
  let n = 0
  for (let py = Math.floor(y * k); py < Math.ceil((y + h) * k); py++) {
    for (let px = Math.floor(x * k); px < Math.ceil((x + w) * k); px++) {
      const i = (py * p.w + px) * 4
      if (p.data[i + 3]! > 128 && p.data[i]! + p.data[i + 1]! + p.data[i + 2]! < 600) n++
    }
  }
  return n
}

test('the thumbnail of the active slide follows the canvas, edited text included', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await provisionDeckWithText(page, {
    objectId: 'live-text',
    text: 'Hello',
    x: 700,
    y: 500,
    width: 900,
    height: 200,
  })
  await page.evaluate(() => {
    window.__narrative_test_api!.addRect({
      id: 'live-rect',
      x: 100,
      y: 100,
      w: 400,
      h: 300,
      fill: 0xff0000,
    })
  })

  // The first thumbnail shows the rectangle in red and the text as ink.
  let shot: Pixels | null = null
  await expect
    .poll(
      async () => {
        shot = await thumbnailPixels(page)
        return shot !== null && isRed(shot, 300, 250) && ink(shot, 700, 500, 900, 200) > 1
      },
      { timeout: 15_000 },
    )
    .toBe(true)
  const inkBefore = ink(shot!, 700, 500, 900, 200)

  // A change to a shape reaches the thumbnail.
  await page.evaluate(() =>
    window.__narrative_test_api!.updateObject('live-rect', { x: 1300, y: 700 }),
  )
  await expect
    .poll(
      async () => {
        const p = await thumbnailPixels(page)
        if (p === null) return 'wait'
        if (isRed(p, 1500, 850)) return isRed(p, 300, 250) ? 'both' : 'moved'
        return isRed(p, 300, 250) ? 'old place' : 'wait'
      },
      { timeout: 15_000 },
    )
    .toBe('moved')

  // Text typed in the editor — while its canvas node is faded — is in the thumbnail.
  await page.evaluate(() => window.__narrative_test_api!.beginTextEdit('live-text'))
  const editable = page.locator('[data-shortcut-scope="canvas"] [contenteditable="true"]').first()
  await expect(editable).toBeVisible({ timeout: 5_000 })
  await editable.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' and a good deal more words', { delay: 20 })
  await expect
    .poll(
      async () => {
        const p = await thumbnailPixels(page)
        return p === null ? 0 : ink(p, 700, 500, 900, 200)
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(inkBefore * 1.5)
})
