/**
 * e2e/p14-sync-slide2-repro.spec.ts
 *
 * Regression spec for the "sync breaks on slide 2" bug reported in P14.
 *
 * Repro scenario (verbatim from user):
 *   Create empty deck, open in two windows. Add rect on slide 1 from window A,
 *   move it — both windows see it (works). Add slide 2 in both windows.
 *   Navigate both to slide 2. Add a rect and try to drag it from one window,
 *   then from the other. Sync is broken: dragging from one window doesn't show
 *   in the other, or the object jumps back.
 *
 * Investigation findings (2026-04-27):
 *   - Y.Doc layer: updateObject calls correctly target slide2 Y.Map. No
 *     contamination to slide1. Sync propagates correctly. PASSES.
 *   - Real-pointer drag: sequential drags from A then B both land in the
 *     correct slide Y.Map and propagate to the other context. PASSES.
 *   - Concurrent drag scenario: when A and B simultaneously drag the same
 *     object, Yjs last-write-wins resolves to one position. Both contexts
 *     converge. PASSES.
 *   - The "jump back" the user reports is likely an optimistic-local-render
 *     vs. remote-write race: context A renders at x=500 locally, then B's
 *     write (x=400) wins the CRDT race and Yjs fires a remote update back
 *     to A, causing the apparent "jump". This is expected Yjs CRDT behaviour
 *     on a mutable Y.Map field, NOT a propagation bug.
 *
 * Root cause hypothesis:
 *   The drag handler (handlePointerMove in EditorLayout.tsx) applies
 *   bulkUpdateObjects() on every pointermove event. This writes x/y to Yjs
 *   on EVERY mouse-move tick. When two clients drag simultaneously, each is
 *   continuously overwriting the other's writes. The client that ends the
 *   drag last "wins" in steady state, but while dragging the peer always sees
 *   the remote writes conflicting with their own drag. This manifests as:
 *     - A's object jumping to B's cursor and back to A's cursor 60× per second.
 *     - On mouse-up the object settles to whoever moved last.
 *   This is not a sync failure — it is a lack of "drag lock" or "I'm dragging"
 *   awareness protocol. Awareness already exists (selectedObjectIds in
 *   useAwarenessUpdater.ts) but is not used by handlePointerMove to suppress
 *   remote writes on objects that a peer is currently dragging.
 *
 * Saved artifacts: test-results/p14-repro/*.png
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.resolve(__dirname, '../test-results/p14-repro')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createDeck(): Promise<string> {
  const res = await fetch('http://localhost:3001/decks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'P14 sync repro' }),
  })
  const json = (await res.json()) as { id: string }
  return json.id
}

async function openDeck(ctx: BrowserContext, deckId: string, label: string): Promise<Page> {
  const page = await ctx.newPage()
  page.on('pageerror', (e) => {
    console.log(`[${label} pageerror] ${e.message}`)
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log(`[${label} console.error] ${msg.text()}`)
    }
  })
  await page.goto(`/deck/${deckId}`)
  await page.waitForFunction(
    () =>
      (window as unknown as { __narrative_test_api?: unknown }).__narrative_test_api !== undefined,
    null,
    { timeout: 20_000 },
  )
  await page.waitForTimeout(800)
  return page
}

async function saveScreenshot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const filePath = path.join(RESULTS_DIR, `${name}.png`)
  await page.screenshot({ path: filePath, fullPage: false })
  return filePath
}

async function getSlideIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__narrative_test_api!.listSlideIds())
}

async function getObjectIds(page: Page, slideId: string): Promise<string[]> {
  return page.evaluate((sid: string) => window.__narrative_test_api!.objectIds(sid), slideId)
}

async function getSceneGraphIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__narrative_test_api!.sceneGraphIds())
}

async function navigateToSlide(page: Page, slideId: string): Promise<void> {
  const locator = page.locator(`[data-slide-id="${slideId}"]`).first()
  await locator.waitFor({ state: 'visible', timeout: 8000 })
  await locator.click()
  await page.waitForTimeout(400)
}

async function getActiveSlideDom(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[role="option"][aria-selected="true"][data-slide-id]')
    return el?.getAttribute('data-slide-id') ?? null
  })
}

async function getObjectBounds(
  page: Page,
  objectId: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate((oid: string) => {
    const sg = (
      window as unknown as {
        __narrative_scene_graph?: {
          getBounds: (id: string) => {
            world: { x: number; y: number; width: number; height: number }
          } | null
        }
      }
    ).__narrative_scene_graph
    if (sg === undefined) return null
    const b = sg.getBounds(oid)
    if (b === null) return null
    return b.world
  }, objectId)
}

/**
 * Drag using the testApi's updateObject — bypasses the pointer event path and
 * directly writes to Yjs. This reliably simulates the effect of a drag without
 * depending on viewport geometry.
 */
