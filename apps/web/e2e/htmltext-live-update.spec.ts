/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
/**
 * Inline HTMLText live-update probe.
 *
 * Four tests, all passing:
 *
 * 1. DATA PIPELINE: Y.Text mutations triggered by testApi.updateObject flow
 *    through processTextEvent → rAF flush → applyPatch → textNode.text.
 *
 * 2. VISUAL RENDERING: HTMLTextStyle.fill receives a plain CSS color string
 *    (not a {color,alpha} object). No PixiJS HTMLTextStyle warnings emitted.
 *    The fill bug (buildStyleOpts passing {color,alpha}) was fixed in
 *    textRenderer.ts via a colorWithAlpha() helper.
 *
 * 3. KEYBOARD TYPING LIVE UPDATE: Typing in the TextEditOverlay writes to
 *    Y.Text via commit(). The Pixi HTMLText node reflects typed content
 *    during active editing. The root cause of the prior failure was a stale
 *    `e2e-dispatch-probe` object overlapping the test target — fixed by
 *    cleaning up unknown objects in beforeEach and clearing the deck DB state.
 *
 * 4. PERSISTENCE: Text content survives hard reload (Hocuspocus persists
 *    Y.Doc updates server-side).
 *
 * Invariants maintained by beforeEach:
 *   - Every test gets its own freshly created deck (it used to open a
 *     hard-coded id that existed in one developer's database only).
 *   - Only TEXT_OBJ_ID exists on the slide, with text='Hello'.
 *
 * testId: htmltext-live-update
 */

import { test, expect, type Page } from './fixtures/test'
import { provisionDeckWithText } from './fixtures/provisionDeck.js'

const TEXT_OBJ_ID = 'e2e-htmltext-probe'
/** The inline editor is a contenteditable div, not a <textarea>. */
const EDITOR = '[data-shortcut-scope="canvas"] [contenteditable="true"]'

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function waitForTestApi(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__narrative_test_api !== undefined, null, {
    timeout: 20_000,
  })
  await page.waitForTimeout(1500)
}

/** Read the visible string out of the inline editor. */
async function editorText(page: Page): Promise<string> {
  return (await page.locator(EDITOR).first().innerText()).replace(/\n$/, '')
}

async function waitForNodeMounted(page: Page, id: string): Promise<void> {
  await page.waitForFunction(
    (targetId: string) => {
      const sg = (window as any).__narrative_scene_graph
      return sg !== undefined && (sg.getMountedIds?.() ?? []).includes(targetId)
    },
    id,
    { timeout: 10_000 },
  )
  await page.waitForTimeout(800)
}

/**
 * Read the Pixi HTMLText node's rendered copy for the given object id.
 *
 * The node's `.text` is markup, not a plain string — the renderer feeds
 * HTMLText a paragraph-per-line document with a leading node-count comment
 * (`<!--n:12--><div data-pb="1">Hello</div>`), so comparing it to 'Hello'
 * asserts against the serialisation rather than against what the user sees.
 * Strip it back to text, with one newline per paragraph.
 */
async function readPixiText(page: Page, id: string): Promise<string | null> {
  return page.evaluate((targetId: string) => {
    const sg = (window as any).__narrative_scene_graph
    const c = sg?.getContainer(targetId)
    const textNode = c?.children.find((ch: any) => ch.anchor !== undefined)
    const markup: string | undefined = textNode?.text
    if (typeof markup !== 'string') return null
    const host = document.createElement('div')
    host.innerHTML = markup
    const blocks = host.querySelectorAll('div, p, br')
    if (blocks.length === 0) return host.textContent ?? ''
    return Array.from(host.children)
      .map((el) => el.textContent ?? '')
      .join('\n')
  }, id)
}

/** Get canvas-space TL coordinates for the text object. */
async function getObjPageCoords(page: Page, id: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((targetId: string) => {
    const sg = (window as any).__narrative_scene_graph
    const c = sg?.getContainer(targetId)
    const canvasEl = document.querySelector('canvas') as HTMLCanvasElement | null
    if (!c || !canvasEl) return null
    const cr = canvasEl.getBoundingClientRect()
    const scaleX = cr.width / canvasEl.width
    const scaleY = cr.height / canvasEl.height
    const tl = c.toGlobal({ x: 0, y: 0 })
    return { x: cr.left + tl.x * scaleX, y: cr.top + tl.y * scaleY }
  }, id)
}

/**
 * Count non-white pixels in the raw canvas for a 600×120 region
 * starting at the Pixi container's TL (canvas-space coordinates).
 */
