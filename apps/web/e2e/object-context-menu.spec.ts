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
  // A 1280×720 window puts the artboard's top-left corner behind the toolbar
  // at 100% zoom, so a right-click aimed at an object near the slide origin
  // lands on chrome instead of the canvas.
  await page.setViewportSize({ width: 1920, height: 1080 })
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
    // A failed load names its URL only in the location, not in the text.
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()} (${msg.location().url})`)
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

/**
 * The layer items used to be wired crosswise — "Send back" moved one step
 * and "Send backward" went all the way to the back. Each label must do
 * what it says and show the canvas shortcut for the same move.
 */
test('layer items do what their labels say and show the matching shortcut', async ({ page }) => {
  test.setTimeout(60_000)
  await createDeckAndOpen(page)

  await page.evaluate(() => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'L-A', x: 150, y: 300, w: 250, h: 200, fill: 0xff5555 })
    api.addRect({ id: 'L-B', x: 550, y: 300, w: 250, h: 200, fill: 0x55ff55 })
    api.addRect({ id: 'L-C', x: 950, y: 300, w: 250, h: 200, fill: 0x5555ff })
  })
  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api!.objectIds()), { timeout: 10_000 })
    .toEqual(['L-A', 'L-B', 'L-C'])
  // Right-clicks hit-test the rendered scene: wait for it, not just the doc.
  await expect(page.locator('.artboard')).toBeVisible({ timeout: 10_000 })
  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api!.sceneGraphHasMountedNode('L-B')), {
      timeout: 10_000,
    })
    .toBe(true)
  await page.keyboard.press('Escape')

  const menu = page.locator('[data-testid="editor-context-menu-content"]')
  const order = () => page.evaluate(() => window.__narrative_test_api!.objectIds())

  // Shortcut hints: ⌘ on macOS, Ctrl elsewhere — accept either.
  const cases: Array<{ label: string; move: string; hint: RegExp; after: string[] }> = [
    { label: 'Send backward', move: 'backward', hint: /^\[$/, after: ['L-B', 'L-A', 'L-C'] },
    { label: 'Bring forward', move: 'forward', hint: /^\]$/, after: ['L-A', 'L-B', 'L-C'] },
    { label: 'Send to back', move: 'back', hint: /^(⌘|Ctrl\+)\[$/, after: ['L-B', 'L-A', 'L-C'] },
    {
      label: 'Bring to front',
      move: 'front',
      hint: /^(⌘|Ctrl\+)\]$/,
      after: ['L-A', 'L-C', 'L-B'],
    },
  ]
  for (const c of cases) {
    // L-B keeps its position on the slide; only its stacking changes.
    await rightClickOn(page, 675, 400)
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute('data-mode', 'object')
    const item = menu.locator(`[data-layer-move="${c.move}"]`)
    await expect(item.locator('span').first()).toHaveText(c.label)
    await expect(item.locator('span').last()).toHaveText(c.hint)
    await menu.getByText(c.label, { exact: true }).click()
    await expect(menu).not.toBeVisible()
    await expect.poll(order, { timeout: 3000 }).toEqual(c.after)
  }
})

test('Duplicate from the menu is one undo step and selects the copy', async ({ page }) => {
  test.setTimeout(60_000)
  await createDeckAndOpen(page)

  await page.evaluate(() => {
    window.__narrative_test_api!.addRect({
      id: 'D-A',
      x: 200,
      y: 200,
      w: 300,
      h: 200,
      fill: 0xff5555,
    })
  })
  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api!.objectIds()), { timeout: 10_000 })
    .toEqual(['D-A'])
  await expect(page.locator('.artboard')).toBeVisible({ timeout: 10_000 })
  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api!.sceneGraphHasMountedNode('D-A')), {
      timeout: 10_000,
    })
    .toBe(true)
  await page.keyboard.press('Escape')
  // Seeding is a LOCAL_ORIGIN write too; clicking "Duplicate" opens a pointer
  // gesture, which closes the seed's undo step first (state/undoGestures.ts),
  // so Mod+Z below undoes only the duplicate.

  const menu = page.locator('[data-testid="editor-context-menu-content"]')
  await rightClickOn(page, 350, 300)
  await expect(menu).toBeVisible()
  await menu.getByText('Duplicate', { exact: true }).click()
  await expect(menu).not.toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api!.objectCount()), { timeout: 3000 })
    .toBe(2)
  const copyId = (await page.evaluate(() => window.__narrative_test_api!.objectIds())).find(
    (id) => id !== 'D-A',
  )!
  expect(await page.evaluate(() => window.__narrative_test_api!.getSelection())).toEqual([copyId])

  await page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api!.objectIds()), { timeout: 3000 })
    .toEqual(['D-A'])
})
