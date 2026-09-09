import { test, expect, type Page } from '@playwright/test'
import { provisionDeckWithText } from './fixtures/provisionDeck.js'

/**
 * Regression for "long unbroken string overflows the box in Pixi but
 * wraps in DOM, so typing more characters becomes invisible."
 *
 * Pixi must use breakWords:true (matching DOM `word-break: break-word`)
 * so a string like "asdasdasdasd..." wraps at the box edge in both
 * the rendered text and the inline editor, keeping the caret and
 * the rendered glyphs in sync as the user types.
 */

async function setup(page: Page): Promise<{ id: string; slideId: string }> {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const { objectId, slideId } = await provisionDeckWithText(page, {
    title: 'text-edit-wrap',
    objectId: 'wrap-text',
  })
  await page.waitForTimeout(500)
  return { id: objectId, slideId }
}

test('long unbroken string wraps inside the box, no horizontal overflow', async ({ page }) => {
  test.setTimeout(45_000)
  const target = await setup(page)

  // Seed a long unbroken string + a known box width.
  const PAYLOAD = 'asdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasdasd'
  await page.evaluate(
    ({ id, slideId, text }) => {
      window.__narrative_test_api!.updateObject(
        id,
        { text, fontSize: 48, width: 500, height: 400, align: 'left', vAlign: 'top' },
        slideId,
      )
    },
    { id: target.id, slideId: target.slideId, text: PAYLOAD },
  )
  await page.waitForTimeout(500)

  // Pixi rendered text width MUST NOT exceed the box width.
  const pixiBox = await page.evaluate((id: string) => {
    const sg = (
      window as unknown as {
        __narrative_scene_graph?: {
          getContainer: (id: string) =>
            | {
                children: Array<{ width?: number; height?: number; anchor?: unknown }>
              }
            | undefined
        }
      }
    ).__narrative_scene_graph
    if (sg === undefined) return null
    const c = sg.getContainer(id)
    if (c === undefined) return null
    const t = c.children.find((ch) => ch.anchor !== undefined)
    return t === undefined ? null : { width: t.width ?? 0, height: t.height ?? 0 }
  }, target.id)

  expect(pixiBox).not.toBeNull()
  console.log(
    `[wrap] pixi text bounds = ${pixiBox!.width.toFixed(1)} × ${pixiBox!.height.toFixed(1)} (box width=500)`,
  )
  // Pixi's breakWords lets the last char of a line cross wordWrapWidth
  // by up to one glyph advance before forcing a break, so allow ~one
  // glyph of overhang.
  expect(pixiBox!.width).toBeLessThanOrEqual(540)
  // And the wrap should produce a meaningfully tall block (multiple lines).
  expect(pixiBox!.height).toBeGreaterThan(60)
})
