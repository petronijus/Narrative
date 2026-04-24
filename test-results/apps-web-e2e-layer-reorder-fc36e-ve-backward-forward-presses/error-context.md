# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: apps/web/e2e/layer-reorder.spec.ts >> layer-reorder stress: 10 consecutive backward/forward presses
- Location: apps/web/e2e/layer-reorder.spec.ts:113:1

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/deck/hgm5RbQR3El1", waiting until "load"

```

# Test source

```ts
  1   | import { test, expect, type Page } from '@playwright/test'
  2   |
  3   | /**
  4   |  * P6 regression: reorder via the Layer order buttons must keep the
  5   |  * target object selectable and leave no torn-down state behind. The
  6   |  * old bug surfaced as: hit `[`, selection vanished, the object
  7   |  * couldn't be clicked any more, and the scene stayed stale until a
  8   |  * page refresh or slide nav.
  9   |  *
  10  |  * Strategy:
  11  |  *   1. Seed two rectangles via the test API.
  12  |  *   2. Programmatically select rect-B via the test API (no clicks).
  13  |  *   3. Press `[` (send backward).
  14  |  *   4. Verify selection persists, Y.Array order flipped, object count
  15  |  *      unchanged, no pageerror / console.error fired, and Pixi
  16  |  *      SceneGraph still has a node mapped to rect-B.
  17  |  */
  18  |
  19  | async function createDeckAndOpen(page: Page): Promise<void> {
  20  |   const res = await page.request.post('http://localhost:3001/decks', {
  21  |     data: { title: 'Layer reorder test' },
  22  |   })
  23  |   const { id } = (await res.json()) as { id: string }
> 24  |   await page.goto(`/deck/${id}`)
      |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  25  |   await page.waitForFunction(
  26  |     () => (window as unknown as { __narrative_test_api?: unknown }).__narrative_test_api !== undefined,
  27  |     null,
  28  |     { timeout: 15_000 },
  29  |   )
  30  | }
  31  |
  32  | test('send backward keeps selection + no dropped ids + no render crash', async ({ page }) => {
  33  |   test.setTimeout(60_000)
  34  |
  35  |   const errors: string[] = []
  36  |   page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  37  |   page.on('console', (msg) => {
  38  |     if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  39  |   })
  40  |
  41  |   await createDeckAndOpen(page)
  42  |
  43  |   await page.evaluate(() => {
  44  |     const api = window.__narrative_test_api!
  45  |     api.addRect({ id: 'rect-A', x: 200, y: 200, w: 300, h: 200, fill: 0xff5555 })
  46  |     api.addRect({ id: 'rect-B', x: 280, y: 250, w: 300, h: 200, fill: 0x5555ff })
  47  |   })
  48  |
  49  |   // Let the SceneGraph reconciler mount both rects.
  50  |   await page.waitForTimeout(300)
  51  |
  52  |   const initialIds = await page.evaluate(() => window.__narrative_test_api!.objectIds())
  53  |   expect(initialIds).toEqual(['rect-A', 'rect-B'])
  54  |
  55  |   await page.evaluate(() => window.__narrative_test_api!.setSelection(['rect-B']))
  56  |   await page.waitForTimeout(50)
  57  |   expect(await page.evaluate(() => window.__narrative_test_api!.getSelection())).toEqual(['rect-B'])
  58  |
  59  |   // Focus the document body so `[` keydown reaches EditorLayout's handler.
  60  |   await page.keyboard.press('Escape')
  61  |   await page.evaluate(() => window.__narrative_test_api!.setSelection(['rect-B']))
  62  |   await page.waitForTimeout(50)
  63  |
  64  |   await page.keyboard.press('[')
  65  |   await page.waitForTimeout(400)
  66  |
  67  |   // (a) No JS errors surfaced
  68  |   const realErrors = errors.filter(
  69  |     (e) => !e.includes('No available adapters') && !e.includes('HocuspocusProvider'),
  70  |   )
  71  |   expect(realErrors, `unexpected errors: ${realErrors.join(' | ')}`).toEqual([])
  72  |
  73  |   // (b) Selection retained
  74  |   expect(await page.evaluate(() => window.__narrative_test_api!.getSelection())).toEqual(['rect-B'])
  75  |
  76  |   // (c) Object count unchanged
  77  |   expect(await page.evaluate(() => window.__narrative_test_api!.objectCount())).toBe(2)
  78  |
  79  |   // (d) Y.Array order is now [rect-B, rect-A]
  80  |   expect(await page.evaluate(() => window.__narrative_test_api!.objectIds())).toEqual([
  81  |     'rect-B',
  82  |     'rect-A',
  83  |   ])
  84  |
  85  |   // (e) After a further 500ms (rAF filter install + any Pixi follow-ups)
  86  |   // we should still have exactly 2 objects and the same selection
  87  |   // — guards against a latent scene graph teardown.
  88  |   await page.waitForTimeout(500)
  89  |   expect(await page.evaluate(() => window.__narrative_test_api!.objectCount())).toBe(2)
  90  |   expect(await page.evaluate(() => window.__narrative_test_api!.getSelection())).toEqual(['rect-B'])
  91  |
  92  |   // (f) The Pixi SceneGraph mirrors Y.Doc: both rect ids must be
  93  |   // mounted AND the moved rect must still be hit-testable. The old bug
  94  |   // left a stale node behind (or nothing at all) — this catches it.
  95  |   const sceneIds = await page.evaluate(() =>
  96  |     [...window.__narrative_test_api!.sceneGraphIds()].sort(),
  97  |   )
  98  |   expect(sceneIds).toEqual(['rect-A', 'rect-B'])
  99  |   expect(
  100 |     await page.evaluate(() =>
  101 |       window.__narrative_test_api!.sceneGraphHasMountedNode('rect-B'),
  102 |     ),
  103 |     'rect-B must still be hit-testable after send-backward',
  104 |   ).toBe(true)
  105 |   expect(
  106 |     await page.evaluate(() =>
  107 |       window.__narrative_test_api!.sceneGraphHasMountedNode('rect-A'),
  108 |     ),
  109 |     'rect-A must still be hit-testable after send-backward',
  110 |   ).toBe(true)
  111 | })
  112 |
  113 | test('layer-reorder stress: 10 consecutive backward/forward presses', async ({ page }) => {
  114 |   test.setTimeout(60_000)
  115 |   const errors: string[] = []
  116 |   page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  117 |   page.on('console', (msg) => {
  118 |     if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  119 |   })
  120 |
  121 |   await createDeckAndOpen(page)
  122 |   await page.evaluate(() => {
  123 |     const api = window.__narrative_test_api!
  124 |     api.addRect({ id: 'A', x: 0, y: 0, w: 100, h: 100, fill: 0xff0000 })
```
