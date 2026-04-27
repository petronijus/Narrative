/**
 * e2e/multi-window-slide-sync.spec.ts
 *
 * Regression guard for P14: a peer client's drag must propagate to all
 * other clients viewing the same slide, even after the slide-switch
 * dance that previously stranded the observer on a stale Y.Map
 * reference.
 *
 * Repro:
 *   1. A creates deck. B opens the same URL.
 *   2. A draws a rect on slide 1 via real pointer events. B sees it.
 *   3. A drags it. B sees the move (baseline sync).
 *   4. Both clients add a slide concurrently, navigate to their new
 *      slide, then back to slide 1. This is what triggered the
 *      pre-fix bug — the local Y.Map for slide 1 was replaced under
 *      both clients via Hocuspocus sync, but cached references in
 *      useSlideObjects + the observer pipeline kept the stale
 *      Y.Array.
 *   5. A drags the rect on slide 1 again. B must see the move.
 *
 * Uses real \`page.mouse.down/move/up\` events so the entire pointer
 * → handlePointerMove → mutationCtx.objects → bulkUpdateObjects chain
 * is exercised. API-level mutation bypasses the bug.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const RESULTS_DIR = path.resolve(__dirname, '../test-results/multi-window-slide-sync')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createDeck(): Promise<string> {
  const res = await fetch('http://localhost:3001/decks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'P14c real-pointer sync repro' }),
  })
  const json = (await res.json()) as { id: string }
  return json.id
}

interface ConsoleRecord {
  type: string
  text: string
  ts: number
}

async function openDeck(
  ctx: BrowserContext,
  deckId: string,
  label: string,
): Promise<{ page: Page; consoleLog: ConsoleRecord[] }> {
  const page = await ctx.newPage()
  const consoleLog: ConsoleRecord[] = []

  page.on('pageerror', (e) => {
    console.log(`[${label} pageerror] ${e.message}`)
    consoleLog.push({ type: 'pageerror', text: e.message, ts: Date.now() })
  })

  page.on('console', (msg) => {
    const text = msg.text()
    const type = msg.type()
    // Capture debug + error messages relevant to our diagnostic
    if (text.includes('[slideObserve') || text.includes('[drag.bulk]') || type === 'error') {
      console.log(`[${label} console:${type}] ${text}`)
      consoleLog.push({ type, text, ts: Date.now() })
    }
  })

  await page.goto(`/deck/${deckId}`)
  await page.waitForFunction(
    () =>
      (window as unknown as { __narrative_test_api?: unknown }).__narrative_test_api !== undefined,
    null,
    { timeout: 25_000 },
  )
  // Give React + Pixi time to fully settle
  await page.waitForTimeout(800)
  return { page, consoleLog }
}

async function screenshot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const p = path.join(RESULTS_DIR, `${name}.png`)
  await page.screenshot({ path: p, fullPage: false })
  return p
}

/**
 * Get the bounding rect of the artboard div as seen in the viewport.
 * The artboard is CSS-transformed with scale(zoom), so getBoundingClientRect
 * returns the visual (scaled) rect. It may extend outside the viewport if zoom
 * is large; we clamp to the scroll container's visible area.
 *
 * Returns { x, y, width, height } in viewport px — safe to pass to page.mouse.
 */
async function getArtboardRect(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate(() => {
    const artboard = document.querySelector<HTMLElement>('.artboard')
    if (!artboard) throw new Error('.artboard not found')

    const scroller = document.querySelector<HTMLElement>('[data-stage-scroll]')
    const r = artboard.getBoundingClientRect()

    // Clamp to what's actually visible in the viewport
    const vpW = window.innerWidth
    const vpH = window.innerHeight

    const x = Math.max(0, Math.min(r.left, vpW - 1))
    const y = Math.max(0, Math.min(r.top, vpH - 1))
    const right = Math.max(0, Math.min(r.right, vpW))
    const bottom = Math.max(0, Math.min(r.bottom, vpH))

    return {
      x,
      y,
      width: right - x,
      height: bottom - y,
      // also expose the raw artboard dimensions so slide→viewport conversion works
      rawX: r.left,
      rawY: r.top,
      rawWidth: r.width,
      rawHeight: r.height,
    } as { x: number; y: number; width: number; height: number }
  })
}

