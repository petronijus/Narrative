import { test, type Page } from '@playwright/test'
import { provisionDeckWithText } from './fixtures/provisionDeck.js'

/**
 * Visual proof: open a freshly provisioned deck in normal mode and in edit
 * mode and save screenshots so a human can eyeball whether the edit overlay
 * actually sits where the rendered Pixi text sits.
 *
 * Screenshots:
 *   - test-results/deck-normal.png         (no edit, viewport)
 *   - test-results/deck-edit.png           (edit mode, viewport)
 *   - test-results/deck-normal-clip.png    (clip around the text)
 *   - test-results/deck-edit-clip.png      (clip around the text)
 */

/** The inline editor is a contenteditable div, not a <textarea>. */
const EDITOR = '[data-shortcut-scope="canvas"] [contenteditable="true"]'

async function probe(page: Page, id: string) {
  return await page.evaluate((targetId: string) => {
    const sg = (
      window as unknown as {
        __narrative_scene_graph?: {
          getContainer: (id: string) =>
            | {
                toGlobal: (p: { x: number; y: number }) => { x: number; y: number }
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
    const rect = canvasEl?.getBoundingClientRect() ?? { left: 0, top: 0 }
    return { pageX: local.x + rect.left, pageY: local.y + rect.top }
  }, id)
}

async function setup(page: Page): Promise<{ id: string; slideId: string }> {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const { objectId, slideId } = await provisionDeckWithText(page, {
    title: 'text-edit-screenshots',
    objectId: 'shot-text',
  })
  await page.waitForTimeout(800)
  return { id: objectId, slideId }
}

for (const vAlign of ['top', 'middle', 'bottom'] as const) {
  for (const align of ['left', 'center', 'right'] as const) {
    test(`screenshots align=${align} vAlign=${vAlign}`, async ({ page }) => {
      test.setTimeout(60_000)
      const target = await setup(page)

      // Apply combo + a longer multi-line payload so wrapping +
      // vertical-align effects are obvious in the screenshots. Also
      // grow the box (height + width) and shrink fontSize so the
      // content fits with room to spare — otherwise overflow forces
      // both Pixi and the editor to top-anchor and the screenshots
      // can't visually demonstrate vAlign=middle/bottom.
      const PAYLOAD = 'Lorem ipsum dolor.\nSecond line.\nThird line.'
      // Spell out every styling field so each combo screenshot starts
      // from the same known box-default state and the images can be
      // compared against each other.
      await page.evaluate(
        ({ id, slideId, align, vAlign, text }) => {
          window.__narrative_test_api!.updateObject(
            id,
            {
              align,
              vAlign,
              text,
              fontSize: 48,
              width: 700,
              height: 600,
              fontWeight: 400,
              italic: undefined,
              underline: undefined,
              fontFamily: undefined,
              color: 0x000000,
              colorAlpha: 1,
              letterSpacing: 0,
              lineHeight: 1.2,
              listStyle: undefined,
            },
            slideId,
          )
        },
        { id: target.id, slideId: target.slideId, align, vAlign, text: PAYLOAD },
      )
      await page.waitForTimeout(500)

      const p = await probe(page, target.id)
      if (p === null) throw new Error('probe failed')

      const tag = `${align}-${vAlign}`
      const clip = {
        x: Math.max(0, p.pageX - 40),
        y: Math.max(0, p.pageY - 40),
        width: 900,
        height: 750,
      }

      await page.screenshot({ path: `test-results/normal-${tag}.png`, clip })

      await page.mouse.dblclick(p.pageX + 50, p.pageY + 50)
      await page.locator(EDITOR).first().waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(400)

      await page.screenshot({ path: `test-results/edit-${tag}.png`, clip })

      await page.locator(EDITOR).first().press('Escape')
      await page.waitForTimeout(200)
    })
  }
}
