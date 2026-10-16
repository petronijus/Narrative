/**
 * list-feature-smoke.spec.ts
 *
 * Real-browser regression guard for the multi-level list feature on TEXT
 * objects. Drives the actual editor: creates a text object, enters the
 * contenteditable overlay, types via the keyboard, exercises the
 * Inspector List controls, and asserts on:
 *   - Y.Text paragraph structure (U+2029 separators).
 *   - WYSIWYG markers shown in the overlay while editing.
 *   - Markers rendered into the Pixi <canvas> after exiting edit
 *     (sampled via getImageData delta vs an empty-slide baseline).
 *   - Caret landing after Enter.
 *   - Backspace at the start of a list item: merge into the previous
 *     paragraph (non-first level-0 item), outdent (nested item), and strip
 *     the list (first item), per the Keynote/PowerPoint progression — plus
 *     the mid-word delete and plain-paragraph backspace-merge regressions.
 */

import { test, expect, type Page } from './fixtures/test'
import { isEngineNoise } from './fixtures/consoleNoise'
import { caret } from './fixtures/keys.js'
import { PNG } from 'pngjs'

const PARA_SEP = ' '

/** Split body on U+2029; drop a trailing empty segment the list model
 * keeps to anchor the last paragraph's block attrs. */
function splitParas(body: string): string[] {
  const parts = body.split(PARA_SEP)
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

interface TestApiShape {
  addText: (
    o: { id: string; x: number; y: number; w: number; h: number; text: string },
    slideId?: string,
  ) => void
  setSelection: (ids: string[]) => void
  getObject: (id: string, slideId?: string) => Record<string, unknown> | null
}

declare global {
  interface Window {
    __narrative_test_api?: TestApiShape
    __narrative_scene_graph?: {
      getContainer: (
        id: string,
      ) => { toGlobal: (p: { x: number; y: number }) => { x: number; y: number } } | undefined
    }
  }
}

async function createDeck(page: Page): Promise<string> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'list-feature-smoke' },
  })
  const { id } = (await res.json()) as { id: string }
  return id
}

async function openDeckReady(page: Page, deckId: string): Promise<void> {
  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 15_000 })
    .toBe('object')
}

/** Screen-space top-left of the object's container, in page coords. */
async function objScreenOrigin(page: Page, id: string): Promise<{ x: number; y: number }> {
  return page.evaluate((targetId) => {
    const sg = window.__narrative_scene_graph
    const c = sg?.getContainer(targetId)
    const canvasEl = document.querySelector('canvas')
    const r = canvasEl?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const g = c?.toGlobal({ x: 0, y: 0 }) ?? { x: 0, y: 0 }
    return { x: g.x + r.left, y: g.y + r.top }
  }, id)
}

/** Double-click into the object to enter the contenteditable overlay. */
async function enterEdit(page: Page, id: string): Promise<void> {
  const origin = await objScreenOrigin(page, id)
  // Click a bit inside the box.
  await page.mouse.dblclick(origin.x + 40, origin.y + 25)
  await expect(
    page.locator('[data-shortcut-scope="canvas"] [contenteditable="true"]').first(),
  ).toBeVisible({ timeout: 5_000 })
}

/** Read the raw Y.Text body string (incl. U+2029 separators). */
async function bodyText(page: Page, id: string): Promise<string> {
  return page.evaluate((targetId) => {
    const o = window.__narrative_test_api?.getObject(targetId)
    return typeof o?.['text'] === 'string' ? (o['text'] as string) : ''
  }, id)
}

/** Markers currently shown in the editing overlay (data-marker spans). */
async function overlayMarkers(page: Page): Promise<string[]> {
  return page
    .locator('[data-shortcut-scope="canvas"] [contenteditable="true"] [data-marker="1"]')
    .allTextContents()
}

/**
 * Place the caret at the very start of paragraph `idx`'s body text — i.e.
 * char offset 0 of the first non-marker text node, immediately after the
 * (non-editable) list marker. This is the deterministic equivalent of a user
 * caret at the head of a list item; note that a bare `Home` keypress in
 * Chromium parks the caret *inside* the leading marker span, which is NOT the
 * paragraph start, so we set the DOM Range explicitly instead.
 */