/**
 * Get the raw (possibly offscreen) artboard rect for coordinate conversion.
 * Use this for slide→viewport math, not for clamped viewport targeting.
 */
async function getRawArtboardRect(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate(() => {
    const artboard = document.querySelector<HTMLElement>('.artboard')
    if (!artboard) throw new Error('.artboard not found')
    const r = artboard.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  })
}

/** Convert slide-space coords to viewport coords using the artboard's bounding rect. */
function slideToViewport(
  slideX: number,
  slideY: number,
  rect: { x: number; y: number; width: number; height: number },
  slideWidth = 1920,
  slideHeight = 1080,
): { x: number; y: number } {
  const scaleX = rect.width / slideWidth
  const scaleY = rect.height / slideHeight
  return {
    x: rect.x + slideX * scaleX,
    y: rect.y + slideY * scaleY,
  }
}

/**
 * Select the Rectangle tool via Toolbar:
 *   1. Click "Shapes" dropdown button
 *   2. Click "Rectangle (R)" menu item
 */
async function selectRectangleTool(page: Page): Promise<void> {
  // Click the Shapes dropdown button
  const shapesBtn = page.getByRole('button', { name: 'Shapes' })
  await shapesBtn.waitFor({ state: 'visible', timeout: 5000 })
  await shapesBtn.click()
  // Click Rectangle in the dropdown
  const rectItem = page.getByRole('menuitem', { name: 'Rectangle (R)' })
  await rectItem.waitFor({ state: 'visible', timeout: 3000 })
  await rectItem.click()
  // Short pause for tool state to update
  await page.waitForTimeout(150)
}

/**
 * Draw a rectangle on the canvas using real drag-to-draw gesture.
 * Coords are in slide-space (0..1920, 0..1080).
 */
async function drawRectOnCanvas(
  page: Page,
  slideX1: number,
  slideY1: number,
  slideX2: number,
  slideY2: number,
): Promise<void> {
  const rawRect = await getRawArtboardRect(page)
  const from = slideToViewport(slideX1, slideY1, rawRect)
  const to = slideToViewport(slideX2, slideY2, rawRect)

  // Sanity check — ensure coords are within viewport
  const vp = page.viewportSize() ?? { width: 1280, height: 720 }
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  const fromC = { x: clamp(from.x, 1, vp.width - 1), y: clamp(from.y, 1, vp.height - 1) }
  const toC = { x: clamp(to.x, 1, vp.width - 1), y: clamp(to.y, 1, vp.height - 1) }

  console.log(
    `[drawRect] viewport from=(${fromC.x.toFixed(0)},${fromC.y.toFixed(0)}) to=(${toC.x.toFixed(0)},${toC.y.toFixed(0)}) rawRect=(${rawRect.x.toFixed(0)},${rawRect.y.toFixed(0)},${rawRect.width.toFixed(0)}x${rawRect.height.toFixed(0)})`,
  )

  await page.mouse.move(fromC.x, fromC.y)
  await page.mouse.down()
  // Move in steps to trigger pointermove events
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    const px = fromC.x + (toC.x - fromC.x) * (i / steps)
    const py = fromC.y + (toC.y - fromC.y) * (i / steps)
    await page.mouse.move(px, py)
    await page.waitForTimeout(16) // ~1 frame
  }
  await page.mouse.up()
  await page.waitForTimeout(300)
}

/**
 * Drag an object at (centerSlideX, centerSlideY) to a new position.
 * Uses real pointer events through the canvas-backdrop.
 */
async function dragObjectOnCanvas(
  page: Page,
  fromSlideX: number,
  fromSlideY: number,
  toSlideX: number,
  toSlideY: number,
): Promise<void> {
  const rawRect = await getRawArtboardRect(page)
  const from = slideToViewport(fromSlideX, fromSlideY, rawRect)
  const to = slideToViewport(toSlideX, toSlideY, rawRect)

  const vp = page.viewportSize() ?? { width: 1280, height: 720 }
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  const fromC = { x: clamp(from.x, 1, vp.width - 1), y: clamp(from.y, 1, vp.height - 1) }
  const toC = { x: clamp(to.x, 1, vp.width - 1), y: clamp(to.y, 1, vp.height - 1) }

  console.log(
    `[dragObject] viewport from=(${fromC.x.toFixed(0)},${fromC.y.toFixed(0)}) to=(${toC.x.toFixed(0)},${toC.y.toFixed(0)})`,
  )

  await page.mouse.move(fromC.x, fromC.y)
  await page.mouse.down()
  await page.waitForTimeout(50) // let handlePointerDown fire
  // Move in steps
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    const px = fromC.x + (toC.x - fromC.x) * (i / steps)
    const py = fromC.y + (toC.y - fromC.y) * (i / steps)
    await page.mouse.move(px, py)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  await page.waitForTimeout(400) // rAF + sync propagation
}

