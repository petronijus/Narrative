/**
 * e2e/text-autofit.spec.ts — autofit in a real browser (agentic A4.2).
 *
 * - A box set to grow with its text in the Inspector is drawn as tall as its
 *   laid-out text, and the editor writes that height into the document as
 *   the person types — in the same undo step, so an undo brings text and
 *   height back together.
 * - A shrinking box draws its type at the largest scale at which the text
 *   fits, never below its floor, and stops shrinking when the floor is its
 *   own size.
 *
 * The renderer's search itself is unit-tested (textRenderer.autofit.test);
 * this is the browser laying the text out and the editor's write-back.
 */

import { test, expect, type Page } from '@playwright/test'
import { caret } from './fixtures/keys.js'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'

test.use({ viewport: { width: 1800, height: 1200 } })

interface SceneGraphProbe {
  drawnSize: (id: string) => { width: number; height: number } | null
  textLayout: (id: string) => { height: number; scale: number } | undefined
}

/** The drawn height, its stored height and the type scale of a text box. */
async function boxState(
  page: Page,
  id: string,
): Promise<{ drawn: number; stored: number; scale: number } | null> {
  return page.evaluate((objectId) => {
    const sg = (window as unknown as { __narrative_scene_graph?: SceneGraphProbe })
      .__narrative_scene_graph
    const layout = sg?.textLayout(objectId)
    const obj = window.__narrative_test_api!.getObject(objectId)
    if (layout === undefined || obj === null) return null
    return { drawn: layout.height, stored: obj['height'] as number, scale: layout.scale }
  }, id)
}

async function openNewDeck(page: Page, title: string): Promise<string> {
  const res = await page.request.post(`${API_BASE}/decks`, { data: { title } })
  expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
  const { id } = (await res.json()) as { id: string }
  await page.goto(`/deck/${id}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')
  return id
}

test('a growing box is as tall as its text, and keeps its height as the person types', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const deckId = await openNewDeck(page, 'text-autofit-grow')
  try {
    const id = 'growing'
    await page.evaluate((objectId) => {
      const api = window.__narrative_test_api!
      api.addText(
        { id: objectId, x: 100, y: 100, w: 600, h: 400, text: 'One line', fontSize: 40 },
        api.listSlideIds()[0]!,
      )
    }, id)
    // Selected once it is on the canvas (a selection of an id the editor
    // has not mounted yet is dropped).
    await expect
      .poll(() =>
        page.evaluate((objectId) => {
          const api = window.__narrative_test_api!
          if (!api.sceneGraphHasMountedNode(objectId)) return false
          api.setSelection([objectId])
          return api.getSelection().includes(objectId)
        }, id),
      )
      .toBe(true)

    // The person's way in: the Inspector's Autofit control.
    await page.getByRole('button', { name: 'Grow with the text' }).click()

    // One line of 40 px type: the box takes the line's height, drawn and stored.
    await expect
      .poll(async () => {
        const s = await boxState(page, id)
        return s !== null && s.drawn < 120 && Math.abs(s.drawn - s.stored) <= 1
      })
      .toBe(true)
    const oneLine = (await boxState(page, id))!

    // The click and the height it wrote are one step: one undo is a fixed
    // 400 px box again …
    await page.keyboard.press('ControlOrMeta+z')
    await expect
      .poll(() =>
        page.evaluate((objectId) => {
          const o = window.__narrative_test_api!.getObject(objectId)
          return o === null ? null : { autofit: o['autofit'] ?? null, height: o['height'] }
        }, id),
      )
      .toEqual({ autofit: null, height: 400 })
    // … and growing it again lands where it was.
    await page.getByRole('button', { name: 'Grow with the text' }).click()
    await expect.poll(async () => (await boxState(page, id))?.stored).toBeCloseTo(oneLine.stored, 0)

    // Typing more lines grows it, and the height follows into the document.
    await page.evaluate((objectId) => window.__narrative_test_api!.beginTextEdit(objectId), id)
    await page.keyboard.press(caret.textEnd)
    await page.keyboard.type(
      ' and then a good deal more text, enough to wrap onto several lines of this box',
    )
    await page.keyboard.press('Escape')
    await expect
      .poll(async () => {
        const s = await boxState(page, id)
        return s !== null && s.drawn > oneLine.drawn * 2 && Math.abs(s.drawn - s.stored) <= 1
      })
      .toBe(true)

    // Undoing the typing takes each height it wrote back with it: whatever
    // the steps the typing fell into (a pause of half a second starts a
    // new one), the box is never left drawn at one height and stored at
    // another, and ends where it started.
    const bodyText = (): Promise<string> =>
      page.evaluate((objectId) => {
        const t = window.__narrative_test_api!.getObject(objectId)?.['text']
        return typeof t === 'string' ? t : String((t as { toString(): string }) ?? '')
      }, id)
    for (let i = 0; i < 10 && (await bodyText()) !== 'One line'; i++) {
      await page.keyboard.press('ControlOrMeta+z')
      await expect
        .poll(async () => {
          const s = await boxState(page, id)
          return s !== null && Math.abs(s.drawn - s.stored) <= 1
        })
        .toBe(true)
    }
    expect(await bodyText()).toBe('One line')
    const back = (await boxState(page, id))!
    expect(Math.abs(back.drawn - oneLine.drawn)).toBeLessThanOrEqual(1)
    expect(Math.abs(back.stored - oneLine.stored)).toBeLessThanOrEqual(1)
  } finally {
    await page.request.delete(`${API_BASE}/decks/${deckId}`)
  }
})

test('a shrinking box scales its type down to fit, not below its floor', async ({ page }) => {
  test.setTimeout(120_000)
  const deckId = await openNewDeck(page, 'text-autofit-shrink')
  try {
    const id = 'shrinking'
    await page.evaluate((objectId) => {
      const api = window.__narrative_test_api!
      api.addText(
        {
          id: objectId,
          x: 100,
          y: 100,
          w: 500,
          h: 120,
          text: 'A headline far too long for the box it was given, which has to shrink to fit',
          fontSize: 48,
        },
        api.listSlideIds()[0]!,
      )
      api.updateObject(objectId, { autofit: 'shrink' })
    }, id)

    await expect
      .poll(async () => (await boxState(page, id))?.scale ?? 1, { timeout: 20_000 })
      .toBeLessThan(1)
    const shrunk = (await boxState(page, id))!
    // Half the size is the floor without minFontSize.
    expect(shrunk.scale).toBeGreaterThanOrEqual(0.5)
    // Drawn at that scale, the text fits the box (the box keeps its size).
    const textHeight = await page.evaluate((objectId) => {
      const sg = window.__narrative_scene_graph
      const kids = (
        sg?.getContainer(objectId) as unknown as {
          children: { height?: number; anchor?: unknown }[]
        }
      ).children
      return kids.find((c) => c.anchor !== undefined)?.height ?? 0
    }, id)
    expect(textHeight).toBeLessThanOrEqual(121)
    expect(shrunk.drawn).toBe(120)

    // A floor at the box's own size: no shrinking left.
    await page.evaluate((objectId) => {
      window.__narrative_test_api!.updateObject(objectId, { minFontSize: 48 })
    }, id)
    await expect.poll(async () => (await boxState(page, id))?.scale).toBe(1)
  } finally {
    await page.request.delete(`${API_BASE}/decks/${deckId}`)
  }
})