async function caretToItemStart(page: Page, idx: number): Promise<void> {
  await page.evaluate((i) => {
    const root = document.querySelector('[data-shortcut-scope="canvas"] [contenteditable="true"]')
    if (root === null) return
    const pb = root.querySelectorAll('[data-pb="1"]')[i] as HTMLElement | undefined
    if (pb === undefined) return
    // First text node that is not inside a data-marker span.
    const walker = document.createTreeWalker(pb, NodeFilter.SHOW_TEXT)
    let node: Node | null = walker.nextNode()
    while (node !== null) {
      let inMarker = false
      let p: Node | null = node.parentNode
      while (p !== null && p !== pb) {
        if ((p as HTMLElement).dataset?.['marker'] === '1') {
          inMarker = true
          break
        }
        p = p.parentNode
      }
      if (!inMarker) break
      node = walker.nextNode()
    }
    const sel = window.getSelection()
    const r = document.createRange()
    if (node !== null) {
      r.setStart(node, 0)
    } else {
      // Empty paragraph: caret after the marker, at the block's content end.
      r.setStart(pb, pb.childNodes.length)
    }
    r.collapse(true)
    sel?.removeAllRanges()
    sel?.addRange(r)
  }, idx)
}

/** data-pb paragraph text contents in the overlay (markers stripped). */
async function overlayParagraphs(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-shortcut-scope="canvas"] [contenteditable="true"]')
    if (root === null) return []
    return Array.from(root.querySelectorAll('[data-pb="1"]')).map((pb) => {
      const clone = pb.cloneNode(true) as HTMLElement
      clone.querySelectorAll('[data-marker="1"]').forEach((m) => m.remove())
      return clone.textContent ?? ''
    })
  })
}

/**
 * Count "meaningful" non-white, non-near-black, opaque pixels inside the
 * canvas region covering the object. Used to detect marker glyphs
 * appearing/disappearing in the rendered Pixi output.
 */
async function colouredPixels(
  page: Page,
  box: { x: number; y: number; w: number; h: number },
): Promise<number> {
  // The editor canvas is WebGL2 with a transparent backing buffer and no
  // `preserveDrawingBuffer`, so reading it back via getImageData/toDataURL
  // yields an all-transparent buffer (the visible white is the page bg
  // showing through the compositor). The only reliable way to sample the
  // *rendered* glyphs is a real composited screenshot of the region,
  // decoded in Node with pngjs.
  const clip = {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: Math.max(1, Math.floor(box.w)),
    height: Math.max(1, Math.floor(box.h)),
  }
  const buf = await page.screenshot({ clip })
  const png = PNG.sync.read(buf)
  const data = png.data
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    const rr = data[i]!
    const gg = data[i + 1]!
    const bb = data[i + 2]!
    const aa = data[i + 3]!
    if (aa < 200) continue
    const max = Math.max(rr, gg, bb)
    const min = Math.min(rr, gg, bb)
    const nearWhite = rr > 235 && gg > 235 && bb > 235
    const nearBlack = rr < 20 && gg < 20 && bb < 20
    // Count anything that isn't background white. Glyphs are dark.
    if (!nearWhite && aa > 200 && (max - min > 30 || (!nearBlack && max < 235))) n++
    else if (!nearWhite && aa > 200 && max < 60) n++ // dark glyph pixels
  }
  return n
}

/**
 * Screen rectangle of the marker gutter — the first em of the object. A
 * list paragraph's text starts 1.6 em in, after its marker, and the marker
 * glyph sits at the start of that hang, so this strip holds the marker and
 * nothing else (the full 1.6 em would catch the anti-aliased left edge of
 * the text's first letter). Ink in here is a marker; none means the marker
 * was not drawn, which the whole-box pixel count above cannot tell apart
 * from the text merely shifting right by the indent.
 */
async function markerGutter(
  page: Page,
  id: string,
): Promise<{ x: number; y: number; w: number; h: number }> {
  return page.evaluate((targetId) => {
    const sg = window.__narrative_scene_graph
    const c = sg?.getContainer(targetId)
    const o = window.__narrative_test_api?.getObject(targetId) as {
      fontSize?: number
      height?: number
    } | null
    const canvasEl = document.querySelector('canvas')
    const r = canvasEl?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const fontSize = o?.fontSize ?? 24
    const a = c?.toGlobal({ x: 0, y: 0 }) ?? { x: 0, y: 0 }
    // Only as tall as the three lines: the box runs on below the visible
    // canvas at this zoom, into the panels under it, whose ink is not ours.
    const b = c?.toGlobal({ x: fontSize, y: Math.min(o?.height ?? 300, 4 * fontSize) }) ?? {
      x: 0,
      y: 0,
    }
    return { x: a.x + r.left, y: a.y + r.top, w: b.x - a.x, h: b.y - a.y }
  }, id)
}

