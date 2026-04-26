import { test, expect, type Page } from '@playwright/test'

/**
 * P11c regression — right-click context menu on a non-selected object
 * must:
 *   1. Open the menu in 'object' mode (not 'canvas' mode).
 *   2. Promote the hit object to selection.
 *   3. Fire Cut / Copy / Delete / Duplicate handlers and close the menu.
 *
 * The pre-fix bug was a nested ContextMenu pair — both Roots fired on the
 * same contextmenu event, their portals stacked, and onSelect either
 * silently dropped or required a refresh to commit Yjs writes.
 */

async function createDeckAndOpen(page: Page): Promise<void> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'Object context menu test' },
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

/**
 * Maps slide-space (1920×1080) coords to viewport coords accounting for
 * the artboard's CSS scale AND its scroll offset (the artboard often
 * sits with negative `top`/`left` because the stage container scrolls
 * when its padding+content exceeds the viewport).
 *
 * If the resulting viewport point is outside the visible canvas-backdrop
 * area, we scroll the backdrop until it's in view, then re-measure.
 */
async function rightClickOn(page: Page, slideX: number, slideY: number): Promise<void> {
  const point = await page.evaluate(
    ({ sx, sy }) => {
      const artboard = document.querySelector<HTMLElement>('.artboard')
      const backdrop = document.querySelector<HTMLElement>('.canvas-backdrop')
      if (artboard === null || backdrop === null) {
        throw new Error('artboard or backdrop not found')
      }
      const ar = artboard.getBoundingClientRect()
      const br = backdrop.getBoundingClientRect()
      const scale = ar.width / 1920
      let vx = ar.left + sx * scale
      let vy = ar.top + sy * scale

      // If the click target is outside the backdrop's visible area, scroll
      // the backdrop's scroller (the immediate scrolling parent) so it lands.
      const scroller = artboard.closest<HTMLElement>('[data-stage-scroll]') ?? backdrop
      const margin = 40
      let needRemeasure = false
      if (vx < br.left + margin) {
        scroller.scrollLeft -= br.left + margin - vx
        needRemeasure = true
      } else if (vx > br.right - margin) {
        scroller.scrollLeft += vx - (br.right - margin)
        needRemeasure = true
      }
      if (vy < br.top + margin) {
        scroller.scrollTop -= br.top + margin - vy
        needRemeasure = true
      } else if (vy > br.bottom - margin) {
        scroller.scrollTop += vy - (br.bottom - margin)
        needRemeasure = true
      }
      if (needRemeasure) {
        const ar2 = artboard.getBoundingClientRect()
        vx = ar2.left + sx * scale
        vy = ar2.top + sy * scale
      }

      console.log(
        `[rightClickOn] slide=(${sx},${sy}) scale=${scale} viewport=(${vx},${vy}) backdrop=(${br.left},${br.top},${br.right},${br.bottom})`,
      )
      return { x: vx, y: vy }
    },
    { sx: slideX, sy: slideY },
  )
  await page.mouse.move(point.x, point.y)
  await page.mouse.click(point.x, point.y, { button: 'right' })
}

test('right-click on unselected object → menu opens, items fire', async ({ page }) => {
  test.setTimeout(60_000)

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
    if (msg.text().startsWith('[rightClickOn]')) console.log(msg.text())
  })

  await createDeckAndOpen(page)

  await page.evaluate(() => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'rect-A', x: 200, y: 200, w: 300, h: 200, fill: 0xff5555 })
    api.addRect({ id: 'rect-B', x: 600, y: 200, w: 300, h: 200, fill: 0x5555ff })
  })
  await page.waitForTimeout(300)

  // Selection starts empty.
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => window.__narrative_test_api!.getSelection())).toEqual([])

  // 1. Right-click rect-A's centre.
  await rightClickOn(page, 350, 300)

  // Menu must open in object mode.
  const menu = page.locator('[data-testid="editor-context-menu-content"]')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('data-mode', 'object')

  // Hit object promoted to selection.
  expect(await page.evaluate(() => window.__narrative_test_api!.getSelection())).toEqual(['rect-A'])

  // 2. Click "Copy" — menu should close, no Yjs change yet.
  await menu.getByText('Copy', { exact: true }).click()
  await expect(menu).not.toBeVisible()
  expect(await page.evaluate(() => window.__narrative_test_api!.objectCount())).toBe(2)

  // 3. Right-click again, click "Delete".
  await rightClickOn(page, 350, 300)
  await expect(menu).toBeVisible()
  await menu.getByText('Delete', { exact: true }).click()
  await expect(menu).not.toBeVisible()
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => window.__narrative_test_api!.objectCount())).toBe(1)
  expect(await page.evaluate(() => window.__narrative_test_api!.objectIds())).toEqual(['rect-B'])

  // 4. Right-click rect-B → Duplicate.
  await rightClickOn(page, 750, 300)
  await expect(menu).toBeVisible()
  await menu.getByText('Duplicate', { exact: true }).click()
  await expect(menu).not.toBeVisible()
  await page.waitForTimeout(200)
  expect(await page.evaluate(() => window.__narrative_test_api!.objectCount())).toBe(2)

  // 5. Right-click on empty canvas → mode flips to 'canvas'.
  await rightClickOn(page, 1500, 800)
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('data-mode', 'canvas')
  await menu.getByText('Reset zoom', { exact: true }).click()
  await expect(menu).not.toBeVisible()

  // No error spam.
  const realErrors = errors.filter(
    (e) => !e.includes('No available adapters') && !e.includes('HocuspocusProvider'),
  )
  expect(realErrors, `unexpected errors: ${realErrors.join(' | ')}`).toEqual([])
})
