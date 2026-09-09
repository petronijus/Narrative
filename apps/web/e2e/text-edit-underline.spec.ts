/**
 * Underline placement capture: writes one screenshot per (vAlign, fontSize)
 * combination so the underline offset can be eyeballed against the glyph
 * baseline. No assertions — this is a capture harness, kept because the
 * underline offset has regressed twice and a pixel threshold here would be
 * noise under a system Chrome.
 */

import { test, type Page } from '@playwright/test'
import { provisionDeckWithText } from './fixtures/provisionDeck.js'

async function setup(page: Page): Promise<{ id: string; slideId: string }> {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const { objectId, slideId } = await provisionDeckWithText(page, {
    title: 'text-edit-underline',
    objectId: 'underline-text',
  })
  await page.waitForTimeout(500)
  return { id: objectId, slideId }
}

async function probe(page: Page, id: string) {
  return await page.evaluate((targetId: string) => {
    const sg = (
      window as unknown as {
        __narrative_scene_graph?: {
          getContainer: (
            id: string,
          ) => { toGlobal: (p: { x: number; y: number }) => { x: number; y: number } } | undefined
        }
      }
    ).__narrative_scene_graph
    if (sg === undefined) return null
    const c = sg.getContainer(targetId)
    if (c === undefined) return null
    const local = c.toGlobal({ x: 0, y: 0 })
    const rect = document.querySelector('canvas')?.getBoundingClientRect() ?? { left: 0, top: 0 }
    return { pageX: local.x + rect.left, pageY: local.y + rect.top }
  }, id)
}

for (const vAlign of ['top', 'middle', 'bottom'] as const) {
  for (const fontSize of [16, 48] as const) {
    test(`underline placement screenshot vAlign=${vAlign} fontSize=${fontSize}`, async ({
      page,
    }) => {
      test.setTimeout(45_000)
      const target = await setup(page)

      await page.evaluate(
        ({ id, slideId, fontSize, vAlign }) => {
          window.__narrative_test_api!.updateObject(
            id,
            {
              align: 'left',
              vAlign,
              underline: true,
              italic: undefined,
              text: 'Hello world\nSecond line',
              fontSize,
              width: 700,
              height: 500,
            },
            slideId,
          )
        },
        { id: target.id, slideId: target.slideId, fontSize, vAlign },
      )
      await page.waitForTimeout(500)

      const p = await probe(page, target.id)
      if (p === null) throw new Error('probe failed')
      await page.screenshot({
        path: `test-results/underline-v${vAlign}-${fontSize}.png`,
        clip: {
          x: Math.max(0, p.pageX - 30),
          y: Math.max(0, p.pageY - 30),
          width: 800,
          height: 560,
        },
      })
    })
  }
}

for (const fontSize of [16, 24, 48, 96]) {
  test(`underline placement screenshot fontSize=${fontSize}`, async ({ page }) => {
    test.setTimeout(45_000)
    const target = await setup(page)

    await page.evaluate(
      ({ id, slideId, fontSize }) => {
        window.__narrative_test_api!.updateObject(
          id,
          {
            align: 'left',
            vAlign: 'top',
            underline: true,
            italic: undefined,
            text: 'Hello world\nSecond line',
            fontSize,
            width: 700,
            height: 400,
          },
          slideId,
        )
      },
      { id: target.id, slideId: target.slideId, fontSize },
    )
    await page.waitForTimeout(500)

    const p = await probe(page, target.id)
    if (p === null) throw new Error('probe failed')

    await page.screenshot({
      path: `test-results/underline-${fontSize}.png`,
      clip: {
        x: Math.max(0, p.pageX - 30),
        y: Math.max(0, p.pageY - 30),
        width: 800,
        height: Math.max(120, fontSize * 4),
      },
    })
  })
}