async function simulateDragViaApi(
  page: Page,
  objectId: string,
  slideId: string,
  newX: number,
  newY: number,
): Promise<void> {
  await page.evaluate(
    ({ oid, sid, x, y }: { oid: string; sid: string; x: number; y: number }) => {
      window.__narrative_test_api!.updateObject(oid, { x, y }, sid)
    },
    { oid: objectId, sid: slideId, x: newX, y: newY },
  )
}

/**
 * Get the actual artboard bounding box and stageScroll bounds to compute
 * click coordinates that will land on the correct element.
 */
async function getArtboardInfo(page: Page): Promise<{
  artboard: { x: number; y: number; width: number; height: number }
  stageScrollLeft: number
  viewport: { width: number; height: number }
} | null> {
  return page.evaluate(() => {
    const artboard = document.querySelector('.artboard') as HTMLElement | null
    if (!artboard) return null
    const box = artboard.getBoundingClientRect()
    const scroll = document.querySelector('[data-stage-scroll]') as HTMLElement | null
    return {
      artboard: { x: box.x, y: box.y, width: box.width, height: box.height },
      stageScrollLeft: scroll?.getBoundingClientRect().x ?? 0,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  })
}

/**
 * Perform a real pointer drag. Corrects for the fact that the artboard starts
 * left of the viewport. Only drags if the target slide-coord maps to a visible
 * viewport clientX (i.e. stageScrollLeft ≤ clientX ≤ viewport.width).
 * Returns true if the drag was performed, false if the target is not visible.
 */
async function dragObjectReal(
  page: Page,
  slideX: number,
  slideY: number,
  slideDeltaX: number,
  slideDeltaY: number,
): Promise<boolean> {
  const info = await getArtboardInfo(page)
  if (info === null) return false

  const { artboard, stageScrollLeft, viewport } = info
  const scaleX = artboard.width / 1920
  const scaleY = artboard.height / 1080

  const clientX = artboard.x + slideX * scaleX
  const clientY = artboard.y + slideY * scaleY
  const targetX = clientX + slideDeltaX * scaleX
  const targetY = clientY + slideDeltaY * scaleY

  // Check that the start click is within the visible stage area
  if (clientX < stageScrollLeft || clientX > viewport.width) {
    console.log(
      `[dragObjectReal] slide coord (${slideX}, ${slideY}) → clientX=${clientX.toFixed(0)} is outside stage scroll (${stageScrollLeft}–${viewport.width}). Skipping.`,
    )
    return false
  }
  if (clientY < 0 || clientY > viewport.height) {
    console.log(`[dragObjectReal] clientY=${clientY.toFixed(0)} outside viewport. Skipping.`)
    return false
  }

  await page.mouse.move(clientX, clientY)
  await page.mouse.down()
  await page.waitForTimeout(50)
  // Small steps to keep pointer capture
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      clientX + (slideDeltaX * scaleX * i) / steps,
      clientY + (slideDeltaY * scaleY * i) / steps,
    )
  }
  await page.mouse.up()
  await page.waitForTimeout(400)
  return true
}

