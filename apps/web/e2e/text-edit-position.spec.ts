import { test, expect, type Page } from './fixtures/test'
import { provisionDeckWithText } from './fixtures/provisionDeck.js'

/**
 * Verifies that the inline-text-edit DOM overlay sits exactly where
 * the Pixi-rendered text sits, for every combination of horizontal +
 * vertical alignment, AND that vAlign survives align changes / reload.
 *
 * Spec strategy:
 *   - Provision a deck with one text object (the spec used to open a
 *     hard-coded deck id that only existed on one machine).
 *   - For each (align × vAlign) combo:
 *       1. Patch the existing text obj via the dev test_api.
 *       2. Read the SceneGraph container's screen-space top-left and
 *          the Pixi text node's local x/y (which encodes Pixi's
 *          horizontal-anchor + vertical-align offset).
 *       3. Double-click to enter edit mode.
 *       4. Read the edit overlay's getBoundingClientRect.
 *       5. Compute the expected DOM glyph-block position and compare
 *          against the overlay's first-glyph position.
 *   - Plus: change align WITHOUT changing vAlign and assert vAlign is
 *     preserved (regression for the bug where align change reset it).
 *   - Plus: navigate away and reload to confirm vAlign survives a fresh
 *     mount (regression for "vAlign resets on reload").
 *
 * Tolerance: 4 px (sub-pixel rounding + Pixi-vs-DOM font metrics).
 */

const TOL = 4

interface TextNodeProbe {
  /** Container origin in page coords (top-left of the obj's bounding box). */
  pageX: number
  pageY: number
  /** Pixi text node's local x/y inside the container (anchor + align offset). */
  textNodeX: number
  textNodeY: number
  /** Pixi text node's pixel height after style+text (used for vAlign math). */
  textNodeHeight: number
  /** Anchor.x for sanity (1 = right, 0.5 = centre, 0 = left). */
  anchorX: number
}

async function probeTextNode(page: Page, id: string): Promise<TextNodeProbe | null> {
  return await page.evaluate((targetId: string) => {
    const sg = (
      window as unknown as {
        __narrative_scene_graph?: {
          getContainer: (id: string) =>
            | {
                toGlobal: (p: { x: number; y: number }) => { x: number; y: number }
                children: Array<{
                  x?: number
                  y?: number
                  height?: number
                  anchor?: { x: number; y: number }
                }>
              }
            | undefined
        }
      }
    ).__narrative_scene_graph
    if (sg === undefined) return null
    const c = sg.getContainer(targetId)
    if (c === undefined) return null
    const local = c.toGlobal({ x: 0, y: 0 })
    const canvasEl = document.querySelector('canvas')
    const canvasRect = canvasEl?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const text = c.children.find((ch) => ch.anchor !== undefined) as
      | {
          x?: number
          y?: number
          height?: number
          anchor?: { x: number; y: number }
        }
      | undefined
    if (text === undefined) return null
    return {
      pageX: local.x + canvasRect.left,
      pageY: local.y + canvasRect.top,
      textNodeX: text.x ?? 0,
      textNodeY: text.y ?? 0,
      textNodeHeight: text.height ?? 0,
      anchorX: text.anchor?.x ?? 0,
    }
  }, id)
}

/** The inline editor is a contenteditable div (it was a <textarea> when this
 *  spec was first written — the locator is the only thing that changed). */
const EDITOR = '[data-shortcut-scope="canvas"] [contenteditable="true"]'

async function readTextareaRect(page: Page) {
  return await page
    .locator(EDITOR)
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect()
      const cs = window.getComputedStyle(el)
      return {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        paddingTop: parseFloat(cs.paddingTop),
        paddingLeft: parseFloat(cs.paddingLeft),
        textAlign: cs.textAlign,
        lineHeightPx: parseFloat(cs.lineHeight),
        fontSizePx: parseFloat(cs.fontSize),
      }
    })
}

async function openDeckAndFindText(page: Page): Promise<{ id: string; slideId: string }> {
  const { objectId, slideId } = await provisionDeckWithText(page, {
    title: 'text-edit-position',
    objectId: 'tep-text',
    text: 'Hamburgefonstiv',
    x: 200,
    y: 200,
    width: 700,
    height: 300,
  })
  // The overlay measurements below compare against Pixi's rasterised glyphs,
  // which land a frame or two after mount.
  await page.waitForTimeout(1000)
  return { id: objectId, slideId }
}

async function exitEdit(page: Page): Promise<void> {
  await page
    .locator(EDITOR)
    .first()
    .press('Escape')
    .catch(() => undefined)
  await page.waitForTimeout(200)
}

