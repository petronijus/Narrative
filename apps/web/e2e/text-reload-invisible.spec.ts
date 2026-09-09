/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
/**
 * Diagnostic spec: text object invisible after hard reload (p15-richtext-ytext).
 *
 * Reproduces the user's exact flow:
 *   1. Open a fresh deck.
 *   2. Click the toolbar "T" button (Text tool).
 *   3. Click in the middle of the canvas to drop a default text box.
 *   4. Confirm "Text" is visible (coloured pixels).
 *   5. Hard-reload.
 *   6. Wait for the scene graph to mount the text node.
 *   7. Sample pixels — is the text invisible?
 *   8. Dump all console messages + page errors.
 *   9. Introspect the live Pixi HTMLText node (text, style, position, visibility,
 *      mask) and the Y.Doc content.
 *
 * Not a pass/fail regression test — purely diagnostic. All introspection
 * is logged so the parent can pinpoint the broken layer.
 */

import { test, type Page } from '@playwright/test'
import * as path from 'path'

/**
 * The flow needs nothing but an empty deck, so make one. It used to open a
 * hard-coded id that existed in one developer's database; everywhere else the
 * page 403s and the spec dies waiting for the test API.
 */
async function createDeck(page: Page): Promise<string> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'text-reload-invisible' },
  })
  const { id } = (await res.json()) as { id: string }
  return `/deck/${id}`
}

// ─── pixel sampler ──────────────────────────────────────────────────────────

/** Count "meaningful" coloured pixels in a region of the main <canvas>. */
async function countColoredPixels(
  page: Page,
  region: { x: number; y: number; w: number; h: number },
): Promise<number> {
  return page.evaluate(({ x, y, w, h }) => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas) return -1
    const tmp = document.createElement('canvas')
    tmp.width = w
    tmp.height = h
    const ctx = tmp.getContext('2d')
    if (!ctx) return -2
    ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data
    let count = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      const a = data[i + 3]!
      if (a < 200) continue
      // Skip near-white (canvas background)
      if (r > 230 && g > 230 && b > 230) continue
      // Skip near-black (outlines etc can be ok, but let's count everything
      // non-white/non-transparent)
      const spread = Math.max(r, g, b) - Math.min(r, g, b)
      if (spread > 10 || r < 200 || g < 200 || b < 200) count++
    }
    return count
  }, region)
}

// ─── Pixi node introspection ─────────────────────────────────────────────────

interface PixiDiag {
  found: boolean
  textContent?: string
  htmlText?: string
  fontSize?: number
  fill?: unknown
  fontFamily?: unknown
  localX?: number
  localY?: number
  alpha?: number
  visible?: boolean
  containerAlpha?: number
  containerVisible?: boolean
  containerX?: number
  containerY?: number
  containerPivotX?: number
  containerPivotY?: number
  maskPresent?: boolean
  maskRect?: { x: number; y: number; w: number; h: number } | null
  worldTransform?: { a: number; b: number; c: number; d: number; tx: number; ty: number }
  error?: string
}

async function introspectPixiText(page: Page, objectId: string): Promise<PixiDiag> {
  return page.evaluate((id) => {
    try {
      const sg = (window as any).__narrative_scene_graph
      if (!sg) return { found: false, error: '__narrative_scene_graph not found' }

      const container = sg.getContainer(id)
      if (!container) return { found: false, error: `getContainer(${id}) returned undefined` }

      // The text node is the first child that has an `anchor` property.
      const textNode = container.children?.find((c: any) => c.anchor !== undefined) as any
      if (!textNode) return { found: true, error: 'No HTMLText child with .anchor found' }

      const style = textNode.style ?? {}
      const mask = container.mask as any

      let maskRect: { x: number; y: number; w: number; h: number } | null = null
      if (mask && typeof mask._geometry !== 'undefined') {
        // Pixi Graphics: geometry bounds
        try {
          const b = mask.getBounds()
          maskRect = { x: b.x, y: b.y, w: b.width, h: b.height }
        } catch {
          maskRect = null
        }
      }

      const wt = container.worldTransform
      return {
        found: true,
        textContent: textNode.text,
        htmlText: typeof textNode._htmlText === 'string' ? textNode._htmlText : undefined,
        fontSize: style.fontSize,
        fill: style.fill,
        fontFamily: style.fontFamily,
        localX: textNode.x,
        localY: textNode.y,
        alpha: textNode.alpha,
        visible: textNode.visible,
        containerAlpha: container.alpha,
        containerVisible: container.visible,
        containerX: container.x,
        containerY: container.y,
        containerPivotX: container.pivot?.x,
        containerPivotY: container.pivot?.y,
        maskPresent: mask !== null && mask !== undefined,
        maskRect,
        worldTransform: wt
          ? { a: wt.a, b: wt.b, c: wt.c, d: wt.d, tx: wt.tx, ty: wt.ty }
          : undefined,
      }
    } catch (e: any) {
      return { found: false, error: String(e) }
    }
  }, objectId)
}

