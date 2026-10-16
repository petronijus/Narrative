/**
 * e2e/text-line-height-run-size.spec.ts
 *
 * A line is as tall as the fonts on it, not as the frame's default size.
 *
 * PowerPoint's line spacing — "single", or a multiple such as a real
 * deck's 68 % titles — is a multiple of the text on the line. An imported
 * title whose frame default is 88 pt but whose text is set at 60 pt is
 * spaced for 60 pt. We used to lay every line out at the frame's size: the
 * lines came out ~50 % too far apart, and after that was fixed CSS still
 * added the gap between the two fonts' baseline positions to every line
 * (each block also sizes its lines by its own font, its "strut").
 *
 * The invariant: text at 60 px in a frame whose default is 150 px lays out
 * exactly as text at 60 px in a 60 px frame — rendered, and while editing.
 */

import { test, expect, type Page } from './fixtures/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const EDITOR = '[data-shortcut-scope="canvas"] [contenteditable="true"]'
const TEXT = 'First line\nSecond line\nThird line\nFourth line'

test.use({ viewport: { width: 1800, height: 1200 } })

async function renderedHeight(page: Page, id: string): Promise<number> {
  let h = 0
  for (let i = 0; i < 40 && h === 0; i++) {
    h = await page.evaluate((objectId) => {
      const c = window.__narrative_scene_graph?.getContainer(objectId) as unknown as
        { children?: { height?: number; constructor?: { name?: string } }[] } | undefined
      const node = (c?.children ?? []).find((k) => k.constructor?.name === 'HTMLText')
      return Math.round((node?.height ?? 0) * 10) / 10
    }, id)
    if (h === 0) await page.waitForTimeout(250)
  }
  return h
}

async function editingHeight(page: Page, id: string): Promise<number> {
  await page.evaluate((objectId) => window.__narrative_test_api!.beginTextEdit(objectId), id)
  const editor = page.locator(EDITOR)
  await expect(editor).toBeVisible()
  // The laid-out lines, not the box: the paragraphs' own height.
  const h = await editor.evaluate((el) =>
    [...el.querySelectorAll('[data-pb]')].reduce(
      (sum, p) => sum + p.getBoundingClientRect().height,
      0,
    ),
  )
  await page.evaluate(() => window.__narrative_test_api!.endTextEdit())
  await expect(editor).toHaveCount(0)
  return Math.round(h * 10) / 10
}

test('a line is spaced for the size of its text, not the frame default', async ({ page }) => {
  test.setTimeout(120_000)

  const res = await page.request.post(`${API_BASE}/decks`, {
    data: { title: 'line-height-run-size' },
  })
  expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
  const { id: deckId } = (await res.json()) as { id: string }

  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')

  await page.evaluate((text) => {
    const api = window.__narrative_test_api!
    const slide = api.listSlideIds()[0]!
    const common = {
      y: 100,
      w: 700,
      h: 400,
      text,
      lineSpacing: 0.68,
      wrap: 'none' as const,
      runFontSize: 60,
    }
    // The imported title's shape: a large frame default, the text smaller.
    api.addText({ id: 'large-default', x: 100, fontSize: 150, ...common }, slide)
    // The control: the same text in a frame of its own size.
    api.addText({ id: 'own-size', x: 900, fontSize: 60, ...common }, slide)
  }, TEXT)

  const large = await renderedHeight(page, 'large-default')
  const own = await renderedHeight(page, 'own-size')
  console.log(`[line-height] rendered: frame 150 → ${large}, frame 60 → ${own}`)
  expect(own, 'the control text was never measured').toBeGreaterThan(0)
  expect(
    Math.abs(large - own),
    'rendered lines differ with the frame default size',
  ).toBeLessThanOrEqual(1)

  const largeEdit = await editingHeight(page, 'large-default')
  const ownEdit = await editingHeight(page, 'own-size')
  console.log(`[line-height] editing: frame 150 → ${largeEdit}, frame 60 → ${ownEdit}`)
  expect(
    Math.abs(largeEdit - ownEdit),
    'edited lines differ with the frame default size',
  ).toBeLessThanOrEqual(1)
  // And edit mode draws the lines the renderer draws.
  expect(
    Math.abs(ownEdit - own),
    'edit mode and render mode lay the lines out differently',
  ).toBeLessThanOrEqual(2)
})
