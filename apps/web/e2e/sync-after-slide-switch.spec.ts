import {
  test,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from './fixtures/test'

/**
 * Reproduce: 2 windows of same deck. Slide 1 + drag → both windows
 * see it. Switch to slide 2 → drag in window A → window A doesn't
 * update, window B does (and vice versa). User report.
 */

async function createDeck(request: APIRequestContext): Promise<string> {
  // Through the `request` fixture, so the deck is deleted after the run.
  const res = await request.post('http://localhost:3001/decks', {
    data: { title: 'Sync repro' },
  })
  const json = (await res.json()) as { id: string }
  return json.id
}

async function openDeck(ctx: BrowserContext, deckId: string): Promise<Page> {
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
  page.on('console', (msg) => {
    const t = msg.text()
    if (t.startsWith('[thumb]') || msg.type() === 'error') {
      console.log(`[browser] ${t}`)
    }
  })
  await page.goto(`/deck/${deckId}`)
  await page.waitForFunction(
    () =>
      (window as unknown as { __narrative_test_api?: unknown }).__narrative_test_api !== undefined,
    null,
    { timeout: 15_000 },
  )
  return page
}

test('sync stays alive after switching active slide on a 2-slide deck', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000)

  const deckId = await createDeck(request)
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const pageA = await openDeck(ctxA, deckId)
  const pageB = await openDeck(ctxB, deckId)

  // Wait for both pages to settle.
  await pageA.waitForTimeout(500)
  await pageB.waitForTimeout(500)

  // Page A: add rect on slide 1.
  await pageA.evaluate(() => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'r1', x: 200, y: 200, w: 200, h: 200, fill: 0xff0000 })
  })
  await pageA.waitForTimeout(800)

  // Both pages should see the rect.
  const aSeesR1 = await pageA.evaluate(() =>
    window.__narrative_test_api!.objectIds().includes('r1'),
  )
  const bSeesR1 = await pageB.evaluate(() =>
    window.__narrative_test_api!.objectIds().includes('r1'),
  )
  expect(aSeesR1, 'A sees r1').toBe(true)
  expect(bSeesR1, 'B sees r1').toBe(true)

  // Page A: add slide 2 + click it (so A is on slide 2). Use Playwright's
  // real-mouse click so the event hits the right inner element + bubbles
  // through the onClick handler on the slide row.
  const slide2Id = await pageA.evaluate(() => window.__narrative_test_api!.addSlide())
  await pageA.waitForTimeout(500)
  await pageA.locator(`[data-slide-id="${slide2Id}"]`).first().click()
  await pageA.waitForTimeout(500)

  await pageB.waitForTimeout(500)
  await pageB.locator(`[data-slide-id="${slide2Id}"]`).first().click()
  await pageB.waitForTimeout(500)

  // Page A: add ellipse on slide 2.
  await pageA.evaluate((slideId: string) => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'r2', x: 600, y: 400, w: 300, h: 200, fill: 0x00ff00 }, slideId)
  }, slide2Id)
  await pageA.waitForTimeout(1500)

  // Both A and B should see r2 on slide 2.
  const aSeesR2 = await pageA.evaluate(
    (id: string) => window.__narrative_test_api!.objectIds(id).includes('r2'),
    slide2Id,
  )
  const bSeesR2 = await pageB.evaluate(
    (id: string) => window.__narrative_test_api!.objectIds(id).includes('r2'),
    slide2Id,
  )
  console.log('after page A added r2 on slide 2:', { aSeesR2, bSeesR2 })
  expect(aSeesR2, 'A sees its own r2 add').toBe(true)
  expect(bSeesR2, "B sees A's r2 add (sync)").toBe(true)

  // Page B: add another rect on slide 2.
  await pageB.evaluate((slideId: string) => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'r3', x: 1200, y: 300, w: 200, h: 200, fill: 0x0000ff }, slideId)
  }, slide2Id)
  await pageB.waitForTimeout(1500)

  const aSeesR3 = await pageA.evaluate(
    (id: string) => window.__narrative_test_api!.objectIds(id).includes('r3'),
    slide2Id,
  )
  const bSeesR3 = await pageB.evaluate(
    (id: string) => window.__narrative_test_api!.objectIds(id).includes('r3'),
    slide2Id,
  )
  console.log('after page B added r3 on slide 2:', { aSeesR3, bSeesR3 })
  expect(aSeesR3, "A sees B's r3 add (sync)").toBe(true)
  expect(bSeesR3, 'B sees its own r3 add').toBe(true)

  // Now check the actual SceneGraph state — does Pixi reflect the Yjs state?
  const aSceneIds = await pageA.evaluate(() => window.__narrative_test_api!.sceneGraphIds())
  const bSceneIds = await pageB.evaluate(() => window.__narrative_test_api!.sceneGraphIds())
  console.log('SceneGraph ids on A (active slide):', aSceneIds)
  console.log('SceneGraph ids on B (active slide):', bSceneIds)
  // Both windows are on slide 2 — Pixi should show r2 + r3.
  expect(aSceneIds.sort()).toEqual(['r2', 'r3'])
  expect(bSceneIds.sort()).toEqual(['r2', 'r3'])

  await ctxA.close()
  await ctxB.close()
})