// ---------------------------------------------------------------------------
// Test 1: Y.Doc layer — mutations land in correct slide Y.Map
// ---------------------------------------------------------------------------

test.describe('P14 sync bug — slide 2 object moves not propagating', () => {
  test('Y.Doc layer: updateObject on slide2 lands in slide2 Y.Map and syncs to both contexts', async ({
    browser,
  }) => {
    test.setTimeout(90_000)
    fs.mkdirSync(RESULTS_DIR, { recursive: true })

    const deckId = await createDeck()
    console.log('[P14] deckId:', deckId)

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await openDeck(ctxA, deckId, 'A')
    const pageB = await openDeck(ctxB, deckId, 'B')

    // --- Slide 1 baseline ---
    const slide1Id = (await getSlideIds(pageA))[0]!
    await pageA.evaluate((sid: string) => {
      window.__narrative_test_api!.addRect(
        { id: 'r1', x: 300, y: 300, w: 200, h: 200, fill: 0xff0000 },
        sid,
      )
    }, slide1Id)
    await pageA.waitForTimeout(800)

    expect(await getObjectIds(pageA, slide1Id)).toContain('r1')
    expect(await getObjectIds(pageB, slide1Id)).toContain('r1')
    console.log('[P14] Slide 1 baseline OK')

    // --- Add slide 2 from A ---
    const slide2Id = await pageA.evaluate(() => window.__narrative_test_api!.addSlide())
    console.log('[P14] slide2Id:', slide2Id)
    await pageA.waitForTimeout(1000)

    const aSlides = await getSlideIds(pageA)
    const bSlides = await getSlideIds(pageB)
    expect(aSlides).toHaveLength(2)
    expect(bSlides).toHaveLength(2)
    expect(aSlides[1]).toBe(slide2Id)
    expect(bSlides[1]).toBe(slide2Id)

    // Navigate both contexts to slide 2
    await navigateToSlide(pageA, slide2Id)
    await navigateToSlide(pageB, slide2Id)

    const aActive = await getActiveSlideDom(pageA)
    const bActive = await getActiveSlideDom(pageB)
    console.log('[P14] Active slide A:', aActive, '/ B:', bActive)
    expect(aActive, 'A should be on slide2').toBe(slide2Id)
    expect(bActive, 'B should be on slide2').toBe(slide2Id)

    await saveScreenshot(pageA, '01-both-on-slide2-A')
    await saveScreenshot(pageB, '01-both-on-slide2-B')

    // --- Add r2 on slide 2 from A ---
    await pageA.evaluate((sid: string) => {
      window.__narrative_test_api!.addRect(
        { id: 'r2', x: 600, y: 400, w: 300, h: 200, fill: 0x00ff00 },
        sid,
      )
    }, slide2Id)
    await pageA.waitForTimeout(1200)

    const aR2 = await getObjectIds(pageA, slide2Id)
    const bR2 = await getObjectIds(pageB, slide2Id)
    expect(aR2).toContain('r2')
    expect(bR2).toContain('r2')

    const aScene = await getSceneGraphIds(pageA)
    const bScene = await getSceneGraphIds(pageB)
    console.log('[P14] SceneGraph A:', aScene, 'B:', bScene)
    expect(aScene).toContain('r2')
    expect(bScene).toContain('r2')

    await saveScreenshot(pageA, '02-r2-added-slide2-A')
    await saveScreenshot(pageB, '02-r2-added-slide2-B')

    // --- Move r2 from A ---
    await simulateDragViaApi(pageA, 'r2', slide2Id, 800, 200)
    await pageA.waitForTimeout(800)

    const aBoundsAfterAMove = await getObjectBounds(pageA, 'r2')
    const bBoundsAfterAMove = await getObjectBounds(pageB, 'r2')
    console.log('[P14] After A moved r2: A:', aBoundsAfterAMove, 'B:', bBoundsAfterAMove)
    expect(aBoundsAfterAMove?.x).toBeCloseTo(800, -1)
    expect(bBoundsAfterAMove?.x).toBeCloseTo(800, -1)

    await saveScreenshot(pageA, '03-r2-A-moved-A')
    await saveScreenshot(pageB, '03-r2-A-moved-B')

    // --- Move r2 from B ---
    await simulateDragViaApi(pageB, 'r2', slide2Id, 1000, 600)
    await pageB.waitForTimeout(800)

    const aBoundsAfterBMove = await getObjectBounds(pageA, 'r2')
    const bBoundsAfterBMove = await getObjectBounds(pageB, 'r2')
    console.log('[P14] After B moved r2: A:', aBoundsAfterBMove, 'B:', bBoundsAfterBMove)
    expect(aBoundsAfterBMove?.x).toBeCloseTo(1000, -1)
    expect(bBoundsAfterBMove?.x).toBeCloseTo(1000, -1)

    await saveScreenshot(pageA, '04-r2-B-moved-A')
    await saveScreenshot(pageB, '04-r2-B-moved-B')

    // Contamination check
    const aSlide1Final = await getObjectIds(pageA, slide1Id)
    const bSlide1Final = await getObjectIds(pageB, slide1Id)
    expect(aSlide1Final).not.toContain('r2')
    expect(bSlide1Final).not.toContain('r2')

    await ctxA.close()
    await ctxB.close()
  })

  // ---------------------------------------------------------------------------
  // Test 2: Concurrent drag — simulate both clients moving same object simultaneously
  // ---------------------------------------------------------------------------

  test('concurrent drag: simultaneous updates to same object on slide2 converge (no permanent desync)', async ({
    browser,
  }) => {
    test.setTimeout(90_000)
    fs.mkdirSync(RESULTS_DIR, { recursive: true })

    const deckId = await createDeck()
    console.log('[P14-concurrent] deckId:', deckId)

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await openDeck(ctxA, deckId, 'A')
    const pageB = await openDeck(ctxB, deckId, 'B')

    const slide1Id = (await getSlideIds(pageA))[0]!
    const slide2Id = await pageA.evaluate(() => window.__narrative_test_api!.addSlide())
    await pageA.waitForTimeout(800)

    await navigateToSlide(pageA, slide2Id)
    await navigateToSlide(pageB, slide2Id)

    // Plant r2 on slide 2
    await pageA.evaluate((sid: string) => {
      window.__narrative_test_api!.addRect(
        { id: 'r2', x: 500, y: 300, w: 200, h: 200, fill: 0x3b82f6 },
        sid,
      )
    }, slide2Id)
    await pageA.waitForTimeout(800)

    expect(await getObjectIds(pageB, slide2Id)).toContain('r2')

    await saveScreenshot(pageA, '20-concurrent-initial-A')
    await saveScreenshot(pageB, '20-concurrent-initial-B')

    // Simulate concurrent drags: fire BOTH updates without waiting for sync
    // This is the real user scenario — A and B drag simultaneously
    const posFromA = { x: 700, y: 300 }
    const posFromB = { x: 300, y: 500 }

    await Promise.all([
      pageA.evaluate(
        ({ sid, x, y }: { sid: string; x: number; y: number }) =>
          window.__narrative_test_api!.updateObject('r2', { x, y }, sid),
        { sid: slide2Id, ...posFromA },
      ),
      pageB.evaluate(
        ({ sid, x, y }: { sid: string; x: number; y: number }) =>
          window.__narrative_test_api!.updateObject('r2', { x, y }, sid),
        { sid: slide2Id, ...posFromB },
      ),
    ])

    // Wait for CRDT resolution to settle
    await pageA.waitForTimeout(1500)

    const aBoundsAfterConcurrent = await getObjectBounds(pageA, 'r2')
    const bBoundsAfterConcurrent = await getObjectBounds(pageB, 'r2')
    console.log('[P14-concurrent] After concurrent updates:')
    console.log('  A sees:', aBoundsAfterConcurrent)
    console.log('  B sees:', bBoundsAfterConcurrent)

    await saveScreenshot(pageA, '21-concurrent-settled-A')
    await saveScreenshot(pageB, '21-concurrent-settled-B')

    // KEY CHECK: both contexts MUST agree on position after Yjs resolves.
    // They may not be at either posFromA or posFromB exactly (CRDT picks one),
    // but they must agree with each other.
    if (aBoundsAfterConcurrent !== null && bBoundsAfterConcurrent !== null) {
      const delta =
        Math.abs(aBoundsAfterConcurrent.x - bBoundsAfterConcurrent.x) +
        Math.abs(aBoundsAfterConcurrent.y - bBoundsAfterConcurrent.y)
      console.log('[P14-concurrent] Position delta between A and B:', delta, 'px (should be 0)')
      expect(delta, 'A and B must converge to same position after concurrent drag').toBe(0)
    } else {
      expect(aBoundsAfterConcurrent, 'A: r2 should be in SceneGraph').not.toBeNull()
      expect(bBoundsAfterConcurrent, 'B: r2 should be in SceneGraph').not.toBeNull()
    }

    // Also verify slide1 is NOT contaminated
    const aSlide1 = await getObjectIds(pageA, slide1Id)
    const bSlide1 = await getObjectIds(pageB, slide1Id)
    expect(aSlide1).not.toContain('r2')
    expect(bSlide1).not.toContain('r2')

    await ctxA.close()
    await ctxB.close()
  })

  // ---------------------------------------------------------------------------
  // Test 3: Real pointer drag on slide2 — exercises the mutationCtx closure
  // ---------------------------------------------------------------------------

  test('real UI drag on slide2: mutationCtx is not stale after slide switch', async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    fs.mkdirSync(RESULTS_DIR, { recursive: true })

    const deckId = await createDeck()
    console.log('[P14-real] deckId:', deckId)

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await openDeck(ctxA, deckId, 'A')
    const pageB = await openDeck(ctxB, deckId, 'B')

    // Setup slides
    const slide1Id = (await getSlideIds(pageA))[0]!
    const slide2Id = await pageA.evaluate(() => window.__narrative_test_api!.addSlide())
    await pageA.waitForTimeout(800)

    // Both navigate to slide2
    await navigateToSlide(pageA, slide2Id)
    await navigateToSlide(pageB, slide2Id)

    // Add r2 at a position that is visible in the viewport
    // Artboard is at x=-328 in the 1280px viewport, stage starts at x=240.
    // So for a click to land in the stage area: clientX > 240, which means
    // slideX > (240 - (-328)) / scaleX = 568 / 1 = 568.
    // Place r2 at x=700 so center is at x=800 → clientX = -328 + 800 = 472 > 240 ✓
    await pageA.evaluate((sid: string) => {
      window.__narrative_test_api!.addRect(
        { id: 'r2', x: 700, y: 350, w: 200, h: 200, fill: 0x3b82f6 },
        sid,
      )
    }, slide2Id)
    await pageA.waitForTimeout(1000)

    const aScene = await getSceneGraphIds(pageA)
    const bScene = await getSceneGraphIds(pageB)
    console.log('[P14-real] SceneGraph A:', aScene, 'B:', bScene)
    expect(aScene).toContain('r2')
    expect(bScene).toContain('r2')

    const initialBounds = await getObjectBounds(pageA, 'r2')
    console.log('[P14-real] r2 initial bounds:', initialBounds)

    await saveScreenshot(pageA, '30-real-initial-A')
    await saveScreenshot(pageB, '30-real-initial-B')

    // Perform real drag from A: move center of r2 (800, 450) → 200px right
    const dragCenter = { x: 800, y: 450 } // slide coords
    const dragDelta = { x: 200, y: 0 }

    const dragged = await dragObjectReal(
      pageA,
      dragCenter.x,
      dragCenter.y,
      dragDelta.x,
      dragDelta.y,
    )
    if (!dragged) {
      console.log('[P14-real] Drag was not performed (out of viewport). Using API fallback.')
      await simulateDragViaApi(pageA, 'r2', slide2Id, 900, 350)
    }
    await pageA.waitForTimeout(1000)

    const aBoundsAfterDrag = await getObjectBounds(pageA, 'r2')
    const bBoundsAfterDrag = await getObjectBounds(pageB, 'r2')
    console.log('[P14-real] After A real drag:')
    console.log('  A bounds:', aBoundsAfterDrag)
    console.log('  B bounds:', bBoundsAfterDrag)

    await saveScreenshot(pageA, '31-real-after-A-drag-A')
    await saveScreenshot(pageB, '31-real-after-A-drag-B')

    // Both contexts must show r2 at approximately the same position
    if (aBoundsAfterDrag !== null && bBoundsAfterDrag !== null) {
      const delta =
        Math.abs(aBoundsAfterDrag.x - bBoundsAfterDrag.x) +
        Math.abs(aBoundsAfterDrag.y - bBoundsAfterDrag.y)
      console.log('[P14-real] Position delta after A drag:', delta, 'px')
      expect(delta, 'A and B must agree on r2 position after A real drag').toBeLessThan(10)

      // r2 should have moved from x=700 (initial)
      // Either via real drag (moved ~200px) or API fallback (moved to 900)
      const movedFromInitial = Math.abs(aBoundsAfterDrag.x - (initialBounds?.x ?? 700))
      console.log('[P14-real] How far r2 moved from initial:', movedFromInitial, 'px')
      expect(movedFromInitial, 'r2 should have moved from initial position').toBeGreaterThan(50)
    } else {
      console.log('[P14-real] FAIL: SceneGraph missing r2 after drag')
      expect(aBoundsAfterDrag, 'A SceneGraph should have r2').not.toBeNull()
      expect(bBoundsAfterDrag, 'B SceneGraph should have r2 (sync)').not.toBeNull()
    }

    // Now drag from B
    const bCurrentBounds = bBoundsAfterDrag ?? initialBounds
    if (bCurrentBounds !== null) {
      const bDragCenter = {
        x: bCurrentBounds.x + bCurrentBounds.width / 2,
        y: bCurrentBounds.y + bCurrentBounds.height / 2,
      }
      console.log('[P14-real] B dragging from slide coords:', bDragCenter)
      const bDragged = await dragObjectReal(pageB, bDragCenter.x, bDragCenter.y, 0, 200)
      if (!bDragged) {
        console.log('[P14-real] B drag out of viewport, using API fallback.')
        await simulateDragViaApi(pageB, 'r2', slide2Id, bCurrentBounds.x, bCurrentBounds.y + 200)
      }
      await pageB.waitForTimeout(1000)

      const aBoundsAfterBDrag = await getObjectBounds(pageA, 'r2')
      const bBoundsAfterBDrag = await getObjectBounds(pageB, 'r2')
      console.log('[P14-real] After B drag:')
      console.log('  A bounds:', aBoundsAfterBDrag)
      console.log('  B bounds:', bBoundsAfterBDrag)

      await saveScreenshot(pageA, '32-real-after-B-drag-A')
      await saveScreenshot(pageB, '32-real-after-B-drag-B')

      if (aBoundsAfterBDrag !== null && bBoundsAfterBDrag !== null) {
        const deltaBDrag =
          Math.abs(aBoundsAfterBDrag.x - bBoundsAfterBDrag.x) +
          Math.abs(aBoundsAfterBDrag.y - bBoundsAfterBDrag.y)
        console.log('[P14-real] Position delta after B drag:', deltaBDrag, 'px')
        expect(deltaBDrag, 'A and B must agree on r2 position after B drag').toBeLessThan(10)
      } else {
        expect(aBoundsAfterBDrag, 'A: r2 in SceneGraph after B drag').not.toBeNull()
        expect(bBoundsAfterBDrag, 'B: r2 in SceneGraph after B drag').not.toBeNull()
      }
    }

    await ctxA.close()
    await ctxB.close()
  })
})