// ─── Y.Doc introspection ─────────────────────────────────────────────────────

interface YDocDiag {
  plainText?: string
  fields?: Record<string, unknown>
  error?: string
}

async function introspectYDoc(page: Page, objectId: string): Promise<YDocDiag> {
  return page.evaluate((id) => {
    try {
      const api = (window as any).__narrative_test_api
      if (!api) return { error: '__narrative_test_api not found' }
      const obj = api.getObject(id)
      if (!obj) return { error: `getObject(${id}) returned null` }
      // text field may be a Y.Text — serialize it
      let plainText: string | undefined
      const textField = obj['text']
      if (textField && typeof textField.toString === 'function') {
        plainText = textField.toString()
      } else if (typeof textField === 'string') {
        plainText = textField
      }
      return { plainText, fields: obj }
    } catch (e: any) {
      return { error: String(e) }
    }
  }, objectId)
}

// ─── Wait helpers ────────────────────────────────────────────────────────────

async function waitForTestApi(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__narrative_test_api !== undefined, null, {
    timeout: 20_000,
  })
}

async function waitForSceneGraphNode(page: Page, objectId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const api = (window as any).__narrative_test_api
      return api !== undefined && api.sceneGraphHasMountedNode(id)
    },
    objectId,
    { timeout: 15_000 },
  )
}

// ─── Main test ───────────────────────────────────────────────────────────────

