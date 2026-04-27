/**
 * e2e/p14b-slide-switch-sync.spec.ts
 *
 * Reproduces the "sync breaks after slide-switch dance" bug reported post-P14.
 *
 * Exact user repro sequence:
 *   1. A creates fresh deck.
 *   2. B opens same deck.
 *   3. Both on slide 1: A drags rect → B sees it (baseline, confirms basic sync).
 *   4. A clicks "+ Add Slide". B clicks "+ Add Slide".
 *      => Each client added their OWN slide 2 into the shared Y.Doc — the deck
 *         now has 3 slides: [slide1, A's slide2, B's slide2].
 *   5. A clicks "the second slide" (A's slide2). B clicks "the second slide"
 *      (B's slide2). They are on DIFFERENT slides.
 *   6. A clicks back to slide 1. B clicks back to slide 1. Both on slide 1 again.
 *   7. A drags existing object on slide 1.
 *   8. BUG: B's canvas does NOT reflect the movement.
 *
 * Diagnostic layers probed:
 *   a. Y.Doc layer: does B's deckCtx see the updated position?
 *   b. Observer layer: does subscribeToSlideObjects still fire for B?
 *   c. React state: does useSlideObjects / useSlideObjectChanges update?
 *   d. SceneGraph / Pixi: does getBounds reflect the new Y.Doc position?
 *
 * The test logs which layer is broken and saves screenshots to
 * test-results/p14b-slide-switch/.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.resolve(__dirname, '../test-results/p14b-slide-switch')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createDeck(): Promise<string> {
  const res = await fetch('http://localhost:3001/decks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'P14b slide-switch sync repro' }),
  })
  const json = (await res.json()) as { id: string }
  return json.id
}

async function openDeck(ctx: BrowserContext, deckId: string, label: string): Promise<Page> {
  const page = await ctx.newPage()

  const consoleMessages: string[] = []
  page.on('pageerror', (e) => {
    console.log(`[${label} pageerror] ${e.message}`)
  })
  page.on('console', (msg) => {
    const text = msg.text()
    if (msg.type() === 'error') {
      console.log(`[${label} console error] ${text}`)
      consoleMessages.push(text)
    }
  })

  await page.goto(`/deck/${deckId}`)
  await page.waitForFunction(
    () =>
      (window as unknown as { __narrative_test_api?: unknown }).__narrative_test_api !== undefined,
    null,
    { timeout: 20_000 },
  )
  await page.waitForTimeout(600)
  return page
}

async function screenshot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const p = path.join(RESULTS_DIR, `${name}.png`)
  await page.screenshot({ path: p, fullPage: false })
  return p
}

async function listSlideIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__narrative_test_api!.listSlideIds())
}

async function objectIds(page: Page, slideId: string): Promise<string[]> {
  return page.evaluate((sid: string) => window.__narrative_test_api!.objectIds(sid), slideId)
}

async function sceneGraphIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__narrative_test_api!.sceneGraphIds())
}

/** Read x,y directly from the live Y.Doc for a given object. */
async function getYDocPosition(
  page: Page,
  slideId: string,
  objectId: string,
): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    ({ sid, oid }: { sid: string; oid: string }) =>
      window.__narrative_test_api!.getObjectPositionFromYDoc(oid, sid),
    { sid: slideId, oid: objectId },
  )
}

/** Read x,y from SceneGraph (= what Pixi is actually rendering). */
async function getSceneGraphPosition(
  page: Page,
  objectId: string,
): Promise<{ x: number; y: number } | null> {
  return page.evaluate((oid: string) => {
    const sg = (
      window as unknown as {
        __narrative_scene_graph?: {
          getBounds: (
            id: string,
          ) => { world: { x: number; y: number; width: number; height: number } } | null
        }
      }
    ).__narrative_scene_graph
    if (!sg) return null
    const b = sg.getBounds(oid)
    return b ? { x: b.world.x, y: b.world.y } : null
  }, objectId)
}

// Keep alias for compat with existing calls below
async function getYDocObjectPosition(
  page: Page,
  slideId: string,
  objectId: string,
): Promise<{ x: number; y: number } | null> {
  return getSceneGraphPosition(page, objectId)
}

