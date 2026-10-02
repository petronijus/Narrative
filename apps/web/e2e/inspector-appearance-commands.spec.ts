import { test, expect, type Page } from '@playwright/test'

/**
 * The Inspector's gradient, shadow and page-number controls dispatch the
 * A2.8 commands (object.fill.gradient, object.effects.shadow,
 * object.slideNumber.set), so they carry the commands' rules. Checked on the
 * document the editor holds, after real clicks:
 *   - Linear seeds a gradient from the shape's colour; switching to Radial
 *     keeps those stops (the command keeps them, the old picker reseeded);
 *   - the shadow switch gives the default shadow, and one undo removes it;
 *   - the page-number field's first use offers the folder's page-number
 *     style, and applying it links the box to that style.
 */

const RECT_ID = 'appearance-rect'
const TEXT_ID = 'appearance-text'
const BLUE = 0x3b82f6

async function openDeckWithObjects(page: Page): Promise<void> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: `inspector-appearance ${Date.now()}` },
  })
  const { id } = (await res.json()) as { id: string }
  await page.goto(`/deck/${id}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 15_000 })
    .toBe('object')
  await page.evaluate(
    ({ rectId, textId, fill }) => {
      const api = window.__narrative_test_api!
      api.addRect({ id: rectId, x: 200, y: 150, w: 600, h: 400, fill })
      api.addText({ id: textId, x: 1700, y: 1000, w: 120, h: 40, text: '00', fontSize: 18 })
    },
    { rectId: RECT_ID, textId: TEXT_ID, fill: BLUE },
  )
  await expect
    .poll(
      () =>
        page.evaluate((id) => window.__narrative_test_api!.sceneGraphHasMountedNode(id), RECT_ID),
      { timeout: 8000 },
    )
    .toBe(true)
}

async function select(page: Page, id: string): Promise<void> {
  await page.evaluate((objectId) => window.__narrative_test_api!.setSelection([objectId]), id)
  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api!.getSelection()))
    .toEqual([id])
}

const objectOf = (page: Page, id: string) =>
  page.evaluate((objectId) => window.__narrative_test_api!.getObject(objectId), id)

test('gradient, shadow and page number go through their commands', async ({ page }) => {
  await openDeckWithObjects(page)
  await select(page, RECT_ID)

  // Gradient: seeded from the shape's blue and its 0.55 tint.
  const fillType = page.getByLabel('Fill type')
  await fillType.selectOption('linearGradient')
  const seeded = [
    { color: BLUE, offset: 0 },
    { color: 0x204887, offset: 1 },
  ]
  await expect
    .poll(async () => (await objectOf(page, RECT_ID))?.['fillStyle'])
    .toEqual({ kind: 'linearGradient', stops: seeded, angleDeg: 0 })
  // Switching kind keeps the stops.
  await fillType.selectOption('radialGradient')
  await expect
    .poll(async () => (await objectOf(page, RECT_ID))?.['fillStyle'])
    .toEqual({ kind: 'radialGradient', stops: seeded })

  // Shadow: the default one, and one undo step — the switch click is a
  // pointer gesture, which closes the gradient's step first
  // (state/undoGestures.ts).
  await page.getByRole('switch', { name: 'Enable shadow' }).click()
  await expect
    .poll(async () => (await objectOf(page, RECT_ID))?.['shadow'])
    .toEqual({ color: 0, blur: 8, offsetX: 4, offsetY: 4, opacity: 0.5 })
  // Undo is the editor's shortcut: take focus off the Inspector's switch.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await objectOf(page, RECT_ID))?.['shadow']).toBeUndefined()
  expect((await objectOf(page, RECT_ID))?.['fillStyle']).toMatchObject({ kind: 'radialGradient' })

  // Page number: the first one in the deck offers the folder's style.
  await select(page, TEXT_ID)
  await page.getByRole('button', { name: 'Page number' }).click()
  const applyStyle = page.getByRole('button', { name: /Footnotes and pages.*text style/ })
  await expect(applyStyle).toBeEnabled({ timeout: 10_000 })
  await applyStyle.click()
  await expect
    .poll(async () => {
      const t = await objectOf(page, TEXT_ID)
      return { isSlideNumber: t?.['isSlideNumber'], linked: typeof t?.['textStyleId'] === 'string' }
    })
    .toEqual({ isSlideNumber: true, linked: true })
})