async function listSlideIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__narrative_test_api!.listSlideIds())
}

async function objectIds(page: Page, slideId: string): Promise<string[]> {
  return page.evaluate((sid: string) => window.__narrative_test_api!.objectIds(sid), slideId)
}

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

async function getSceneGraphPosition(
  page: Page,
  objectId: string,
): Promise<{ x: number; y: number } | null> {
  return page.evaluate((oid: string) => {
    const sg = (
      window as unknown as {
        __narrative_scene_graph?: {
          getBounds: (id: string) => { world: { x: number; y: number } } | null
        }
      }
    ).__narrative_scene_graph
    if (!sg) return null
    const b = sg.getBounds(oid)
    return b ? { x: b.world.x, y: b.world.y } : null
  }, objectId)
}

async function clickSlide(page: Page, slideId: string): Promise<void> {
  const loc = page.locator(`[data-slide-id="${slideId}"]`).first()
  await loc.waitFor({ state: 'visible', timeout: 8000 })
  await loc.click()
  await page.waitForTimeout(500)
}

async function getActiveSlideId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[role="option"][aria-selected="true"][data-slide-id]')
    return el?.getAttribute('data-slide-id') ?? null
  })
}

/** Click "+ Add Slide" button in the SlidesPanel. */
async function clickAddSlide(page: Page): Promise<void> {
  const btn = page.getByRole('button', { name: 'Add slide' })
  await btn.waitFor({ state: 'visible', timeout: 5000 })
  await btn.click()
  await page.waitForTimeout(500)
}

// ---------------------------------------------------------------------------
// Main spec
// ---------------------------------------------------------------------------