/** Navigate a page to a specific slide by clicking its thumbnail. */
async function clickSlide(page: Page, slideId: string): Promise<void> {
  const loc = page.locator(`[data-slide-id="${slideId}"]`).first()
  await loc.waitFor({ state: 'visible', timeout: 8000 })
  await loc.click()
  await page.waitForTimeout(400)
}

/** Get active slide id from DOM. */
async function getActiveSlideId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[role="option"][aria-selected="true"][data-slide-id]')
    return el?.getAttribute('data-slide-id') ?? null
  })
}

/** Move object to new position via test API (simulates drag). */
async function moveObjectViaApi(
  page: Page,
  objectId: string,
  slideId: string,
  x: number,
  y: number,
): Promise<void> {
  await page.evaluate(
    ({ oid, sid, x, y }: { oid: string; sid: string; x: number; y: number }) => {
      window.__narrative_test_api!.updateObject(oid, { x, y }, sid)
    },
    { oid: objectId, sid: slideId, x, y },
  )
}

// ---------------------------------------------------------------------------
// Main spec
// ---------------------------------------------------------------------------

test.describe('P14b — sync breaks after slide-switch dance', () => {
  test('slide 1 drag propagates to B after both clients add+visit+return-from slide 2', async ({
    browser,
  }) => {
    test.setTimeout(180_000)
    fs.mkdirSync(RESULTS_DIR, { recursive: true })

    const deckId = await createDeck()
    console.log('[P14b] deckId:', deckId)

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()

    let pageA: Page | null = null
    let pageB: Page | null = null

    try {
      pageA = await openDeck(ctxA, deckId, 'A')
      pageB = await openDeck(ctxB, deckId, 'B')

      // ------------------------------------------------------------------
      // Step 1: Baseline — add rect on slide 1 from A, confirm B sees it
      // ------------------------------------------------------------------
      const slide1Id = (await listSlideIds(pageA))[0]!
      console.log('[P14b] slide1Id:', slide1Id)

      await pageA.evaluate(
        ({ sid }: { sid: string }) => {
          window.__narrative_test_api!.addRect(
            { id: 'r1', x: 300, y: 300, w: 200, h: 200, fill: 0xff0000 },
            sid,
          )
        },
        { sid: slide1Id },
      )
      await pageA.waitForTimeout(1000)

      const aHasR1 = (await objectIds(pageA, slide1Id)).includes('r1')
      const bHasR1 = (await objectIds(pageB, slide1Id)).includes('r1')
      console.log('[P14b] Baseline: A has r1:', aHasR1, '/ B has r1:', bHasR1)
      expect(aHasR1, 'A: r1 on slide 1').toBe(true)
      expect(bHasR1, 'B: r1 on slide 1 (sync baseline)').toBe(true)

      // Move r1 from A to confirm basic drag sync works
      await moveObjectViaApi(pageA, 'r1', slide1Id, 400, 300)
      await pageA.waitForTimeout(800)

      const aSceneBaseline = await sceneGraphIds(pageA)
      const bSceneBaseline = await sceneGraphIds(pageB)
      console.log('[P14b] Baseline SceneGraph A:', aSceneBaseline, '/ B:', bSceneBaseline)
      expect(aSceneBaseline, 'A SceneGraph has r1 baseline').toContain('r1')
      expect(bSceneBaseline, 'B SceneGraph has r1 baseline').toContain('r1')

      await screenshot(pageA, '01-baseline-A')
      await screenshot(pageB, '01-baseline-B')

      // ------------------------------------------------------------------
      // Step 2: A adds slide 2, B adds slide 2 (independently)
      // ------------------------------------------------------------------
      const aSlide2Id = await pageA.evaluate(() => window.__narrative_test_api!.addSlide())
      await pageA.waitForTimeout(600)
      const bSlide2Id = await pageB.evaluate(() => window.__narrative_test_api!.addSlide())
      await pageB.waitForTimeout(600)

      const aSlides = await listSlideIds(pageA)
      const bSlides = await listSlideIds(pageB)
      console.log('[P14b] After both add slide2:')
      console.log('  A sees slides:', aSlides)
      console.log('  B sees slides:', bSlides)
      console.log("  A's slide2Id:", aSlide2Id, "/ B's slide2Id:", bSlide2Id)

      // The deck should now have 3 slides (slide1 + A's slide2 + B's slide2)
      // or 2 if one of the adds was a no-op due to timing.
      // Either way, both clients added a slide that they're about to click.

      // ------------------------------------------------------------------
      // Step 3: A clicks "their" slide 2, B clicks "their" slide 2
      // ------------------------------------------------------------------
      await clickSlide(pageA, aSlide2Id)
      await clickSlide(pageB, bSlide2Id)

      const aActive1 = await getActiveSlideId(pageA)
      const bActive1 = await getActiveSlideId(pageB)
      console.log('[P14b] After clicking slide2: A active:', aActive1, '/ B active:', bActive1)

      await screenshot(pageA, '02-on-slide2-A')
      await screenshot(pageB, '02-on-slide2-B')

      // ------------------------------------------------------------------
      // Step 4: Both navigate BACK to slide 1
      // ------------------------------------------------------------------
      await clickSlide(pageA, slide1Id)
      await clickSlide(pageB, slide1Id)

      const aActive2 = await getActiveSlideId(pageA)
      const bActive2 = await getActiveSlideId(pageB)
      console.log('[P14b] After returning to slide1: A active:', aActive2, '/ B active:', bActive2)

      expect(aActive2, 'A should be on slide1').toBe(slide1Id)
      expect(bActive2, 'B should be on slide1').toBe(slide1Id)

      await screenshot(pageA, '03-back-on-slide1-A')
      await screenshot(pageB, '03-back-on-slide1-B')

      // Give React state time to settle after slide switch
      await pageA.waitForTimeout(800)
      await pageB.waitForTimeout(800)

      // ------------------------------------------------------------------
      // Step 5: A drags r1 on slide 1 — THE BUG TRIGGER
      // ------------------------------------------------------------------
      const NEW_X = 700
      const NEW_Y = 500
      await moveObjectViaApi(pageA, 'r1', slide1Id, NEW_X, NEW_Y)
      await pageA.waitForTimeout(1200) // enough for rAF + sync propagation

      console.log('[P14b] A moved r1 to (', NEW_X, ',', NEW_Y, ')')

      // ------------------------------------------------------------------
      // Diagnostic layer 1: Y.Doc — does B's Y.Doc have the new position?
      // ------------------------------------------------------------------
      const aYdocIds = await objectIds(pageA, slide1Id)
      const bYdocIds = await objectIds(pageB, slide1Id)
      console.log('[P14b] [Layer: Y.Doc] A slide1 objects:', aYdocIds)
      console.log('[P14b] [Layer: Y.Doc] B slide1 objects:', bYdocIds)

      const aHasR1After = aYdocIds.includes('r1')
      const bHasR1After = bYdocIds.includes('r1')
      console.log('[P14b] [Layer: Y.Doc] A has r1:', aHasR1After, '/ B has r1:', bHasR1After)

      // Read raw Y.Doc position directly (bypasses SceneGraph)
      const aYDocPos = await getYDocPosition(pageA, slide1Id, 'r1')
      const bYDocPos = await getYDocPosition(pageB, slide1Id, 'r1')
      console.log('[P14b] [Layer: Y.Doc] A raw position:', aYDocPos)
      console.log('[P14b] [Layer: Y.Doc] B raw position:', bYDocPos)

      // ------------------------------------------------------------------
      // Diagnostic layer 2: SceneGraph — does Pixi reflect the new pos on B?
      // ------------------------------------------------------------------
      const aSceneAfter = await sceneGraphIds(pageA)
      const bSceneAfter = await sceneGraphIds(pageB)
      console.log('[P14b] [Layer: SceneGraph] A ids:', aSceneAfter, '/ B ids:', bSceneAfter)

      // Get actual bounds from SceneGraph (= what Pixi is rendering)
      const aPos = await getSceneGraphPosition(pageA, 'r1')
      const bPos = await getSceneGraphPosition(pageB, 'r1')
      console.log('[P14b] [Layer: SceneGraph] A bounds:', aPos, '/ B bounds:', bPos)

      // KEY DIAGNOSTIC: if bYDocPos has the new x=700 but bPos still shows old x=300,
      // the bug is in the observer/SceneGraph layer (update reached Y.Doc but not Pixi).
      // If bYDocPos itself still shows x=300, the bug is in the network/sync layer.
      if (bYDocPos !== null) {
        const ydocMovedB = Math.abs(bYDocPos.x - NEW_X) < 10
        console.log(`[P14b] [Diagnosis] B Y.Doc has new position (x≈${NEW_X}):`, ydocMovedB)
        if (!ydocMovedB) {
          console.log(
            '[P14b] [Diagnosis] ROOT CAUSE: network/sync layer — Y.Doc update did not reach B',
          )
        } else if (bPos === null || Math.abs(bPos.x - NEW_X) > 50) {
          console.log(
            '[P14b] [Diagnosis] ROOT CAUSE: observer/SceneGraph layer — Y.Doc has update but Pixi does not',
          )
          console.log(
            '[P14b] [Diagnosis] Likely: subscribeToSlideObjects observer is stale after slide-switch dance',
          )
          console.log(
            '[P14b] [Diagnosis] Check: useSlideObjectChanges deps [deckCtx, activeSlideId, slideOrderKey]',
          )
        } else {
          console.log('[P14b] [Diagnosis] All layers OK — no bug detected in this run')
        }
      }

      await screenshot(pageA, '04-after-drag-A')
      await screenshot(pageB, '04-after-drag-B')

      // ------------------------------------------------------------------
      // Assertions — diagnose which layer is broken
      // ------------------------------------------------------------------

      // Layer 1: Y.Doc presence
      expect(bHasR1After, '[Y.Doc] B should still see r1 on slide1 after A moved it').toBe(true)

      // Layer 2: SceneGraph presence
      expect(
        bSceneAfter.includes('r1'),
        `[SceneGraph] B's Pixi should have r1 mounted (ids: ${bSceneAfter.join(',')})`,
      ).toBe(true)

      // Layer 3: Position convergence — A and B must show r1 at same spot
      if (aPos !== null && bPos !== null) {
        const delta = Math.abs(aPos.x - bPos.x) + Math.abs(aPos.y - bPos.y)
        console.log('[P14b] [Layer: Position] delta between A and B:', delta, 'px')
        expect(
          delta,
          `[Position] A and B must show r1 at same position. A=${JSON.stringify(aPos)}, B=${JSON.stringify(bPos)}`,
        ).toBeLessThan(10)

        // r1 must have moved from its original position (300,300)
        const movedA = Math.abs(aPos.x - 300) > 50 || Math.abs(aPos.y - 300) > 50
        console.log('[P14b] [Layer: Position] A shows r1 moved from original:', movedA)
        expect(
          movedA,
          `[Position] A's SceneGraph should show r1 at moved position, got x=${aPos.x}`,
        ).toBe(true)
      } else {
        // Null bounds = object not in SceneGraph at all
        console.log(
          '[P14b] [Layer: Position] A bounds null:',
          aPos === null,
          '/ B bounds null:',
          bPos === null,
        )
        expect(aPos, '[Position] A: r1 must have bounds in SceneGraph').not.toBeNull()
        expect(bPos, '[Position] B: r1 must have bounds in SceneGraph after sync').not.toBeNull()
      }

      // ------------------------------------------------------------------
      // Step 6: Reverse — B drags r1, A should see it
      // ------------------------------------------------------------------
      console.log('[P14b] --- Reverse: B drags r1 ---')
      const NEW_X2 = 900
      const NEW_Y2 = 200
      await moveObjectViaApi(pageB, 'r1', slide1Id, NEW_X2, NEW_Y2)
      await pageB.waitForTimeout(1200)

      const aPosAfterB = await getSceneGraphPosition(pageA, 'r1')
      const bPosAfterB = await getSceneGraphPosition(pageB, 'r1')
      console.log('[P14b] [Reverse] After B moved r1: A:', aPosAfterB, '/ B:', bPosAfterB)

      await screenshot(pageA, '05-reverse-drag-A')
      await screenshot(pageB, '05-reverse-drag-B')

      if (aPosAfterB !== null && bPosAfterB !== null) {
        const reverseDelta =
          Math.abs(aPosAfterB.x - bPosAfterB.x) + Math.abs(aPosAfterB.y - bPosAfterB.y)
        console.log('[P14b] [Reverse] position delta:', reverseDelta, 'px')
        expect(
          reverseDelta,
          `[Reverse] A and B must converge after B's drag. A=${JSON.stringify(aPosAfterB)}, B=${JSON.stringify(bPosAfterB)}`,
        ).toBeLessThan(10)
      } else {
        expect(aPosAfterB, '[Reverse] A: r1 in SceneGraph').not.toBeNull()
        expect(bPosAfterB, '[Reverse] B: r1 in SceneGraph').not.toBeNull()
      }
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  // ------------------------------------------------------------------
  // Additional diagnostic: does the slideOrderKey change after the
  // dance trigger a full re-subscribe in useSlideObjectChanges?
  // ------------------------------------------------------------------
  test('slideOrderKey changes when slide added — useSlideObjectChanges resubscribes', async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    fs.mkdirSync(RESULTS_DIR, { recursive: true })

    const deckId = await createDeck()
    console.log('[P14b-sub] deckId:', deckId)

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()

    try {
      const pageA = await openDeck(ctxA, deckId, 'A')
      const pageB = await openDeck(ctxB, deckId, 'B')

      const slide1Id = (await listSlideIds(pageA))[0]!

      // Plant r1 on slide 1 from A
      await pageA.evaluate(
        ({ sid }: { sid: string }) => {
          window.__narrative_test_api!.addRect(
            { id: 'r1', x: 100, y: 100, w: 200, h: 200, fill: 0xaaaaaa },
            sid,
          )
        },
        { sid: slide1Id },
      )
      await pageA.waitForTimeout(800)

      // Verify baseline sync
      expect((await objectIds(pageA, slide1Id)).includes('r1')).toBe(true)
      expect((await objectIds(pageB, slide1Id)).includes('r1')).toBe(true)
      expect((await sceneGraphIds(pageA)).includes('r1')).toBe(true)
      expect((await sceneGraphIds(pageB)).includes('r1')).toBe(true)
      console.log('[P14b-sub] Baseline OK')

      // A adds slide2, navigates to it, then comes back
      const aSlide2Id = await pageA.evaluate(() => window.__narrative_test_api!.addSlide())
      await pageA.waitForTimeout(400)
      await clickSlide(pageA, aSlide2Id)
      await pageA.waitForTimeout(400)
      await clickSlide(pageA, slide1Id)
      await pageA.waitForTimeout(600)

      // NOW: B adds its own slide2, navigates to it, comes back
      const bSlide2Id = await pageB.evaluate(() => window.__narrative_test_api!.addSlide())
      await pageB.waitForTimeout(400)
      await clickSlide(pageB, bSlide2Id)
      await pageB.waitForTimeout(400)
      await clickSlide(pageB, slide1Id)
      await pageB.waitForTimeout(600)

      // Both back on slide 1 — how many slides total in deck now?
      const finalSlides = await listSlideIds(pageA)
      console.log('[P14b-sub] Final slide count:', finalSlides.length, '/', finalSlides)

      // Move r1 from A
      await moveObjectViaApi(pageA, 'r1', slide1Id, 600, 400)
      await pageA.waitForTimeout(1200)

      const aScene = await sceneGraphIds(pageA)
      const bScene = await sceneGraphIds(pageB)
      const aPos = await getYDocObjectPosition(pageA, slide1Id, 'r1')
      const bPos = await getYDocObjectPosition(pageB, slide1Id, 'r1')

      console.log('[P14b-sub] After A moved r1:')
      console.log('  A SceneGraph:', aScene, '/ A pos:', aPos)
      console.log('  B SceneGraph:', bScene, '/ B pos:', bPos)

      await screenshot(pageA, '10-subtest-drag-A')
      await screenshot(pageB, '10-subtest-drag-B')

      expect(
        bScene.includes('r1'),
        `[sub] B SceneGraph must have r1. Got: ${bScene.join(',')}`,
      ).toBe(true)
      expect(bPos, '[sub] B must show r1 in SceneGraph with valid bounds').not.toBeNull()

      if (aPos !== null && bPos !== null) {
        const delta = Math.abs(aPos.x - bPos.x) + Math.abs(aPos.y - bPos.y)
        console.log('[P14b-sub] Position delta A vs B:', delta)
        expect(
          delta,
          `[sub] A and B must agree on position. A=${JSON.stringify(aPos)} B=${JSON.stringify(bPos)}`,
        ).toBeLessThan(10)
      }
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