test.describe('Multi-level lists — feature smoke', () => {
  test('type 3 lines, bullet, indent, numbered, caret + backspace, WYSIWYG', async ({ page }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      const t = m.text()
      // Ignore the browser's generic resource-load 404 noise — it's a
      // network-level message with no app stack/context (an optional asset
      // fetch on the empty deck), not a list-feature error. Real app
      // console.error calls and pageerrors are still captured.
      if (t.includes('Failed to load resource') && t.includes('404')) return
      if (isEngineNoise(t)) return
      errors.push(`console.error: ${t}`)
    })

    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    // ---- (a) Create text object + type 3 lines via Enter ------------------
    const ID = 'list-smoke-text'
    await page.evaluate((id) => {
      window.__narrative_test_api!.addText({
        id,
        x: 700,
        y: 500,
        w: 600,
        h: 300,
        text: '',
      })
    }, ID)
    await expect
      .poll(
        () =>
          page.evaluate((id) => window.__narrative_scene_graph?.getContainer(id) !== undefined, ID),
        {
          timeout: 5000,
        },
      )
      .toBe(true)

    await enterEdit(page, ID)
    const ce = page.locator('[data-shortcut-scope="canvas"] [contenteditable="true"]').first()
    await ce.click()
    await page.keyboard.type('Alpha')
    await page.waitForTimeout(200)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    await page.keyboard.type('Beta')
    await page.waitForTimeout(200)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    await page.keyboard.type('Gamma')
    await page.waitForTimeout(200)

    // Body should be 3 paragraphs separated by U+2029.
    await expect
      .poll(async () => splitParas(await bodyText(page, ID)))
      .toEqual(['Alpha', 'Beta', 'Gamma'])

    // Exit edit; capture baseline rendered pixels (plain text, no markers).
    await page.keyboard.press('Escape')
    await expect(ce).toBeHidden({ timeout: 5000 })
    await page.waitForTimeout(400)
    const region = { x: 0, y: 0, w: 0, h: 0 }
    {
      const o = await objScreenOrigin(page, ID)
      region.x = o.x
      region.y = o.y
      region.w = 620
      region.h = 300
    }
    const plainPixels = await colouredPixels(page, region)
    await page.screenshot({ path: 'test-results/list-smoke-1-plain.png' })

    // ---- (b) Inspector: List = Bullet ------------------------------------
    await page.evaluate((id) => window.__narrative_test_api!.setSelection([id]), ID)
    const listSelect = page.locator('select[title="List style"]')
    await expect(listSelect).toBeVisible({ timeout: 5000 })
    await listSelect.selectOption('bullet')
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'test-results/list-smoke-2-bullet.png' })
    const bulletPixels = await colouredPixels(page, region)
    // Bullets add dark glyphs → more ink than plain text. The margin used to
    // be +50 px, which no rendering here reaches: three small bullet glyphs
    // measured +12 px on system Chrome at this font size. Keep the invariant
    // (bullets add ink), drop the number that was never measured.
    expect(bulletPixels).toBeGreaterThan(plainPixels)
    // And the ink has to be the markers, in their gutter. That total rose by
    // a dozen pixels while no marker was drawn at all — the text moving right
    // by the indent was enough — so it never noticed they were missing.
    // Deselect first: the selection frame runs down the gutter's left edge
    // and would pass for ink.
    await page.evaluate(() => window.__narrative_test_api!.setSelection([]))
    await page.waitForTimeout(300)
    const gutterInk = await colouredPixels(page, await markerGutter(page, ID))
    expect(gutterInk, 'no bullet glyphs drawn in the marker gutter').toBeGreaterThan(20)

    // ---- (f-pre) WYSIWYG check on bullets: re-enter, read markers --------
    await enterEdit(page, ID)
    {
      const markers = await overlayMarkers(page)
      // 3 lines, all level-0 bullet → all '•'
      expect(markers).toEqual(['•', '•', '•'])
      const paras = await overlayParagraphs(page)
      expect(paras).toEqual(['Alpha', 'Beta', 'Gamma'])
    }

    // ---- (c) Caret on line 2, Tab → indent; marker becomes level-1 glyph -
    // Put caret inside "Beta": click the second paragraph.
    const pb2 = page
      .locator('[data-shortcut-scope="canvas"] [contenteditable="true"] [data-pb="1"]')
      .nth(1)
    await pb2.click()
    // Move caret to end of "Beta" deterministically.
    await page.keyboard.press(caret.lineEnd)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(200)
    {
      const markers = await overlayMarkers(page)
      // line 2 indented to level 1 → '◦'
      expect(markers).toEqual(['•', '◦', '•'])
    }
    await page.keyboard.press('Escape')
    await expect(ce).toBeHidden({ timeout: 5000 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: 'test-results/list-smoke-3-indent.png' })

    // ---- (d) Switch List = Numbered + numbering-format select ------------
    await page.evaluate((id) => window.__narrative_test_api!.setSelection([id]), ID)
    await expect(listSelect).toBeVisible({ timeout: 5000 })
    await listSelect.selectOption('number')
    await page.waitForTimeout(400)
    await page.screenshot({ path: 'test-results/list-smoke-4-numbered.png' })
    await enterEdit(page, ID)
    {
      const markers = await overlayMarkers(page)
      // level0 items: 1. , 2. ; nested level1 item restarts: 1.
      // markers order follows paragraph order: Alpha(L0), Beta(L1), Gamma(L0)
      expect(markers).toEqual(['1.', '1.', '2.'])
    }
    await page.keyboard.press('Escape')
    await expect(ce).toBeHidden({ timeout: 5000 })

    // numbering-format select → a. b. c.
    await page.evaluate((id) => window.__narrative_test_api!.setSelection([id]), ID)
    const fmtSelect = page.locator('select[title="Numbering format"]')
    await expect(fmtSelect).toBeVisible({ timeout: 5000 })
    await fmtSelect.selectOption('lowerAlpha')
    await page.waitForTimeout(300)
    await enterEdit(page, ID)
    {
      const markers = await overlayMarkers(page)
      expect(markers).toEqual(['a.', 'a.', 'b.'])
    }

    // ---- (e) Caret-after-Enter + Backspace at start of a list item -------
    // Caret after Enter: go to end of Gamma, Enter, type X → new item "X".
    const pbLast = page
      .locator('[data-shortcut-scope="canvas"] [contenteditable="true"] [data-pb="1"]')
      .last()
    await pbLast.click()
    await page.keyboard.press(caret.lineEnd)
    await page.keyboard.press('Enter')
    await page.keyboard.type('Xi')
    await expect
      .poll(async () => splitParas(await bodyText(page, ID)))
      .toEqual(['Alpha', 'Beta', 'Gamma', 'Xi'])
    // The typed text landed in a NEW paragraph (after the marker), not before.
    {
      const paras = await overlayParagraphs(page)
      expect(paras[paras.length - 1]).toBe('Xi')
    }

    // Normalise to a clean bullet list, all level 0, before exercising the
    // Backspace branches. (Beta is currently nested at level 1 from step (c);
    // flatten it via Shift+Tab so every item is level 0.)
    await page.keyboard.press('Escape')
    await expect(ce).toBeHidden({ timeout: 5000 })
    await page.evaluate((id) => window.__narrative_test_api!.setSelection([id]), ID)
    await expect(listSelect).toBeVisible({ timeout: 5000 })
    await listSelect.selectOption('bullet')
    await page.waitForTimeout(300)
    await enterEdit(page, ID)
    {
      const pbBeta = page
        .locator('[data-shortcut-scope="canvas"] [contenteditable="true"] [data-pb="1"]')
        .nth(1)
      await pbBeta.click()
      await page.keyboard.press(caret.lineEnd)
      await page.keyboard.press('Shift+Tab')
      await page.waitForTimeout(200)
      const markers = await overlayMarkers(page)
      // All four items now level-0 bullets.
      expect(markers).toEqual(['•', '•', '•', '•'])
    }

    // ---- Backspace case 1: MERGE at start of a non-first level-0 item -----
    // Caret at start of "Xi" (last item, level 0, not the first paragraph).
    // FIXED behaviour: Backspace deletes the separator before it and merges
    // "Xi" into the previous paragraph → ['Alpha','Beta','GammaXi'], still a
    // bullet list.
    {
      const pbXi = page
        .locator('[data-shortcut-scope="canvas"] [contenteditable="true"] [data-pb="1"]')
        .last()
      await pbXi.click()
      await caretToItemStart(page, 3) // start of "Xi"
      await page.keyboard.press('Backspace')
      await expect
        .poll(async () => splitParas(await bodyText(page, ID)))
        .toEqual(['Alpha', 'Beta', 'GammaXi'])
      // Still a bullet list after the merge (markers unchanged in count).
      const markers = await overlayMarkers(page)
      expect(markers).toEqual(['•', '•', '•'])
    }

    // ---- Backspace case 2: OUTDENT a nested item -------------------------
    // Indent "Beta" to level 1, caret at its start, Backspace → it outdents
    // back to level 0. Body text unchanged, only the level drops.
    {
      const pbBeta = page
        .locator('[data-shortcut-scope="canvas"] [contenteditable="true"] [data-pb="1"]')
        .nth(1)
      await pbBeta.click()
      await page.keyboard.press(caret.lineEnd)
      await page.keyboard.press('Tab')
      await page.waitForTimeout(200)
      expect(await overlayMarkers(page)).toEqual(['•', '◦', '•'])
      await pbBeta.click()
      await caretToItemStart(page, 1) // start of "Beta" (the nested item)
      await page.keyboard.press('Backspace')
      await page.waitForTimeout(200)
      // Outdented back to level 0 → all level-0 bullets again.
      expect(await overlayMarkers(page)).toEqual(['•', '•', '•'])
      // Body text untouched by the outdent.
      await expect
        .poll(async () => splitParas(await bodyText(page, ID)))
        .toEqual(['Alpha', 'Beta', 'GammaXi'])
    }

    // ---- Backspace case 3: STRIP the list on the first item --------------
    // Caret at start of the first item ("Alpha", level 0). FIXED behaviour:
    // Backspace removes the bullet from that item (converts it to a plain
    // paragraph) — body text unchanged, first marker disappears.
    {
      const pbAlpha = page
        .locator('[data-shortcut-scope="canvas"] [contenteditable="true"] [data-pb="1"]')
        .first()
      await pbAlpha.click()
      await caretToItemStart(page, 0) // start of "Alpha" (the first item)
      await page.keyboard.press('Backspace')
      await page.waitForTimeout(200)
      // First item lost its bullet; the other two still carry one.
      expect(await overlayMarkers(page)).toEqual(['•', '•'])
      // Body text unchanged.
      await expect
        .poll(async () => splitParas(await bodyText(page, ID)))
        .toEqual(['Alpha', 'Beta', 'GammaXi'])
    }

    // ---- Backspace regression: mid-word delete + plain-paragraph merge ----
    // Mid-word Backspace still deletes a single character (native/diff path).
    {
      const pbBeta = page
        .locator('[data-shortcut-scope="canvas"] [contenteditable="true"] [data-pb="1"]')
        .nth(1)
      await pbBeta.click()
      await page.keyboard.press(caret.lineEnd)
      await page.keyboard.press('Backspace') // delete the 'a' in "Beta"
      await expect
        .poll(async () => splitParas(await bodyText(page, ID)))
        .toEqual(['Alpha', 'Bet', 'GammaXi'])
    }

    // Plain-paragraph backspace-merge still works (Bug 1's fix). Strip the
    // remaining list entirely, then merge the last paragraph into the prior
    // one from its start. Body here is ['Alpha','Bet','GammaXi'].
    await page.keyboard.press('Escape')
    await expect(ce).toBeHidden({ timeout: 5000 })
    await page.evaluate((id) => window.__narrative_test_api!.setSelection([id]), ID)
    await expect(listSelect).toBeVisible({ timeout: 5000 })
    await listSelect.selectOption('')
    await page.waitForTimeout(300)
    await enterEdit(page, ID)
    {
      const pbX = page
        .locator('[data-shortcut-scope="canvas"] [contenteditable="true"] [data-pb="1"]')
        .last()
      await pbX.click()
      await caretToItemStart(page, 2) // start of "GammaXi" (third plain paragraph)
      await page.keyboard.press('Backspace')
      await page.waitForTimeout(200)
      await expect
        .poll(async () => splitParas(await bodyText(page, ID)))
        .toEqual(['Alpha', 'BetGammaXi'])
    }

    // ---- (f) WYSIWYG: markers while editing == rendered after exit -------
    // Body is now plain (['Alpha','BetGammaXi']). Re-apply a bullet list
    // via the Inspector, read the markers shown in the editing overlay, exit,
    // and confirm the same markers paint on the Pixi canvas (pixel delta over
    // the plain baseline).
    await page.keyboard.press('Escape')
    await expect(ce).toBeHidden({ timeout: 5000 })
    await page.evaluate((id) => window.__narrative_test_api!.setSelection([id]), ID)
    await expect(listSelect).toBeVisible({ timeout: 5000 })
    await listSelect.selectOption('bullet')
    await page.waitForTimeout(400)
    await enterEdit(page, ID)
    const editMarkers = await overlayMarkers(page)
    // 2 plain-level paragraphs → 2 bullets shown WHILE editing.
    expect(editMarkers).toEqual(['•', '•'])
    await page.keyboard.press('Escape')
    await expect(ce).toBeHidden({ timeout: 5000 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: 'test-results/list-smoke-5-final.png' })
    const finalPixels = await colouredPixels(page, region)
    // WYSIWYG: the bullets shown in the overlay are rendered on the canvas too.
    expect(finalPixels).toBeGreaterThan(plainPixels + 50)

    expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
    // Report marker state for the log.
    console.log('FINAL_EDIT_MARKERS', JSON.stringify(editMarkers))
  })
})