test.describe('P14c — real-pointer drag sync after slide-switch dance', () => {
  test('B sees A drag after both add+visit+return-from slide 2 — real pointer events', async ({
    browser,
  }) => {
    test.setTimeout(240_000)
    fs.mkdirSync(RESULTS_DIR, { recursive: true })

    const deckId = await createDeck()
    console.log('[P14c] deckId:', deckId)

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()

    try {
      const { page: pageA, consoleLog: logA } = await openDeck(ctxA, deckId, 'A')
      const { page: pageB, consoleLog: logB } = await openDeck(ctxB, deckId, 'B')

      // -----------------------------------------------------------------------
      // Step 3: A creates a rectangle on slide 1 using REAL pointer events
      // -----------------------------------------------------------------------
      const slide1Id = (await listSlideIds(pageA))[0]!
      console.log('[P14c] slide1Id:', slide1Id)

      // Select rectangle tool via Shapes dropdown
      await selectRectangleTool(pageA)
      console.log('[P14c] Rectangle tool selected on A')

      // Draw rectangle near the slide center so coords are within the visible viewport.
      // At zoom=100% the 1920x1080 artboard overflows a 1280x720 viewport; visible
      // slide-space starts at approx (320,180). Use (700,350)→(1000,600).
      await drawRectOnCanvas(pageA, 700, 350, 1000, 600)
      console.log('[P14c] A drew rectangle via real pointer events')

      await screenshot(pageA, '00-after-draw-A')
      await screenshot(pageB, '00-after-draw-B')

      // Wait for the rect to appear in A's Y.Doc, then sync to B
      await expect(async () => {
        const ids = await objectIds(pageA, slide1Id)
        expect(ids.length).toBeGreaterThan(0)
      }).toPass({ timeout: 5000 })

      await pageB.waitForTimeout(1200) // sync propagation

      const aObjIds = await objectIds(pageA, slide1Id)
      const bObjIds = await objectIds(pageB, slide1Id)
      console.log('[P14c] A objects on slide1:', aObjIds)
      console.log('[P14c] B objects on slide1:', bObjIds)

      // We need at least one object on both sides
      expect(aObjIds.length, 'A: rect created on slide 1').toBeGreaterThan(0)
      expect(bObjIds.length, 'B: rect synced to slide 1').toBeGreaterThan(0)

      const rectId = aObjIds[0]!
      console.log('[P14c] rectId:', rectId)

      // -----------------------------------------------------------------------
      // Step 4: Baseline drag — A drags rect, B should see new position
      // -----------------------------------------------------------------------
      // The rect was drawn at slide coords approx (700,350)→(1000,600), center ~(850,475)
      // Switch A back to select tool first
      await pageA.keyboard.press('v')
      await pageA.waitForTimeout(150)

      // Click rect to select it (its center in slide coords)
      const rectCenterSlideX = 850
      const rectCenterSlideY = 475

      // Click to select
      const artboardRectA = await getRawArtboardRect(pageA)
      const vp1 = pageA.viewportSize() ?? { width: 1280, height: 720 }
      const clamp1 = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
      const rawClickPt = slideToViewport(rectCenterSlideX, rectCenterSlideY, artboardRectA)
      const clickPt = {
        x: clamp1(rawClickPt.x, 1, vp1.width - 1),
        y: clamp1(rawClickPt.y, 1, vp1.height - 1),
      }
      await pageA.mouse.click(clickPt.x, clickPt.y)
      await pageA.waitForTimeout(200)

      // Drag to a new position, keeping it in the visible viewport area
      console.log('[P14c] Step 4: Baseline drag A → (600,400)')
      const dragToBefore = { x: 600, y: 400 }
      await dragObjectOnCanvas(
        pageA,
        rectCenterSlideX,
        rectCenterSlideY,
        dragToBefore.x,
        dragToBefore.y,
      )

      await pageA.waitForTimeout(800)
      await pageB.waitForTimeout(1200)

      const aPosBefore = await getYDocPosition(pageA, slide1Id, rectId)
      const bPosBefore = await getYDocPosition(pageB, slide1Id, rectId)
      console.log('[P14c] [Baseline] A Y.Doc pos:', aPosBefore)
      console.log('[P14c] [Baseline] B Y.Doc pos:', bPosBefore)

      await screenshot(pageA, '01-baseline-drag-A')
      await screenshot(pageB, '01-baseline-drag-B')

      const baselineDelta =
        aPosBefore !== null && bPosBefore !== null
          ? Math.abs(aPosBefore.x - bPosBefore.x) + Math.abs(aPosBefore.y - bPosBefore.y)
          : 9999
      console.log('[P14c] [Baseline] A-B position delta:', baselineDelta, 'px')

      // -----------------------------------------------------------------------
      // Step 5: A and B click "+ Add Slide" CONCURRENTLY so they each insert
      // their own separate slide into the shared Y.Doc. Sequential clicks
      // would let the first slide sync before the second is added,
      // resulting in both clients navigating to the same slide.
      // -----------------------------------------------------------------------
      await Promise.all([clickAddSlide(pageA), clickAddSlide(pageB)])
      // Give both adds time to propagate
      await pageA.waitForTimeout(800)
      await pageB.waitForTimeout(800)

      const aSlidesAfterAdd = await listSlideIds(pageA)
      const bSlidesAfterAdd = await listSlideIds(pageB)
      console.log('[P14c] A slides after add:', aSlidesAfterAdd)
      console.log('[P14c] B slides after add:', bSlidesAfterAdd)

      // Each client added their own slide concurrently. The deck should have 3 slides:
      //   [slide1, A's new slide, B's new slide] (or 2 if one write was swallowed)
      // A's slide2 = the first non-slide1 slide in A's list (sorted by Y.Array order)
      const aNewSlides = aSlidesAfterAdd.filter((id) => id !== slide1Id)
      const bNewSlides = bSlidesAfterAdd.filter((id) => id !== slide1Id)

      // A navigates to its OWN newly-added slide (last one it added, index after slide1)
      const aSlide2Id = aNewSlides[aNewSlides.length - 1] ?? aNewSlides[0] ?? aSlidesAfterAdd[1]!
      // B navigates to a slide that is NOT A's slide2 (to ensure they're on different slides)
      const bSlideCandidate =
        bNewSlides.find((id) => id !== aSlide2Id) ?? bNewSlides[0] ?? bSlidesAfterAdd[1]!
      const bSlide2Id = bSlideCandidate

      console.log('[P14c] Total slides in deck:', aSlidesAfterAdd.length)
      console.log('[P14c] A slide2:', aSlide2Id, '/ B slide2:', bSlide2Id)
      console.log('[P14c] Are A and B on DIFFERENT slides?', aSlide2Id !== bSlide2Id)

      // -----------------------------------------------------------------------
      // Step 6: A navigates to their slide 2, B to theirs
      // -----------------------------------------------------------------------
      await clickSlide(pageA, aSlide2Id)
      await clickSlide(pageB, bSlide2Id)

      const aActive1 = await getActiveSlideId(pageA)
      const bActive1 = await getActiveSlideId(pageB)
      console.log('[P14c] After clicking slide2: A active:', aActive1, '/ B active:', bActive1)

      await screenshot(pageA, '02-on-slide2-A')
      await screenshot(pageB, '02-on-slide2-B')

      // -----------------------------------------------------------------------
      // Step 7: Both navigate back to slide 1
      // -----------------------------------------------------------------------
      await clickSlide(pageA, slide1Id)
      await clickSlide(pageB, slide1Id)

      const aActive2 = await getActiveSlideId(pageA)
      const bActive2 = await getActiveSlideId(pageB)
      console.log('[P14c] After returning to slide1: A active:', aActive2, '/ B active:', bActive2)

      expect(aActive2, 'A should be on slide1').toBe(slide1Id)
      expect(bActive2, 'B should be on slide1').toBe(slide1Id)

      // Give React state time to settle after slide switch
      await pageA.waitForTimeout(1000)
      await pageB.waitForTimeout(1000)

      await screenshot(pageA, '03-back-on-slide1-A')
      await screenshot(pageB, '03-back-on-slide1-B')

      // -----------------------------------------------------------------------
      // Step 8: A drags rect on slide 1 with REAL pointer events — THE BUG TRIGGER
      // -----------------------------------------------------------------------
      // Re-click rect to select it (it's now at approx dragToBefore position)
      const artboardRectA2 = await getRawArtboardRect(pageA)
      const vp2 = pageA.viewportSize() ?? { width: 1280, height: 720 }
      const clamp2 = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

      // Get current position from Y.Doc so we can compute the viewport hit point
      const currentPos = await getYDocPosition(pageA, slide1Id, rectId)
      console.log('[P14c] Current rect Y.Doc position before step-8 drag:', currentPos)

      let dragFromSlideX = dragToBefore.x + 150 // center of rect at new position (width ~300)
      let dragFromSlideY = dragToBefore.y + 100

      if (currentPos !== null) {
        // Use actual position from Y.Doc: object was drawn 200px wide, 200px tall
        dragFromSlideX = currentPos.x + 150
        dragFromSlideY = currentPos.y + 100
      }

      // Click to select
      const rawSelectPt2 = slideToViewport(dragFromSlideX, dragFromSlideY, artboardRectA2)
      const selectPt2 = {
        x: clamp2(rawSelectPt2.x, 1, vp2.width - 1),
        y: clamp2(rawSelectPt2.y, 1, vp2.height - 1),
      }
      await pageA.mouse.click(selectPt2.x, selectPt2.y)
      await pageA.waitForTimeout(200)

      // Now drag to a clearly different position
      const dragToAfter = { x: dragFromSlideX + 400, y: dragFromSlideY + 200 }
      console.log(
        '[P14c] Step 8: drag from',
        { x: dragFromSlideX, y: dragFromSlideY },
        'to',
        dragToAfter,
      )

      await dragObjectOnCanvas(pageA, dragFromSlideX, dragFromSlideY, dragToAfter.x, dragToAfter.y)

      console.log('[P14c] A dragged rect with real pointer events (post slide-switch dance)')

      // Wait for rAF flush + WS sync to propagate
      await pageA.waitForTimeout(1500)
      await pageB.waitForTimeout(1500)

      // -----------------------------------------------------------------------
      // Diagnostics: capture layer-by-layer state
      // -----------------------------------------------------------------------
      const aYDocFinal = await getYDocPosition(pageA, slide1Id, rectId)
      const bYDocFinal = await getYDocPosition(pageB, slide1Id, rectId)
      const aSGFinal = await getSceneGraphPosition(pageA, rectId)
      const bSGFinal = await getSceneGraphPosition(pageB, rectId)

      console.log('[P14c] [Layer: Y.Doc] A final pos:', aYDocFinal)
      console.log('[P14c] [Layer: Y.Doc] B final pos:', bYDocFinal)
      console.log('[P14c] [Layer: SceneGraph] A final:', aSGFinal)
      console.log('[P14c] [Layer: SceneGraph] B final:', bSGFinal)

      // Pinpoint the bug layer
      const movedEnoughA =
        aYDocFinal !== null && (currentPos === null || Math.abs(aYDocFinal.x - currentPos.x) > 50)

      console.log('[P14c] A Y.Doc shows rect moved:', movedEnoughA)

      if (aYDocFinal !== null && bYDocFinal !== null) {
        const ydocDelta =
          Math.abs(aYDocFinal.x - bYDocFinal.x) + Math.abs(aYDocFinal.y - bYDocFinal.y)
        console.log('[P14c] [Diagnosis] Y.Doc delta A-B:', ydocDelta, 'px')
        if (ydocDelta > 50) {
          console.log(
            '[P14c] [Diagnosis] ROOT CAUSE = Y.Doc / sync layer: update did NOT reach B Y.Doc',
          )
        } else if (
          bSGFinal === null ||
          (aSGFinal !== null && Math.abs(aSGFinal.x - bSGFinal.x) > 50)
        ) {
          console.log(
            '[P14c] [Diagnosis] ROOT CAUSE = observer/SceneGraph layer: Y.Doc synced but Pixi on B is stale',
          )
          console.log(
            '[P14c] [Diagnosis] Check: subscribeToSlideObjects observer may be watching a stale slide Y.Array ref',
          )
        } else {
          console.log('[P14c] [Diagnosis] All layers converged — bug NOT reproduced this run')
        }
      } else {
        console.log('[P14c] [Diagnosis] One or both Y.Doc positions are null')
      }

      await screenshot(pageA, '04-after-step8-drag-A')
      await screenshot(pageB, '04-after-step8-drag-B')

      // -----------------------------------------------------------------------
      // Console log transcript
      // -----------------------------------------------------------------------
      console.log('\n=== Context A console transcript (diagnostic messages) ===')
      for (const entry of logA) {
        console.log(`  [A +${entry.ts}ms] ${entry.text}`)
      }
      console.log('\n=== Context B console transcript (diagnostic messages) ===')
      for (const entry of logB) {
        console.log(`  [B +${entry.ts}ms] ${entry.text}`)
      }

      // Save transcript to file
      const transcript = {
        deckId,
        slide1Id,
        rectId,
        aYDocFinal,
        bYDocFinal,
        aSGFinal,
        bSGFinal,
        baselineDelta,
        logA,
        logB,
      }
      fs.writeFileSync(
        path.join(RESULTS_DIR, 'console-transcript.json'),
        JSON.stringify(transcript, null, 2),
      )

      // -----------------------------------------------------------------------
      // Assertions — detect the bug
      // -----------------------------------------------------------------------

      // A must have moved the object
      if (movedEnoughA) {
        console.log('[P14c] CONFIRMED: A moved the rect via real pointer events')
      } else {
        console.log('[P14c] WARNING: A may not have dragged correctly (hit-test missed?)')
      }

      // The key assertion: B must see the same position as A
      expect(bYDocFinal, '[Y.Doc] B must still have the rect on slide1').not.toBeNull()
      expect(bSGFinal, '[SceneGraph] B Pixi must have rect mounted').not.toBeNull()

      if (aYDocFinal !== null && bYDocFinal !== null) {
        const ydocDelta =
          Math.abs(aYDocFinal.x - bYDocFinal.x) + Math.abs(aYDocFinal.y - bYDocFinal.y)
        // This should fail if the bug is present — B's Y.Doc position diverged from A's
        expect(
          ydocDelta,
          `[Y.Doc] A and B must agree on position after real drag. A=${JSON.stringify(aYDocFinal)}, B=${JSON.stringify(bYDocFinal)}`,
        ).toBeLessThan(20)
      }

      if (aSGFinal !== null && bSGFinal !== null) {
        const sgDelta = Math.abs(aSGFinal.x - bSGFinal.x) + Math.abs(aSGFinal.y - bSGFinal.y)
        expect(
          sgDelta,
          `[SceneGraph] A and B Pixi must agree on position. A=${JSON.stringify(aSGFinal)}, B=${JSON.stringify(bSGFinal)}`,
        ).toBeLessThan(20)
      }
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