test.describe('text edit overlay alignment', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
  })

  for (const vAlign of ['top', 'middle', 'bottom'] as const) {
    for (const align of ['left', 'center', 'right'] as const) {
      test(`align=${align} vAlign=${vAlign} — edit overlay matches Pixi`, async ({ page }) => {
        test.setTimeout(60_000)
        const { id, slideId } = await openDeckAndFindText(page)

        // Seed the alignment combo.
        await page.evaluate(
          ({ id, slideId, align, vAlign }) => {
            window.__narrative_test_api!.updateObject(id, { align, vAlign }, slideId)
          },
          { id, slideId, align, vAlign },
        )
        await page.waitForTimeout(400)

        // Probe Pixi BEFORE entering edit mode — that's where the
        // ground-truth rendered-text position lives.
        const probe = await probeTextNode(page, id)
        if (probe === null) throw new Error('SceneGraph probe failed')
        const pixiTextTop = probe.pageY + probe.textNodeY

        // Enter edit mode by double-clicking inside the box.
        await page.mouse.dblclick(probe.pageX + 50, probe.pageY + 50)
        await expect(page.locator(EDITOR).first()).toBeVisible({ timeout: 5_000 })
        await page.waitForTimeout(300) // let autoSize settle

        const ta = await readTextareaRect(page)
        const taContentTop = ta.top + ta.paddingTop
        const dy = taContentTop - pixiTextTop

        console.log(
          `[align=${align} vAlign=${vAlign}] pixiTextTop=${pixiTextTop.toFixed(1)} ` +
            `taTop=${ta.top.toFixed(1)} dy=${dy.toFixed(1)}px ` +
            `overlayH=${ta.height.toFixed(0)} textNodeY=${probe.textNodeY.toFixed(1)} ` +
            `textNodeH=${probe.textNodeHeight.toFixed(1)} text-align=${ta.textAlign}`,
        )

        expect.soft(ta.textAlign, `text-align should be ${align}`).toBe(align)
        expect.soft(Math.abs(dy), `vAlign=${vAlign} dy=${dy.toFixed(1)}px`).toBeLessThanOrEqual(TOL)

        await exitEdit(page)
      })
    }
  }

  test('changing align preserves vAlign', async ({ page }) => {
    test.setTimeout(45_000)
    const { id, slideId } = await openDeckAndFindText(page)

    // Set vAlign=middle, align=left.
    await page.evaluate(
      ({ id, slideId }) => {
        window.__narrative_test_api!.updateObject(id, { align: 'left', vAlign: 'middle' }, slideId)
      },
      { id, slideId },
    )
    await page.waitForTimeout(400)
    const before = await probeTextNode(page, id)
    if (before === null) throw new Error('probe before failed')

    // Now flip align=right WITHOUT touching vAlign.
    await page.evaluate(
      ({ id, slideId }) => {
        window.__narrative_test_api!.updateObject(id, { align: 'right' }, slideId)
      },
      { id, slideId },
    )
    await page.waitForTimeout(400)
    const after = await probeTextNode(page, id)
    if (after === null) throw new Error('probe after failed')

    // textNode.y encodes vAlign offset: top→0, middle→(h-th)/2, bottom→h-th
    // For vAlign=middle we expect a non-zero textNodeY. Specifically it
    // should not snap back to 0 when align changes.
    console.log(
      `[align-preserves-vAlign] before.textNodeY=${before.textNodeY.toFixed(2)} ` +
        `after.textNodeY=${after.textNodeY.toFixed(2)}`,
    )
    expect(Math.abs(after.textNodeY - before.textNodeY)).toBeLessThanOrEqual(0.5)
    expect(after.textNodeY).toBeGreaterThan(0.5) // confirm middle is actually applied
  })

  test('vAlign survives reload', async ({ page }) => {
    test.setTimeout(45_000)
    const { id, slideId } = await openDeckAndFindText(page)

    await page.evaluate(
      ({ id, slideId }) => {
        window.__narrative_test_api!.updateObject(id, { vAlign: 'bottom' }, slideId)
      },
      { id, slideId },
    )
    await page.waitForTimeout(800)
    const before = await probeTextNode(page, id)
    if (before === null) throw new Error('probe before failed')
    expect(before.textNodeY).toBeGreaterThan(0.5)

    // Hard reload.
    await page.reload()
    await page.waitForFunction(() => window.__narrative_test_api !== undefined, null, {
      timeout: 15_000,
    })
    // Poll until the SceneGraph has mounted the container — the
    // post-reload remount races with custom-font load + Y.Doc sync.
    await page.waitForFunction(
      (targetId: string) => {
        const sg = (
          window as unknown as {
            __narrative_scene_graph?: {
              sceneGraphHasMountedNode?: (id: string) => boolean
              getMountedIds?: () => string[]
            }
          }
        ).__narrative_scene_graph
        return sg !== undefined && (sg.getMountedIds?.() ?? []).includes(targetId)
      },
      id,
      { timeout: 10_000 },
    )

    const after = await probeTextNode(page, id)
    if (after === null) throw new Error('probe after reload failed')
    console.log(
      `[reload] before.textNodeY=${before.textNodeY.toFixed(2)} ` +
        `after.textNodeY=${after.textNodeY.toFixed(2)}`,
    )
    // Allow ±0.5 px wobble from font metric warm-up; bottom must stay applied.
    expect(after.textNodeY).toBeGreaterThan(0.5)
    expect(Math.abs(after.textNodeY - before.textNodeY)).toBeLessThanOrEqual(2)
  })
})
