import { test, expect, type Page } from '@playwright/test'

/**
 * Diagnostic: capture present-mode layout to investigate "present mode
 * shifted, doesn't match artboard size" report.
 */

async function createDeckAndOpen(page: Page): Promise<string> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'Present layout diag' },
  })
  const { id } = (await res.json()) as { id: string }
  await page.goto(`/deck/${id}`)
  await page.waitForFunction(
    () =>
      (window as unknown as { __narrative_test_api?: unknown }).__narrative_test_api !== undefined,
    null,
    { timeout: 15_000 },
  )
  return id
}

test('present-mode slide container measures match expected SLIDE 1920×1080', async ({ page }) => {
  test.setTimeout(60_000)
  const id = await createDeckAndOpen(page)

  await page.evaluate(() => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'rect-A', x: 200, y: 200, w: 400, h: 200, fill: 0xff5555 })
    api.addRect({ id: 'rect-B', x: 1200, y: 700, w: 300, h: 200, fill: 0x5555ff })
  })
  await page.waitForTimeout(300)

  // Navigate to present mode.
  await page.goto(`/deck/${id}/present`)
  await page.waitForSelector('[data-testid="slide-container"]', { timeout: 15_000 })
  // Wait a beat for Pixi to mount + scale to compute.
  await page.waitForTimeout(800)

  const measurements = await page.evaluate(() => {
    const slide = document.querySelector<HTMLElement>('[data-testid="slide-container"]')!
    const slideRect = slide.getBoundingClientRect()
    const canvasEl = slide.querySelector<HTMLCanvasElement>('canvas')
    const canvasRect = canvasEl?.getBoundingClientRect() ?? null
    const slideArea = slide.parentElement
    const areaRect = slideArea?.getBoundingClientRect() ?? null
    const transform = getComputedStyle(slide).transform
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      slide: {
        layoutW: slide.offsetWidth,
        layoutH: slide.offsetHeight,
        rect: {
          x: slideRect.left,
          y: slideRect.top,
          w: slideRect.width,
          h: slideRect.height,
        },
        transform,
      },
      area: areaRect
        ? { x: areaRect.left, y: areaRect.top, w: areaRect.width, h: areaRect.height }
        : null,
      canvas: canvasRect
        ? {
            x: canvasRect.left,
            y: canvasRect.top,
            w: canvasRect.width,
            h: canvasRect.height,
            cssW: canvasEl!.style.width,
            cssH: canvasEl!.style.height,
            attrW: canvasEl!.width,
            attrH: canvasEl!.height,
          }
        : null,
    }
  })
  console.log(JSON.stringify(measurements, null, 2))

  // Visual record.
  await page.screenshot({ path: 'test-results/present-layout-diag.png', fullPage: false })

  // Sanity checks: slide container's CSS size should be the slide constants;
  // its visual rect should be scaled to fit the viewport.
  expect(measurements.slide.layoutW).toBe(1920)
  expect(measurements.slide.layoutH).toBe(1080)
  expect(measurements.slide.rect.w).toBeGreaterThan(100)
  expect(measurements.slide.rect.h).toBeGreaterThan(60)

  // Visual rect must be aspect-correct (1.7̄8).
  const ratio = measurements.slide.rect.w / measurements.slide.rect.h
  expect(ratio).toBeGreaterThan(1.77)
  expect(ratio).toBeLessThan(1.79)

  // Canvas rect should match the slide container rect (Canvas is
  // absolute/inset-0 inside the slide container).
  expect(measurements.canvas).not.toBeNull()
  if (measurements.canvas !== null) {
    expect(Math.abs(measurements.canvas.x - measurements.slide.rect.x)).toBeLessThan(2)
    expect(Math.abs(measurements.canvas.y - measurements.slide.rect.y)).toBeLessThan(2)
    expect(Math.abs(measurements.canvas.w - measurements.slide.rect.w)).toBeLessThan(2)
    expect(Math.abs(measurements.canvas.h - measurements.slide.rect.h)).toBeLessThan(2)
  }
})
