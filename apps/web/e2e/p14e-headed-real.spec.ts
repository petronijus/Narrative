/**
 * e2e/p14e-headed-real.spec.ts
 *
 * Reproduces the sync bug under HEADED Chrome (GPU compositor, real rAF 60Hz).
 * Uses the real user deck rFrM1biNm7Yn — do NOT recreate it.
 *
 * Steps:
 *   1. Context A + Context B both open /deck/rFrM1biNm7Yn
 *   2. Both click slide 2
 *   3. A: rectangle tool → draw on slide 2
 *   4. Confirm B sees the rectangle via Y.Doc
 *   5. A: select → drag the rectangle
 *   6. Read Y.Doc + SceneGraph state on both sides
 *   7. Compare: diagnose where the sync breaks
 *
 * Instrumentation: console.debug in EditorLayout, slideObserve, Canvas reconciler
 * is injected at source level (reverted after the run).
 *
 * Run headed:
 *   npx playwright test e2e/p14e-headed-real.spec.ts --headed --project=chromium --timeout=120000
 *
 * Artifacts saved to: apps/web/test-results/p14e-headed-real/
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const RESULTS_DIR = path.resolve(__dirname, '../test-results/p14e-headed-real')
const DECK_URL = '/deck/rFrM1biNm7Yn'

// ---------------------------------------------------------------------------
// Console capture
// ---------------------------------------------------------------------------

interface ConsoleRecord {
  type: string
  text: string
  ts: number
}

// Filters we care about
const CAPTURE_PATTERNS = [
  '[drag.start]',
  '[drag.write]',
  '[slideObserve.',
  '[Canvas.applyChanges]',
  '[dragLock',
]

function shouldCapture(text: string, type: string): boolean {
  if (type === 'error' || type === 'pageerror') return true
  return CAPTURE_PATTERNS.some((p) => text.includes(p))
}

// ---------------------------------------------------------------------------
// Browser context factory
// ---------------------------------------------------------------------------

async function openDeck(
  ctx: BrowserContext,
  label: string,
): Promise<{ page: Page; consoleLog: ConsoleRecord[] }> {
  const page = await ctx.newPage()
  const consoleLog: ConsoleRecord[] = []

  page.on('pageerror', (e) => {
    const entry: ConsoleRecord = { type: 'pageerror', text: e.message, ts: Date.now() }
    consoleLog.push(entry)
    console.log(`[${label} pageerror] ${e.message}`)
  })

  page.on('console', (msg) => {
    const text = msg.text()
    const type = msg.type()
    if (shouldCapture(text, type)) {
      const entry: ConsoleRecord = { type, text, ts: Date.now() }
      consoleLog.push(entry)
      console.log(`[${label} ${type}] ${text}`)
    }
  })

  await page.goto(DECK_URL)
  await page.waitForFunction(
    () =>
      (window as unknown as { __narrative_test_api?: unknown }).__narrative_test_api !== undefined,
    null,
    { timeout: 30_000 },
  )
  // Give React + Pixi time to fully settle (WebSocket connect + initial Y.Doc hydration)
  await page.waitForTimeout(2000)
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
): { x: number; y: number } {
  const scale = rect.width / slideWidth
  return {
    x: rect.x + slideX * scale,
    y: rect.y + slideY * scale,
  }
}

function clamp(
  pt: { x: number; y: number },
  vp: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.max(2, Math.min(pt.x, vp.width - 2)),
    y: Math.max(2, Math.min(pt.y, vp.height - 2)),
  }
}

// ---------------------------------------------------------------------------
// Click slide 2 in the SlidesPanel
// ---------------------------------------------------------------------------

async function clickSlide(page: Page, slideId: string): Promise<void> {
  // SlidesPanel renders each slide as a row with data-slide-id
  const loc = page.locator(`[data-slide-id="${slideId}"]`).first()
  await loc.waitFor({ state: 'visible', timeout: 10_000 })
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
// Draw rectangle on canvas
// ---------------------------------------------------------------------------

async function drawRect(
  page: Page,
  s1x: number,
  s1y: number,
  s2x: number,
  s2y: number,
): Promise<void> {
  // First press 'r' to activate rectangle tool
  await page.keyboard.press('r')
  await page.waitForTimeout(200)

  const raw = await getRawArtboardRect(page)
  const vp = page.viewportSize() ?? { width: 1280, height: 720 }
  const from = clamp(slideToViewport(s1x, s1y, raw), vp)
  const to = clamp(slideToViewport(s2x, s2y, raw), vp)

  console.log(
    `[P14e drawRect] raw artboard: x=${raw.x.toFixed(0)} y=${raw.y.toFixed(0)} w=${raw.width.toFixed(0)} h=${raw.height.toFixed(0)}`,
  )
  console.log(
    `[P14e drawRect] viewport: from=(${from.x.toFixed(0)},${from.y.toFixed(0)}) to=(${to.x.toFixed(0)},${to.y.toFixed(0)})`,
  )

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  const STEPS = 10
  for (let i = 1; i <= STEPS; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / STEPS,
      from.y + ((to.y - from.y) * i) / STEPS,
    )
    await page.waitForTimeout(20)
  }
  await page.mouse.up()
  // Switch back to select tool
  await page.keyboard.press('v')
  await page.waitForTimeout(500)
}

// ---------------------------------------------------------------------------
// Drag object on canvas
// ---------------------------------------------------------------------------

async function dragObject(
  page: Page,
  fromSX: number,
  fromSY: number,
  toSX: number,
  toSY: number,
): Promise<void> {
  const raw = await getRawArtboardRect(page)
  const vp = page.viewportSize() ?? { width: 1280, height: 720 }
  const from = clamp(slideToViewport(fromSX, fromSY, raw), vp)
  const to = clamp(slideToViewport(toSX, toSY, raw), vp)

  console.log(
    `[P14e dragObject] from=(${from.x.toFixed(0)},${from.y.toFixed(0)}) to=(${to.x.toFixed(0)},${to.y.toFixed(0)})`,
  )

  await page.mouse.move(from.x, from.y)
  await page.waitForTimeout(60)
  await page.mouse.down()
  await page.waitForTimeout(100) // let handlePointerDown fire + lock

  const STEPS = 15
  for (let i = 1; i <= STEPS; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / STEPS,
      from.y + ((to.y - from.y) * i) / STEPS,
    )
    await page.waitForTimeout(20)
  }
  await page.mouse.up()
  await page.waitForTimeout(600)
}

// ---------------------------------------------------------------------------
// Test API wrappers
// ---------------------------------------------------------------------------

async function listSlideIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__narrative_test_api!.listSlideIds())
}

async function objectIds(page: Page, slideId: string): Promise<string[]> {
  return page.evaluate((sid) => window.__narrative_test_api!.objectIds(sid), slideId)
}

async function getYDocPosition(
  page: Page,
  objectId: string,
  slideId: string,
): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    ({ oid, sid }) => window.__narrative_test_api!.getObjectPositionFromYDoc(oid, sid),
    { oid: objectId, sid: slideId },
  )
}

async function getSceneGraphNodeData(
  page: Page,
  objectId: string,
): Promise<{ x: number; y: number } | null> {
  return page.evaluate((oid) => {
    const sg = (
      window as unknown as {
        __narrative_scene_graph?: {
          getNode?: (id: string) => { data?: { x?: number; y?: number } } | undefined
          getBounds?: (id: string) => { world: { x: number; y: number } } | null
        }
      }
    ).__narrative_scene_graph
    if (!sg) return null
    // Try getNode first (Pixi side data)
    if (sg.getNode) {
      const node = sg.getNode(oid)
      if (node?.data !== undefined) {
        return { x: node.data.x ?? 0, y: node.data.y ?? 0 }
      }
    }
    // Fallback to getBounds
    if (sg.getBounds) {
      const b = sg.getBounds(oid)
      return b ? { x: b.world.x, y: b.world.y } : null
    }
    return null
  }, objectId)
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

async function screenshot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const p = path.join(RESULTS_DIR, `${name}.png`)
  await page.screenshot({ path: p, fullPage: false })
  console.log(`[P14e screenshot] ${p}`)
  return p
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

test.describe('P14e — headed Chrome sync repro on real deck', () => {
  test('B sees A drag on slide 2', async ({ browser }) => {
    test.setTimeout(180_000)
    fs.mkdirSync(RESULTS_DIR, { recursive: true })

    // Open TWO separate browser contexts (separate localStorage + WS connections)
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()

    try {
      // -----------------------------------------------------------------------
      // Step 1: Both open the deck
      // -----------------------------------------------------------------------
      console.log('[P14e] Opening deck in context A...')
      const { page: pageA, consoleLog: logA } = await openDeck(ctxA, 'A')
      console.log('[P14e] Opening deck in context B...')
      const { page: pageB, consoleLog: logB } = await openDeck(ctxB, 'B')

      // -----------------------------------------------------------------------
      // Step 2: Both navigate to slide 2
      // -----------------------------------------------------------------------
      const slidesA = await listSlideIds(pageA)
      const slidesB = await listSlideIds(pageB)
      console.log('[P14e] A slides:', slidesA)
      console.log('[P14e] B slides:', slidesB)
      expect(slidesA.length, 'Deck must have >= 2 slides').toBeGreaterThanOrEqual(2)

      const slide2Id = slidesA[1]!
      console.log('[P14e] slide2Id =', slide2Id)

      await clickSlide(pageA, slide2Id)
      await clickSlide(pageB, slide2Id)

      const aActive = await getActiveSlideId(pageA)
      const bActive = await getActiveSlideId(pageB)
      console.log('[P14e] A activeSlide:', aActive, ' B activeSlide:', bActive)
      expect(aActive).toBe(slide2Id)
      expect(bActive).toBe(slide2Id)

      await screenshot(pageA, '00-slide2-A')
      await screenshot(pageB, '00-slide2-B')

      // -----------------------------------------------------------------------
      // Step 3: A draws a rectangle on slide 2
      // -----------------------------------------------------------------------
      console.log('[P14e] A: drawing rectangle on slide 2...')
      // Clear capture buffers right before the draw
      logA.length = 0
      logB.length = 0

      await drawRect(pageA, 500, 250, 820, 520)
      console.log('[P14e] A: rectangle drawn')

      await screenshot(pageA, '01-after-draw-A')
      await screenshot(pageB, '01-after-draw-B')

      // Wait for rect in A's Y.Doc
      await expect(async () => {
        const ids = await objectIds(pageA, slide2Id)
        expect(ids.length, 'A must have at least 1 object on slide 2').toBeGreaterThan(0)
      }).toPass({ timeout: 8000 })

      // Wait for sync to B (WebSocket propagation)
      await pageB.waitForTimeout(2000)

      const aObjs = await objectIds(pageA, slide2Id)
      const bObjs = await objectIds(pageB, slide2Id)
      console.log('[P14e] A objects on slide2:', aObjs)
      console.log('[P14e] B objects on slide2:', bObjs)

      expect(aObjs.length, 'A must have rect').toBeGreaterThan(0)
      expect(bObjs.length, 'B must see synced rect').toBeGreaterThan(0)

      // -----------------------------------------------------------------------
      // Step 4: Capture state before drag
      // -----------------------------------------------------------------------
      const rectId = aObjs[aObjs.length - 1]!
      console.log('[P14e] rectId =', rectId)

      const aYDocBefore = await getYDocPosition(pageA, rectId, slide2Id)
      const bYDocBefore = await getYDocPosition(pageB, rectId, slide2Id)
      console.log('[P14e] A Y.Doc before drag:', aYDocBefore)
      console.log('[P14e] B Y.Doc before drag:', bYDocBefore)

      // -----------------------------------------------------------------------
      // Step 5: A drags the rectangle
      // -----------------------------------------------------------------------
      // Rect center = start + half-size. start=(500,250), end=(820,520) → w=320,h=270 → center=(660,385)
      const rectCX = aYDocBefore !== null ? aYDocBefore.x + 160 : 660
      const rectCY = aYDocBefore !== null ? aYDocBefore.y + 135 : 385
      const dragTargetX = rectCX + 400
      const dragTargetY = rectCY + 250

      console.log(
        `[P14e] A: dragging rect center=(${rectCX},${rectCY}) → (${dragTargetX},${dragTargetY})`,
      )

      // Clear capture buffers so transcript is clean during the critical drag operation
      logA.length = 0
      logB.length = 0

      await dragObject(pageA, rectCX, rectCY, dragTargetX, dragTargetY)
      console.log('[P14e] A: drag complete')

      // -----------------------------------------------------------------------
      // Step 6: Wait for sync + capture final state
      // -----------------------------------------------------------------------
      await pageA.waitForTimeout(2000)
      await pageB.waitForTimeout(2000)

      await screenshot(pageA, '02-after-drag-A')
      await screenshot(pageB, '02-after-drag-B')

      // -----------------------------------------------------------------------
      // Step 7: Read state from both contexts
      // -----------------------------------------------------------------------
      const aYDocFinal = await getYDocPosition(pageA, rectId, slide2Id)
      const bYDocFinal = await getYDocPosition(pageB, rectId, slide2Id)
      const aSGData = await getSceneGraphNodeData(pageA, rectId)
      const bSGData = await getSceneGraphNodeData(pageB, rectId)

      console.log('\n=== STATE SNAPSHOT ===')
      console.log('[P14e] slide2Id:', slide2Id)
      console.log('[P14e] rectId:', rectId)
      console.log('[P14e] [Y.Doc] A final:', JSON.stringify(aYDocFinal))
      console.log('[P14e] [Y.Doc] B final:', JSON.stringify(bYDocFinal))
      console.log('[P14e] [SceneGraph] A data:', JSON.stringify(aSGData))
      console.log('[P14e] [SceneGraph] B data:', JSON.stringify(bSGData))
      console.log('[P14e] [Y.Doc] A before drag:', JSON.stringify(aYDocBefore))
      console.log('[P14e] [Y.Doc] B before drag:', JSON.stringify(bYDocBefore))

      // -----------------------------------------------------------------------
      // Diagnosis
      // -----------------------------------------------------------------------
      const aMoved =
        aYDocFinal !== null &&
        aYDocBefore !== null &&
        (Math.abs(aYDocFinal.x - aYDocBefore.x) > 50 || Math.abs(aYDocFinal.y - aYDocBefore.y) > 50)

      console.log('\n=== DIAGNOSIS ===')
      console.log('[P14e] A Y.Doc shows rect moved:', aMoved)

      if (!aMoved) {
        console.log(
          '[P14e] WARNING: A did not register a move. Hit-test likely missed. Check screenshots.',
        )
      } else if (bYDocFinal === null) {
        console.log(
          '[P14e] ROOT CAUSE = NETWORK SYNC: B Y.Doc has no rect at all. Object not propagated.',
        )
      } else {
        const ydocDelta =
          Math.abs((aYDocFinal?.x ?? 0) - bYDocFinal.x) +
          Math.abs((aYDocFinal?.y ?? 0) - bYDocFinal.y)
        console.log('[P14e] Y.Doc A-B position delta:', ydocDelta, 'px')

        if (ydocDelta > 50) {
          console.log(
            '[P14e] ROOT CAUSE = NETWORK SYNC: Y.Doc A has new pos but B still has old pos.',
          )
          console.log(
            `[P14e]   A=(${aYDocFinal?.x},${aYDocFinal?.y})  B=(${bYDocFinal.x},${bYDocFinal.y})`,
          )
        } else if (bSGData === null) {
          console.log(
            '[P14e] ROOT CAUSE = RECONCILER: B Y.Doc is correct but Pixi SceneGraph node is missing on B.',
          )
        } else {
          const sgDeltaX = Math.abs((aSGData?.x ?? 0) - bSGData.x)
          const sgDeltaY = Math.abs((aSGData?.y ?? 0) - bSGData.y)
          console.log(`[P14e] SceneGraph A-B delta: x=${sgDeltaX} y=${sgDeltaY}`)
          if (sgDeltaX + sgDeltaY > 50) {
            console.log(
              '[P14e] ROOT CAUSE = OBSERVER/RECONCILER: Y.Doc synced but Pixi SceneGraph on B is stale.',
            )
          } else {
            console.log('[P14e] ALL LAYERS CONVERGED — bug NOT reproduced this run.')
          }
        }
      }

      // -----------------------------------------------------------------------
      // Console transcripts
      // -----------------------------------------------------------------------
      console.log('\n=== Context A console (drag window) ===')
      for (const r of logA) {
        console.log(`  [A ${r.type}] ${r.text}`)
      }
      console.log('\n=== Context B console (drag window) ===')
      for (const r of logB) {
        console.log(`  [B ${r.type}] ${r.text}`)
      }

      // Save full transcript
      const transcript = {
        deckUrl: DECK_URL,
        slide2Id,
        rectId,
        aYDocBefore,
        bYDocBefore,
        aYDocFinal,
        bYDocFinal,
        aSGData,
        bSGData,
        aMoved,
        logA,
        logB,
      }
      fs.writeFileSync(
        path.join(RESULTS_DIR, 'transcript.json'),
        JSON.stringify(transcript, null, 2),
      )

      // -----------------------------------------------------------------------
      // Assertions
      // -----------------------------------------------------------------------
      expect(aMoved, 'A must have moved the rect (hit-test sanity)').toBe(true)
      expect(bYDocFinal, '[Y.Doc] B must still have the rect').not.toBeNull()

      if (aYDocFinal !== null && bYDocFinal !== null) {
        const delta = Math.abs(aYDocFinal.x - bYDocFinal.x) + Math.abs(aYDocFinal.y - bYDocFinal.y)
        expect(
          delta,
          `[Y.Doc sync] A=${JSON.stringify(aYDocFinal)} B=${JSON.stringify(bYDocFinal)}`,
        ).toBeLessThan(20)
      }

      expect(bSGData, '[SceneGraph] B Pixi must have the rect mounted').not.toBeNull()

      if (aSGData !== null && bSGData !== null) {
        const sgDelta = Math.abs(aSGData.x - bSGData.x) + Math.abs(aSGData.y - bSGData.y)
        expect(
          sgDelta,
          `[SceneGraph] A=${JSON.stringify(aSGData)} B=${JSON.stringify(bSGData)}`,
        ).toBeLessThan(20)
      }
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
