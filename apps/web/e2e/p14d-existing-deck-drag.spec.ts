/**
 * e2e/p14d-existing-deck-drag.spec.ts
 *
 * Minimal repro for the P14 sync bug — simplest possible flow per user report:
 *
 *   1. Both A and B open an existing deck (rFrM1biNm7Yn, 2 slides).
 *   2. Both navigate to slide 2.
 *   3. A draws a rectangle on slide 2 using real pointer events.
 *   4. B waits for the rect to appear via Y.Doc sync.
 *   5. A drags the rectangle using real pointer events.
 *   6. Expected: B sees the rect at its new position.
 *   7. Actual (bug): B's Y.Doc or SceneGraph stays at the old position.
 *
 * No concurrent slide additions, no slide-switch dance — this is the
 * minimal repro the user says trivially fails in real Chrome.
 *
 * Diagnostic console.debug is injected into slideObserve.ts and Canvas.tsx
 * via page.addInitScript() — avoids touching production code.
 *
 * Run:
 *   npx playwright test e2e/p14d-existing-deck-drag.spec.ts --project=chromium
 *
 * Artifacts: test-results/p14d-existing-deck/
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const RESULTS_DIR = path.resolve(__dirname, '../test-results/p14d-existing-deck')

const DECK_ID = 'rFrM1biNm7Yn'

// ---------------------------------------------------------------------------
// Console capture
// ---------------------------------------------------------------------------

interface ConsoleRecord {
  type: string
  text: string
  ts: number
}

// ---------------------------------------------------------------------------
// Browser context factory
// ---------------------------------------------------------------------------

async function openDeck(
  ctx: BrowserContext,
  deckId: string,
  label: string,
): Promise<{ page: Page; consoleLog: ConsoleRecord[] }> {
  const page = await ctx.newPage()
  const consoleLog: ConsoleRecord[] = []

  page.on('pageerror', (e) => {
    const entry = { type: 'pageerror', text: e.message, ts: Date.now() }
    consoleLog.push(entry)
    console.log(`[${label} pageerror] ${e.message}`)
  })

  page.on('console', (msg) => {
    const text = msg.text()
    const type = msg.type()
    // Capture diagnostic + error lines
    if (
      text.includes('[slideObserve') ||
      text.includes('[Canvas.applyChanges]') ||
      text.includes('[dragLock') ||
      text.includes('[drag.bulk]') ||
      text.includes('[P14d') ||
      type === 'error'
    ) {
      const entry = { type, text, ts: Date.now() }
      consoleLog.push(entry)
      console.log(`[${label} ${type}] ${text}`)
    }
  })

  await page.goto(`/deck/${deckId}`)
  await page.waitForFunction(
    () =>
      (window as unknown as { __narrative_test_api?: unknown }).__narrative_test_api !== undefined,
    null,
    { timeout: 30_000 },
  )
  // Give React + Pixi time to fully settle
  await page.waitForTimeout(1000)
  return { page, consoleLog }
}

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

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

function clampToViewport(
  pt: { x: number; y: number },
  vp: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.max(1, Math.min(pt.x, vp.width - 1)),
    y: Math.max(1, Math.min(pt.y, vp.height - 1)),
  }
}

// ---------------------------------------------------------------------------
// Tool selection
// ---------------------------------------------------------------------------

async function selectRectangleTool(page: Page): Promise<void> {
  // First try keyboard shortcut R
  await page.keyboard.press('r')
  await page.waitForTimeout(150)

  // Verify the tool was set — fall back to menu if not
  const toolSet = await page.evaluate(() => {
    // Check if activeTool is 'rect' by looking at a toolbar button's aria state
    const btn = document.querySelector('[data-tool="rect"], [aria-label*="Rectangle"]')
    return btn !== null
  })

  if (!toolSet) {
    // Use Shapes dropdown
    const shapesBtn = page.getByRole('button', { name: 'Shapes' })
    await shapesBtn.waitFor({ state: 'visible', timeout: 5000 })
    await shapesBtn.click()
    const rectItem = page.getByRole('menuitem', { name: /rectangle/i })
    await rectItem.waitFor({ state: 'visible', timeout: 3000 })
    await rectItem.click()
    await page.waitForTimeout(150)
  }
}

// ---------------------------------------------------------------------------
// Pointer interactions
// ---------------------------------------------------------------------------

async function drawRectOnCanvas(
  page: Page,
  slideX1: number,
  slideY1: number,
  slideX2: number,
  slideY2: number,
): Promise<void> {
  const rawRect = await getRawArtboardRect(page)
  const vp = page.viewportSize() ?? { width: 1280, height: 720 }
  const from = clampToViewport(slideToViewport(slideX1, slideY1, rawRect), vp)
  const to = clampToViewport(slideToViewport(slideX2, slideY2, rawRect), vp)

  console.log(
    `[P14d drawRect] from=(${from.x.toFixed(0)},${from.y.toFixed(0)}) to=(${to.x.toFixed(0)},${to.y.toFixed(0)}) raw=(${rawRect.x.toFixed(0)},${rawRect.y.toFixed(0)},${rawRect.width.toFixed(0)}x${rawRect.height.toFixed(0)})`,
  )

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    const px = from.x + (to.x - from.x) * (i / steps)
    const py = from.y + (to.y - from.y) * (i / steps)
    await page.mouse.move(px, py)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  await page.waitForTimeout(400)
}

async function dragObjectOnCanvas(
  page: Page,
  fromSlideX: number,
  fromSlideY: number,
  toSlideX: number,
  toSlideY: number,
): Promise<void> {
  const rawRect = await getRawArtboardRect(page)
  const vp = page.viewportSize() ?? { width: 1280, height: 720 }
  const from = clampToViewport(slideToViewport(fromSlideX, fromSlideY, rawRect), vp)
  const to = clampToViewport(slideToViewport(toSlideX, toSlideY, rawRect), vp)

  console.log(
    `[P14d dragObject] from=(${from.x.toFixed(0)},${from.y.toFixed(0)}) to=(${to.x.toFixed(0)},${to.y.toFixed(0)})`,
  )

  // Move to hit point, then start drag
  await page.mouse.move(from.x, from.y)
  await page.waitForTimeout(50)
  await page.mouse.down()
  await page.waitForTimeout(80) // let handlePointerDown fire and lock

  const steps = 14
  for (let i = 1; i <= steps; i++) {
    const px = from.x + (to.x - from.x) * (i / steps)
    const py = from.y + (to.y - from.y) * (i / steps)
    await page.mouse.move(px, py)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  await page.waitForTimeout(500)
}

// ---------------------------------------------------------------------------
// Test API wrappers
// ---------------------------------------------------------------------------

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
  await page.waitForTimeout(600)
}

async function getActiveSlideId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[role="option"][aria-selected="true"][data-slide-id]')
    return el?.getAttribute('data-slide-id') ?? null
  })
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

async function screenshot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const p = path.join(RESULTS_DIR, `${name}.png`)
  await page.screenshot({ path: p, fullPage: false })
  return p
}

// ---------------------------------------------------------------------------
// Main spec
// ---------------------------------------------------------------------------

test.describe('P14d — minimal drag sync repro (existing deck, no slide creation)', () => {
  test('B sees A drag on slide 2 of existing deck', async ({ browser }) => {
    test.setTimeout(180_000)
    fs.mkdirSync(RESULTS_DIR, { recursive: true })

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()

    try {
      // ------------------------------------------------------------------
      // Step 1: Both open the existing deck
      // ------------------------------------------------------------------
      console.log(`[P14d] Opening deck ${DECK_ID}`)
      const { page: pageA, consoleLog: logA } = await openDeck(ctxA, DECK_ID, 'A')
      const { page: pageB, consoleLog: logB } = await openDeck(ctxB, DECK_ID, 'B')

      // ------------------------------------------------------------------
      // Step 2: Both navigate to slide 2
      // ------------------------------------------------------------------
      const slidesA = await listSlideIds(pageA)
      const slidesB = await listSlideIds(pageB)
      console.log('[P14d] A slides:', slidesA)
      console.log('[P14d] B slides:', slidesB)

      expect(slidesA.length, 'Deck must have at least 2 slides').toBeGreaterThanOrEqual(2)

      const slide2Id = slidesA[1]!
      console.log('[P14d] slide2Id:', slide2Id)

      await clickSlide(pageA, slide2Id)
      await clickSlide(pageB, slide2Id)

      const aActive = await getActiveSlideId(pageA)
      const bActive = await getActiveSlideId(pageB)
      console.log('[P14d] A active slide:', aActive)
      console.log('[P14d] B active slide:', bActive)

      expect(aActive, 'A must be on slide 2').toBe(slide2Id)
      expect(bActive, 'B must be on slide 2').toBe(slide2Id)

      await screenshot(pageA, '00-both-on-slide2-A')
      await screenshot(pageB, '00-both-on-slide2-B')

      // ------------------------------------------------------------------
      // Step 3: A draws a rectangle on slide 2 using REAL pointer events
      // ------------------------------------------------------------------
      // Select rectangle tool on A
      await selectRectangleTool(pageA)
      console.log('[P14d] Rectangle tool selected on A')

      // Draw rect near the center — slide coords (600,300) → (900,550).
      // At default zoom the artboard is scaled; the helper converts to viewport px.
      await drawRectOnCanvas(pageA, 600, 300, 900, 550)
      console.log('[P14d] A drew rectangle')

      await screenshot(pageA, '01-after-draw-A')
      await screenshot(pageB, '01-after-draw-B')

      // Wait for rect in A's Y.Doc
      await expect(async () => {
        const ids = await objectIds(pageA, slide2Id)
        expect(ids.length).toBeGreaterThan(0)
      }).toPass({ timeout: 6000 })

      // Wait for sync to B
      await pageB.waitForTimeout(1500)

      const aObjIds = await objectIds(pageA, slide2Id)
      const bObjIds = await objectIds(pageB, slide2Id)
      console.log('[P14d] A objects on slide2:', aObjIds)
      console.log('[P14d] B objects on slide2:', bObjIds)

      expect(aObjIds.length, 'A must have rect on slide 2').toBeGreaterThan(0)
      expect(bObjIds.length, 'B must see synced rect on slide 2').toBeGreaterThan(0)

      // Grab rect id — last inserted is last in array (most recent)
      const rectId = aObjIds[aObjIds.length - 1]!
      console.log('[P14d] rectId:', rectId)

      const posBeforeDrag = await getYDocPosition(pageA, slide2Id, rectId)
      const bPosBefore = await getYDocPosition(pageB, slide2Id, rectId)
      console.log('[P14d] A Y.Doc pos before drag:', posBeforeDrag)
      console.log('[P14d] B Y.Doc pos before drag:', bPosBefore)

      // ------------------------------------------------------------------
      // Step 4: Switch A back to select tool
      // ------------------------------------------------------------------
      await pageA.keyboard.press('v')
      await pageA.waitForTimeout(200)

      // ------------------------------------------------------------------
      // Step 5: A clicks to select the rect, then drags it
      // ------------------------------------------------------------------
      // Rect was drawn at (600,300)→(900,550), center approx (750,425)
      const rectCenterX = posBeforeDrag !== null ? posBeforeDrag.x + 150 : 750
      const rectCenterY = posBeforeDrag !== null ? posBeforeDrag.y + 125 : 425

      // Click to select
      const rawRectA = await getRawArtboardRect(pageA)
      const vpA = pageA.viewportSize() ?? { width: 1280, height: 720 }
      const selectPt = clampToViewport(slideToViewport(rectCenterX, rectCenterY, rawRectA), vpA)
      await pageA.mouse.click(selectPt.x, selectPt.y)
      await pageA.waitForTimeout(300)

      console.log('[P14d] Step 5: Dragging rect from', { x: rectCenterX, y: rectCenterY })

      // Drag 350px to the right, 200px down in slide coords
      const dragToX = rectCenterX + 350
      const dragToY = rectCenterY + 200

      // Clear diagnostic console buffers before the drag so the transcript
      // only shows events during/after the critical operation.
      logA.length = 0
      logB.length = 0

      await dragObjectOnCanvas(pageA, rectCenterX, rectCenterY, dragToX, dragToY)

      console.log('[P14d] A finished dragging rect')

      // ------------------------------------------------------------------
      // Step 6: Wait for sync, then measure both layers on A and B
      // ------------------------------------------------------------------
      await pageA.waitForTimeout(1500)
      await pageB.waitForTimeout(1500)

      await screenshot(pageA, '02-after-drag-A')
      await screenshot(pageB, '02-after-drag-B')

      const aYDocFinal = await getYDocPosition(pageA, slide2Id, rectId)
      const bYDocFinal = await getYDocPosition(pageB, slide2Id, rectId)
      const aSGFinal = await getSceneGraphPosition(pageA, rectId)
      const bSGFinal = await getSceneGraphPosition(pageB, rectId)

      console.log('[P14d] [Y.Doc] A final:', aYDocFinal)
      console.log('[P14d] [Y.Doc] B final:', bYDocFinal)
      console.log('[P14d] [SceneGraph] A final:', aSGFinal)
      console.log('[P14d] [SceneGraph] B final:', bSGFinal)

      // ------------------------------------------------------------------
      // Diagnosis
      // ------------------------------------------------------------------
      const aMoved =
        aYDocFinal !== null &&
        posBeforeDrag !== null &&
        Math.abs(aYDocFinal.x - posBeforeDrag.x) > 50

      console.log('[P14d] A Y.Doc shows rect moved:', aMoved)

      if (!aMoved) {
        console.log(
          '[P14d] WARNING: A may not have moved the rect — hit-test may have missed. Check screenshots.',
        )
      }

      if (aYDocFinal !== null && bYDocFinal !== null) {
        const ydocDelta =
          Math.abs(aYDocFinal.x - bYDocFinal.x) + Math.abs(aYDocFinal.y - bYDocFinal.y)
        console.log('[P14d] [Diagnosis] Y.Doc A-B delta:', ydocDelta, 'px')

        if (ydocDelta > 50) {
          console.log(
            '[P14d] [Diagnosis] ROOT CAUSE = SYNC/Y.Doc layer: A wrote but B did NOT receive the update in Y.Doc',
          )
        } else if (bSGFinal === null) {
          console.log(
            '[P14d] [Diagnosis] ROOT CAUSE = RECONCILER: B Y.Doc has correct pos but SceneGraph is null/stale',
          )
        } else if (aSGFinal !== null && Math.abs(aSGFinal.x - bSGFinal.x) > 50) {
          console.log(
            '[P14d] [Diagnosis] ROOT CAUSE = OBSERVER/RECONCILER: Y.Doc synced but Pixi on B is stale',
          )
        } else {
          console.log('[P14d] [Diagnosis] All layers converged — bug NOT reproduced this run')
        }
      } else if (aYDocFinal === null) {
        console.log('[P14d] [Diagnosis] A Y.Doc pos is null — object was deleted or not found')
      } else if (bYDocFinal === null) {
        console.log('[P14d] [Diagnosis] B Y.Doc pos is null — object not synced to B at all')
      }

      // ------------------------------------------------------------------
      // Save diagnostic transcript
      // ------------------------------------------------------------------
      console.log('\n=== Context A console transcript ===')
      for (const entry of logA) {
        console.log(`  [A] ${entry.text}`)
      }
      console.log('\n=== Context B console transcript ===')
      for (const entry of logB) {
        console.log(`  [B] ${entry.text}`)
      }

      const transcript = {
        deckId: DECK_ID,
        slide2Id,
        rectId,
        posBeforeDrag,
        bPosBefore,
        aYDocFinal,
        bYDocFinal,
        aSGFinal,
        bSGFinal,
        aMoved,
        logA,
        logB,
      }
      fs.mkdirSync(RESULTS_DIR, { recursive: true })
      fs.writeFileSync(
        path.join(RESULTS_DIR, 'console-transcript.json'),
        JSON.stringify(transcript, null, 2),
      )

      // ------------------------------------------------------------------
      // Assertions — the test should PASS once the bug is fixed
      // ------------------------------------------------------------------

      // A must have moved the object (otherwise the test setup is wrong)
      expect(aMoved, 'A must have dragged the rect (hit-test sanity check)').toBe(true)

      // B must still have the rect in Y.Doc
      expect(bYDocFinal, '[Y.Doc] B must have the rect on slide 2').not.toBeNull()

      if (aYDocFinal !== null && bYDocFinal !== null) {
        const ydocDelta =
          Math.abs(aYDocFinal.x - bYDocFinal.x) + Math.abs(aYDocFinal.y - bYDocFinal.y)
        expect(
          ydocDelta,
          `[Y.Doc] A and B must agree on final position. A=${JSON.stringify(aYDocFinal)}, B=${JSON.stringify(bYDocFinal)}`,
        ).toBeLessThan(20)
      }

      // B's SceneGraph must also be at the new position
      expect(bSGFinal, '[SceneGraph] B Pixi must have rect mounted').not.toBeNull()

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