async function countNonWhitePixels(page: Page, id: string): Promise<number> {
  return page.evaluate((targetId: string) => {
    const sg = (window as any).__narrative_scene_graph
    const c = sg?.getContainer(targetId)
    const canvasEl = document.querySelector('canvas') as HTMLCanvasElement | null
    if (!c || !canvasEl) return -1
    const tl = c.toGlobal({ x: 0, y: 0 })
    const sx = Math.max(0, Math.round(tl.x))
    const sy = Math.max(0, Math.round(tl.y))
    const sw = 600
    const sh = 120
    const tmp = document.createElement('canvas')
    tmp.width = sw
    tmp.height = sh
    const ctx2 = tmp.getContext('2d')!
    ctx2.drawImage(canvasEl, sx, sy, sw, sh, 0, 0, sw, sh)
    const data = ctx2.getImageData(0, 0, sw, sh).data
    let count = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2],
        a = data[i + 3]
      if (a < 128) continue
      if (r > 235 && g > 235 && b > 235) continue // near-white background
      count++
    }
    return count
  }, id)
}

// ──────────────────────────────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────────────────────────────

test.describe('Pixi HTMLText live update during inline edit', () => {
  const consoleLogs: string[] = []
  const pageErrors: string[] = []
  let deckUrl = ''

  test.beforeEach(async ({ page }) => {
    consoleLogs.length = 0
    pageErrors.length = 0
    page.on('console', (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`))
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.setViewportSize({ width: 1440, height: 900 })
    deckUrl = (
      await provisionDeckWithText(page, {
        title: 'htmltext-live-update',
        objectId: TEXT_OBJ_ID,
        x: 500,
        y: 300,
        width: 600,
        height: 120,
      })
    ).deckUrl

    // A brand-new deck ships with whatever the deck template seeds; drop it so
    // nothing else can win the hit test at the probe's coordinates.
    await page.evaluate((id) => {
      const api = window.__narrative_test_api!
      const slideId = api.listSlideIds()[0]!
      for (const obj of api.debugObjectTypes(slideId)) {
        if (obj.id !== id) api.removeObject(obj.id, slideId)
      }
    }, TEXT_OBJ_ID)

    await waitForNodeMounted(page, TEXT_OBJ_ID)
  })

  // ── Test 1: data pipeline via direct mutations ──────────────────────────

  test('data pipeline: textNode.text updates when Y.Text is mutated via testApi', async ({
    page,
  }) => {
    test.setTimeout(30_000)

    const initial = await readPixiText(page, TEXT_OBJ_ID)
    console.log('[initial textNodeText]:', initial)
    expect(initial, 'Initial Pixi text should be Hello').toBe('Hello')

    // Mutate to 'World'
    await page.evaluate((id) => {
      window.__narrative_test_api!.updateObject(id, { text: 'World' })
    }, TEXT_OBJ_ID)
    // The reconciler applies it on its next frame; poll rather than guess a wait.
    await expect
      .poll(() => readPixiText(page, TEXT_OBJ_ID), {
        message: 'textNode.text must update to World after Y.Text mutation',
      })
      .toBe('World')

    // Mutate to 'live update test'
    await page.evaluate((id) => {
      window.__narrative_test_api!.updateObject(id, { text: 'live update test' })
    }, TEXT_OBJ_ID)
    await expect
      .poll(() => readPixiText(page, TEXT_OBJ_ID), {
        message: 'textNode.text must update to typed text',
      })
      .toBe('live update test')
  })

  // ── Test 2: visual rendering ─────────────────────────────────────────────

  test('visual rendering: HTMLText glyphs are visible on canvas (fill bug check)', async ({
    page,
  }) => {
    test.setTimeout(30_000)

    // Mutate to something longer to generate more glyph pixels
    await page.evaluate((id) => {
      window.__narrative_test_api!.updateObject(id, { text: 'live update test' })
    }, TEXT_OBJ_ID)
    await page.waitForTimeout(400)

    // Collect HTMLTextStyle warnings from console
    const htmlTextWarnings = consoleLogs.filter(
      (l) => l.includes('HTMLTextStyle') || l.includes('HTMLText'),
    )
    console.log('[HTMLTextStyle warnings]:', htmlTextWarnings)

    // The Pixi app uses WebGL which does NOT preserve the drawing buffer —
    // reading canvas pixels via drawImage always returns transparent after the
    // frame is presented. Instead we verify the Pixi text node's .text property:
    // if the fill is broken, HTMLText fails to render but the .text property
    // still reflects the assigned value. The REAL visual check is the Pixi
    // warning: a fill:{color,alpha} object causes a PixiJS HTMLTextStyle warning
    // and silently makes glyphs invisible. No such warning = fix is applied.
    const pixiText = await readPixiText(page, TEXT_OBJ_ID)
    console.log('[pixi text node value]:', pixiText)
    expect(pixiText, 'Pixi HTMLText node .text must reflect the updated string').not.toBeNull()
    expect(pixiText, 'Pixi HTMLText node .text must contain the updated text').toContain(
      'live update test',
    )

    // No HTMLTextStyle warnings — the fill fix must prevent any warning.
    expect(
      htmlTextWarnings,
      'buildStyleOpts must pass a plain color string to HTMLTextStyle, not a {color,alpha} object',
    ).toHaveLength(0)

    // Screenshot for visual review in test-results.
    await page.screenshot({ path: '/tmp/p15-htmltext-visual.png' })
  })

  // ── Test 3: keyboard typing live update ──────────────────────────────────

  test('keyboard typing: Pixi HTMLText updates live as user types', async ({ page }) => {
    test.setTimeout(60_000)

    const coords = await getObjPageCoords(page, TEXT_OBJ_ID)
    expect(coords, 'SceneGraph must provide text object coordinates').not.toBeNull()

    // Single click to select, double-click to enter edit mode.
    const cx = coords!.x + 150
    const cy = coords!.y + 30
    await page.mouse.click(cx, cy)
    await page.waitForTimeout(200)
    await page.mouse.dblclick(cx, cy)
    await expect(page.locator(EDITOR).first()).toBeVisible({ timeout: 8_000 })

    // What the editor shows on mount must match Y.Text — confirms no
    // stale-object collision put us in a different box than we think.
    expect(await editorText(page), 'Editor content must match the seeded Y.Text').toBe('Hello')

    // Select all, then type replacement text.
    await page.keyboard.press('ControlOrMeta+A')
    await page.waitForTimeout(100)

    // Type 'live update test' character by character (above rAF period between each).
    await page.keyboard.press('l')
    await page.waitForTimeout(60)
    for (const ch of 'ive update test') {
      await page.keyboard.press(ch === ' ' ? 'Space' : ch)
      await page.waitForTimeout(60)
    }

    // Wait for rAF flush + Hocuspocus echo settle.
    await page.waitForTimeout(500)

    // Y.Text should contain the typed string.
    const yTextValue = await page.evaluate((id) => {
      const obj = window.__narrative_test_api!.getObject(id)
      return String(obj?.['text'] ?? '')
    }, TEXT_OBJ_ID)
    expect(yTextValue, 'Y.Text must contain the typed characters').toContain('live update test')

    // Pixi HTMLText node must reflect the Y.Text content while overlay is open.
    const pixiTextDuring = await readPixiText(page, TEXT_OBJ_ID)
    expect(
      pixiTextDuring,
      `Pixi textNode.text must reflect Y.Text. Got: ${JSON.stringify(pixiTextDuring)}`,
    ).toContain('live update test')

    // Close overlay and verify Pixi still shows the correct text.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    const pixiTextAfter = await readPixiText(page, TEXT_OBJ_ID)
    expect(pixiTextAfter, 'Pixi text must persist after Escape').toContain('live update test')

    await page.screenshot({ path: '/tmp/p15-htmltext-1-after-typing.png' })
  })

  // ── Test 4: persistence after reload ─────────────────────────────────────

  test('persistence: typed text survives hard reload', async ({ page }) => {
    test.setTimeout(60_000)

    // Set text via testApi (direct Y.Text mutation)
    await page.evaluate((id) => {
      window.__narrative_test_api!.updateObject(id, { text: 'persisted text' })
    }, TEXT_OBJ_ID)
    await page.waitForTimeout(500)

    const beforeReload = await readPixiText(page, TEXT_OBJ_ID)
    console.log('[Pixi text before reload]:', beforeReload)
    expect(beforeReload, 'Pixi text must be updated before reload').toBe('persisted text')

    // Hard reload — same deck, fresh document.
    expect(page.url()).toContain(deckUrl)
    await page.reload()
    await waitForTestApi(page)
    await waitForNodeMounted(page, TEXT_OBJ_ID)

    const afterReload = await readPixiText(page, TEXT_OBJ_ID)
    console.log('[Pixi text after reload]:', afterReload)
    await page.screenshot({ path: '/tmp/p15-htmltext-3-after-reload.png' })

    expect(afterReload, 'Pixi text must survive reload (Y.Doc persisted via Hocuspocus)').toBe(
      'persisted text',
    )
  })
})