test('p15 text-reload-invisible: diagnose invisible text after hard reload', async ({ page }) => {
  test.setTimeout(90_000)

  const consoleMessages: string[] = []
  const pageErrors: string[] = []

  page.on('console', (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`
    consoleMessages.push(text)
  })
  page.on('pageerror', (err) => {
    pageErrors.push(err.message)
  })

  await page.setViewportSize({ width: 1920, height: 1080 })

  // ── 1. Open the deck ───────────────────────────────────────────────────────
  console.log('=== Step 1: Open deck ===')
  await page.goto(await createDeck(page))
  await waitForTestApi(page)
  // Extra wait for Pixi and Hocuspocus to settle
  await page.waitForTimeout(2000)

  // Get canvas bounding box
  const canvasRect = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    if (!canvas) return null
    const r = canvas.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
  console.log('Canvas rect:', JSON.stringify(canvasRect))
  if (!canvasRect) throw new Error('No <canvas> found on page')

  // ── 2. Click the Text tool button ─────────────────────────────────────────
  console.log('=== Step 2: Click Text tool button ===')
  await page.getByRole('button', { name: /Text \(T\)/i }).click()
  await page.waitForTimeout(300)

  // ── 3. Click in the centre of the canvas to drop a default text box ───────
  console.log('=== Step 3: Click canvas centre to drop text box ===')
  const cx = canvasRect.left + canvasRect.width / 2
  const cy = canvasRect.top + canvasRect.height / 2
  await page.mouse.click(cx, cy)
  // The text tool drops the object; give the reconciler time to mount it.
  await page.waitForTimeout(1500)

  // Find the newly created text object id via testApi
  const objectId = await page.evaluate(() => {
    const api = (window as any).__narrative_test_api
    if (!api) return null
    const slideId = api.listSlideIds()[0]
    const objs = api.debugObjectTypes(slideId)
    const textObj = objs.find((o: any) => o.type === 'text')
    return textObj?.id ?? null
  })
  console.log('Text object id:', objectId)
  if (!objectId) throw new Error('No text object found after toolbar click')

  // Wait for scene graph to mount it
  await waitForSceneGraphNode(page, objectId)
  console.log('Scene graph has mounted the node.')

  // ── 4. Measure pixels BEFORE reload ──────────────────────────────────────
  // Sample region around canvas centre (where the text box was placed)
  const sampleRegion = {
    x: Math.floor(canvasRect.width / 2 - 200),
    y: Math.floor(canvasRect.height / 2 - 100),
    w: 400,
    h: 200,
  }
  const pixelsBefore = await countColoredPixels(page, sampleRegion)
  console.log(`Coloured pixels BEFORE reload: ${pixelsBefore}`)

  // ── 5. Screenshot BEFORE reload ───────────────────────────────────────────
  await page.screenshot({ path: '/tmp/p15-reload-bug-1-after-add.png', fullPage: false })
  console.log('Screenshot saved: /tmp/p15-reload-bug-1-after-add.png')

  // Introspect Pixi + Y.Doc BEFORE reload
  const pixiBefore = await introspectPixiText(page, objectId)
  const ydocBefore = await introspectYDoc(page, objectId)
  console.log('Pixi BEFORE reload:', JSON.stringify(pixiBefore, null, 2))
  console.log('YDoc BEFORE reload:', JSON.stringify(ydocBefore, null, 2))

  // Clear log buffers for the reload phase
  consoleMessages.length = 0
  pageErrors.length = 0

  // ── 6. Hard reload ────────────────────────────────────────────────────────
  console.log('=== Step 6: Hard reload ===')
  await page.reload({ waitUntil: 'networkidle' })
  await waitForTestApi(page)
  await page.waitForTimeout(2000) // let Pixi + font + Y.Doc settle

  // Re-confirm the object is still in the slide
  const objectStillExists = await page.evaluate((id) => {
    const api = (window as any).__narrative_test_api
    if (!api) return false
    const slideId = api.listSlideIds()[0]
    const objs = api.debugObjectTypes(slideId)
    return objs.some((o: any) => o.id === id)
  }, objectId)
  console.log(`Object ${objectId} still in Y.Doc after reload:`, objectStillExists)

  // Wait for scene graph to mount
  try {
    await waitForSceneGraphNode(page, objectId)
    console.log('Scene graph mounted node after reload.')
  } catch {
    console.log('WARNING: scene graph did NOT mount node within timeout after reload.')
  }

  // Extra settle after mount
  await page.waitForTimeout(1000)

  // ── 7. Screenshot AFTER reload ────────────────────────────────────────────
  await page.screenshot({ path: '/tmp/p15-reload-bug-2-after-reload.png', fullPage: false })
  console.log('Screenshot saved: /tmp/p15-reload-bug-2-after-reload.png')

  // ── 8. Measure pixels AFTER reload ───────────────────────────────────────
  // Re-derive canvas rect (layout identical after reload)
  const canvasRectAfter = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    if (!canvas) return null
    const r = canvas.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
  console.log('Canvas rect after reload:', JSON.stringify(canvasRectAfter))

  const pixelsAfter = await countColoredPixels(page, sampleRegion)
  console.log(`Coloured pixels AFTER reload: ${pixelsAfter}`)
  console.log(
    `Pixel delta: ${pixelsAfter - pixelsBefore} (negative = text disappeared, positive = appeared)`,
  )

  // ── 9. Introspect Pixi node AFTER reload ──────────────────────────────────
  const pixiAfter = await introspectPixiText(page, objectId)
  const ydocAfter = await introspectYDoc(page, objectId)
  console.log('Pixi AFTER reload:', JSON.stringify(pixiAfter, null, 2))
  console.log('YDoc AFTER reload:', JSON.stringify(ydocAfter, null, 2))

  // ── 10. Console log summary ───────────────────────────────────────────────
  console.log('=== CONSOLE MESSAGES (post-reload) ===')
  for (const m of consoleMessages) {
    console.log(m)
  }
  console.log('=== PAGE ERRORS (post-reload) ===')
  for (const e of pageErrors) {
    console.log(e)
  }

  // ── Diagnostic summary ────────────────────────────────────────────────────
  console.log('\n======== DIAGNOSTIC SUMMARY ========')
  console.log(`Text object id: ${objectId}`)
  console.log(`Pixels before reload: ${pixelsBefore}`)
  console.log(`Pixels after reload:  ${pixelsAfter}`)
  console.log(`Object in Y.Doc after reload: ${objectStillExists}`)
  console.log(`Pixi node found after reload: ${pixiAfter.found}`)
  console.log(`Pixi textContent: ${JSON.stringify(pixiAfter.textContent)}`)
  console.log(`Pixi fill: ${JSON.stringify(pixiAfter.fill)}`)
  console.log(`Pixi alpha: ${pixiAfter.alpha}  visible: ${pixiAfter.visible}`)
  console.log(
    `Container alpha: ${pixiAfter.containerAlpha}  visible: ${pixiAfter.containerVisible}`,
  )
  console.log(`Container x/y: ${pixiAfter.containerX}, ${pixiAfter.containerY}`)
  console.log(`Container pivot: ${pixiAfter.containerPivotX}, ${pixiAfter.containerPivotY}`)
  console.log(
    `Mask present: ${pixiAfter.maskPresent}  maskRect: ${JSON.stringify(pixiAfter.maskRect)}`,
  )
  console.log(`World transform: ${JSON.stringify(pixiAfter.worldTransform)}`)
  console.log(`Y.Doc plainText: ${JSON.stringify(ydocAfter.plainText)}`)
  console.log(`Pixi error: ${pixiAfter.error ?? 'none'}`)
  console.log('====================================')

  // This test intentionally never throws — it's diagnostic.
  // The spec "passes" so we can read the full output.
  // (Remove this comment and add expect() calls once the bug is confirmed.)
})
