import { test, expect, type Page } from './fixtures/test'
import { isEngineNoise } from './fixtures/consoleNoise'

/**
 * P6 regression: reorder via the Layer order buttons must keep the
 * target object selectable and leave no torn-down state behind. The
 * old bug surfaced as: hit `[`, selection vanished, the object
 * couldn't be clicked any more, and the scene stayed stale until a
 * page refresh or slide nav.
 *
 * Strategy:
 *   1. Seed two rectangles via the test API.
 *   2. Programmatically select rect-B via the test API (no clicks).
 *   3. Press `[` (send backward).
 *   4. Verify selection persists, Y.Array order flipped, object count
 *      unchanged, no pageerror / console.error fired, and Pixi
 *      SceneGraph still has a node mapped to rect-B.
 */

async function createDeckAndOpen(page: Page): Promise<void> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'Layer reorder test' },
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
 * Select `ids` and keep re-issuing it until it sticks: the editor drops a
 * selection of objects it has not taken in yet, and a selection made in the
 * same moment as the insert is lost for good (keyboard-shortcuts.spec.ts).
 */
async function selectUntilItSticks(page: Page, ids: string[]): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((want) => {
          const api = window.__narrative_test_api!
          if (api.getSelection().join() !== want.join()) api.setSelection(want)
          return api.getSelection()
        }, ids),
      { timeout: 10_000 },
    )
    .toEqual(ids)
}

const objectIds = (page: Page) => page.evaluate(() => window.__narrative_test_api!.objectIds())

test('send backward keeps selection + no dropped ids + no render crash', async ({ page }) => {
  test.setTimeout(60_000)

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    // Include the location: "Failed to load resource: … 404" on its own names
    // nothing, and chasing it costs more than printing it does.
    if (msg.type() === 'error' && !isEngineNoise(msg.text()))
      errors.push(`console.error: ${msg.text()} @ ${msg.location().url}`)
  })

  await createDeckAndOpen(page)

  await page.evaluate(() => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'rect-A', x: 200, y: 200, w: 300, h: 200, fill: 0xff5555 })
    api.addRect({ id: 'rect-B', x: 280, y: 250, w: 300, h: 200, fill: 0x5555ff })
  })

  // Both rects in the document and in the scene, then rect-B selected.
  await expect.poll(() => objectIds(page)).toEqual(['rect-A', 'rect-B'])
  await expect
    .poll(() => page.evaluate(() => [...window.__narrative_test_api!.sceneGraphIds()].sort()))
    .toEqual(['rect-A', 'rect-B'])
  // Escape first: it moves focus to the page so `[` reaches the editor's
  // shortcuts — and clears the selection, so select afterwards.
  await page.keyboard.press('Escape')
  await selectUntilItSticks(page, ['rect-B'])

  await page.keyboard.press('[')
  await expect.poll(() => objectIds(page)).toEqual(['rect-B', 'rect-A'])

  // (a) No JS errors surfaced
  const realErrors = errors.filter(
    (e) => !e.includes('No available adapters') && !e.includes('HocuspocusProvider'),
  )
  expect(realErrors, `unexpected errors: ${realErrors.join(' | ')}`).toEqual([])

  // (b) Selection retained
  expect(await page.evaluate(() => window.__narrative_test_api!.getSelection())).toEqual(['rect-B'])

  // (c) Object count unchanged
  expect(await page.evaluate(() => window.__narrative_test_api!.objectCount())).toBe(2)

  // (d) Y.Array order is now [rect-B, rect-A]
  expect(await page.evaluate(() => window.__narrative_test_api!.objectIds())).toEqual([
    'rect-B',
    'rect-A',
  ])

  // (e) After a further 500ms (rAF filter install + any Pixi follow-ups)
  // we should still have exactly 2 objects and the same selection
  // — guards against a latent scene graph teardown.
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.__narrative_test_api!.objectCount())).toBe(2)
  expect(await page.evaluate(() => window.__narrative_test_api!.getSelection())).toEqual(['rect-B'])

  // (f) The Pixi SceneGraph mirrors Y.Doc: both rect ids must be
  // mounted AND the moved rect must still be hit-testable. The old bug
  // left a stale node behind (or nothing at all) — this catches it.
  const sceneIds = await page.evaluate(() =>
    [...window.__narrative_test_api!.sceneGraphIds()].sort(),
  )
  expect(sceneIds).toEqual(['rect-A', 'rect-B'])
  expect(
    await page.evaluate(() => window.__narrative_test_api!.sceneGraphHasMountedNode('rect-B')),
    'rect-B must still be hit-testable after send-backward',
  ).toBe(true)
  expect(
    await page.evaluate(() => window.__narrative_test_api!.sceneGraphHasMountedNode('rect-A')),
    'rect-A must still be hit-testable after send-backward',
  ).toBe(true)

  // (g) Crucially: the Pixi child order must match Y.Array. The
  // reconciler used to addChild at the END on re-add, so "send
  // backward" left the target rendered on top — user saw no visual
  // change until refresh.
  // Polled: WebKit (Playwright's, in its container) applies the change set
  // ~0.8 s after the keypress where Chromium takes one frame — open in
  // docs/plans/desktop-tauri-evaluation.md, to be felt on a Mac.
  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api!.sceneGraphChildOrder()), {
      message: 'Pixi child order must mirror Y.Array',
    })
    .toEqual(['rect-B', 'rect-A'])
})

test('layer-reorder stress: 10 consecutive backward/forward presses', async ({ page }) => {
  test.setTimeout(60_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    // The location names what failed to load; the text alone does not.
    if (msg.type() === 'error' && !isEngineNoise(msg.text()))
      errors.push(`console.error: ${msg.text()} @ ${msg.location().url}`)
  })

  await createDeckAndOpen(page)
  await page.evaluate(() => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'A', x: 0, y: 0, w: 100, h: 100, fill: 0xff0000 })
    api.addRect({ id: 'B', x: 120, y: 0, w: 100, h: 100, fill: 0x00ff00 })
    api.addRect({ id: 'C', x: 240, y: 0, w: 100, h: 100, fill: 0x0000ff })
  })
  // Wait for the state itself, not a fixed delay: with the suite running in
  // parallel a 50 ms pause did not always see the selection applied, and the
  // presses below then moved nothing.
  await expect
    .poll(() => page.evaluate(() => [...window.__narrative_test_api!.sceneGraphIds()].sort()))
    .toEqual(['A', 'B', 'C'])
  await page.keyboard.press('Escape')
  await selectUntilItSticks(page, ['B'])

  // Back and forth: each press lands before the next one goes.
  for (let i = 0; i < 10; i++) {
    const back = i % 2 === 0
    await page.keyboard.press(back ? '[' : ']')
    await expect.poll(() => objectIds(page)).toEqual(back ? ['B', 'A', 'C'] : ['A', 'B', 'C'])
  }

  const realErrors = errors.filter(
    (e) => !e.includes('No available adapters') && !e.includes('HocuspocusProvider'),
  )
  expect(realErrors, realErrors.join(' | ')).toEqual([])
  expect(await page.evaluate(() => window.__narrative_test_api!.objectCount())).toBe(3)
  expect(await page.evaluate(() => window.__narrative_test_api!.getSelection())).toEqual(['B'])
  const mounted = await page.evaluate(() =>
    [...window.__narrative_test_api!.sceneGraphIds()].sort(),
  )
  expect(mounted).toEqual(['A', 'B', 'C'])
})
