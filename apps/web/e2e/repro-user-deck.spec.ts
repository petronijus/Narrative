import { test, type Page } from './fixtures/test'

/**
 * Open one specific deck, switch to slide 2, drag an object, and capture all
 * browser console output — the harness used to chase "thumbnails stop
 * generating after a slide switch".
 *
 * It needs a deck with two populated slides that only exists in one
 * developer's database, so it is opt-in: set REPRO_DECK_ID. The regression it
 * was written for is covered without any opt-in by
 * `thumbnails-after-slide-switch.spec.ts` and `thumbnail-drag-repro.spec.ts`,
 * which provision their own decks; this one stays for console-level
 * diagnosis of a deck a user reports.
 */

const REPRO_DECK_ID = process.env['REPRO_DECK_ID'] ?? ''

test('repro user deck slide 2 drag', async ({ page }) => {
  test.skip(REPRO_DECK_ID === '', 'diagnostic harness — set REPRO_DECK_ID to run it')
  test.setTimeout(120_000)

  const lines: string[] = []
  page.on('pageerror', (e) => lines.push(`[pageerror] ${e.message} ${e.stack ?? ''}`))
  page.on('console', (msg) => {
    const t = msg.text()
    lines.push(`[${msg.type()}] ${t}`)
    if (t.startsWith('[thumb-dbg]')) console.log(t)
  })

  await page.goto(`http://localhost:5173/deck/${REPRO_DECK_ID}`)
  await page.waitForFunction(
    () =>
      (window as unknown as { __narrative_test_api?: unknown }).__narrative_test_api !== undefined,
    null,
    { timeout: 15_000 },
  )
  await page.waitForTimeout(1500)

  // Inspect deck state — including object types per slide.
  const state = await page.evaluate(() => {
    const api = window.__narrative_test_api!
    const slideIds = api.listSlideIds()
    return {
      slideIds,
      perSlide: slideIds.map((id) => ({
        id,
        ids: api.objectIds(id),
      })),
    }
  })
  console.log('deck state:', JSON.stringify(state, null, 2))
  const types = await page.evaluate(() => {
    const api = window.__narrative_test_api! as unknown as {
      debugObjectTypes(id?: string): { id: string; type: string }[]
      listSlideIds(): string[]
    }
    return api.listSlideIds().map((id) => ({ slideId: id, objects: api.debugObjectTypes(id) }))
  })
  console.log('types:', JSON.stringify(types, null, 2))

  if (state.slideIds.length < 2) {
    console.log('Deck has fewer than 2 slides — adding one for repro')
    await page.evaluate(() => window.__narrative_test_api!.addSlide())
    await page.waitForTimeout(500)
  }

  const slide1Id = state.slideIds[0]!
  const slide2Id = state.slideIds[1]!

  // STEP 1: drag on slide 1 (active). User says this works.
  const obj1 = state.perSlide[0]!.ids[0]!
  console.log('=== Phase 1: drag on slide 1 ===')
  const t0 = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('[data-slide-id] img'))
    return imgs.map((img) => ({
      slideId: img.closest('[data-slide-id]')?.getAttribute('data-slide-id'),
      src: img.src,
    }))
  })
  console.log('thumbs t0:', t0)
  for (let i = 0; i < 10; i++) {
    await page.evaluate(
      ({ id, slideId, x, y }) => {
        window.__narrative_test_api!.updateObject(id, { x, y }, slideId)
      },
      { id: obj1, slideId: slide1Id, x: 200 + i * 10, y: 200 + i * 5 },
    )
    await page.waitForTimeout(40)
  }
  await page.waitForTimeout(3000)
  const t1 = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('[data-slide-id] img'))
    return imgs.map((img) => ({
      slideId: img.closest('[data-slide-id]')?.getAttribute('data-slide-id'),
      src: img.src,
    }))
  })
  console.log('thumbs t1 (after slide-1 drag):', t1)

  // STEP 2: Click slide 2.
  console.log('=== Phase 2: switch to slide 2 ===')
  await page.locator(`[data-slide-id="${slide2Id}"]`).first().click()
  await page.waitForTimeout(800)

  const slide2Objs = state.perSlide[1]!.ids
  const targetId = slide2Objs[0]!
  console.log('slide 2 ids:', slide2Objs)

  // Capture thumb BEFORE drag.
  const thumbsBefore = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('[data-slide-id] img'))
    return imgs.map((img) => ({
      slideId: img.closest('[data-slide-id]')?.getAttribute('data-slide-id'),
      src: img.src,
    }))
  })
  console.log('thumbs BEFORE drag:', thumbsBefore)

  // Programmatic "drag" — start at 100,100 and walk to 1500,800 so the
  // final position is clearly different from the initial.
  for (let i = 0; i < 15; i++) {
    await page.evaluate(
      ({ id, slideId, x, y }: { id: string; slideId: string; x: number; y: number }) => {
        window.__narrative_test_api!.updateObject(id, { x, y }, slideId)
      },
      { id: targetId, slideId: slide2Id, x: 100 + i * 100, y: 100 + i * 50 },
    )
    await page.waitForTimeout(50)
  }
  console.log('drag complete (15 ticks)')

  // After "drag" wait long.
  await page.waitForTimeout(8000)

  // Check thumbnails.
  const thumbs = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('[data-slide-id] img'))
    return imgs.map((img) => ({
      slideId: img.closest('[data-slide-id]')?.getAttribute('data-slide-id'),
      src: img.src,
    }))
  })
  console.log('thumbs after drag:', thumbs)

  // Print only thumb-related + error logs.
  console.log(
    '== relevant logs ==\n' +
      lines
        .filter(
          (l) =>
            l.includes('thumb') ||
            l.includes('error') ||
            l.includes('Error') ||
            l.includes('renderSlide') ||
            l.includes('queue') ||
            l.includes('pixi'),
        )
        .slice(0, 100)
        .join('\n'),
  )

  await page.screenshot({ path: 'test-results/repro-user-deck.png', fullPage: false })
})
