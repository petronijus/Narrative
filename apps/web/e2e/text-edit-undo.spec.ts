/**
 * e2e/text-edit-undo.spec.ts
 *
 * Undo has to cover typing, not just object-level edits.
 *
 * The Y.UndoManager is built with `trackedOrigins: new Set([LOCAL_ORIGIN])`
 * (packages/slide-model/src/undo.ts), so a transaction that carries no origin
 * is invisible to it. Every mutation in `mutations.ts` passes LOCAL_ORIGIN —
 * except the text-editing path, which called `spliceRichText` without one, so
 * everything the user typed stayed off the undo stack. Moving a box was
 * undoable; writing the sentence inside it was not.
 *
 * Reported 2026-09-09 as "undo suddenly doesn't work".
 */

import { test, expect, type Page } from '@playwright/test'
import { caret } from './fixtures/keys.js'

const OBJ_ID = 'undo-text-1'
const INITIAL = 'Hello'

async function createDeck(page: Page): Promise<string> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'text-edit-undo' },
  })
  const { id } = (await res.json()) as { id: string }
  return id
}

async function bodyText(page: Page, id: string): Promise<string> {
  return page.evaluate((targetId) => {
    const o = window.__narrative_test_api?.getObject(targetId)
    return typeof o?.['text'] === 'string' ? (o['text'] as string) : ''
  }, id)
}

test('typed text can be undone', async ({ page }) => {
  test.setTimeout(90_000)

  const deckId = await createDeck(page)
  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 20_000 })
    .toBe('object')

  await page.evaluate(
    ({ id, initial }) => {
      const api = window.__narrative_test_api!
      api.addText({ id, x: 700, y: 500, w: 600, h: 300, text: initial })
    },
    { id: OBJ_ID, initial: INITIAL },
  )
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => window.__narrative_scene_graph?.getContainer(id) !== undefined,
          OBJ_ID,
        ),
      { timeout: 15_000 },
    )
    .toBe(true)
  await page.waitForTimeout(1000)
  expect(await bodyText(page, OBJ_ID)).toBe(INITIAL)

  // Type into the object through the real contenteditable overlay. Entering
  // edit mode goes through the test API rather than a synthetic double-click:
  // the DOM overlay root sits above the canvas with `pointer-events: auto`, so
  // a synthetic click never reaches Pixi's hit test.
  await page.evaluate((id) => window.__narrative_test_api!.beginTextEdit(id), OBJ_ID)
  const editable = page.locator('[data-shortcut-scope="canvas"] [contenteditable="true"]').first()
  await expect(editable).toBeVisible({ timeout: 5_000 })
  await editable.click()

  await page.keyboard.press(caret.lineEnd)
  await page.keyboard.type(' world', { delay: 40 })
  await expect.poll(() => bodyText(page, OBJ_ID), { timeout: 5_000 }).toBe(`${INITIAL} world`)

  // Leave edit mode, then undo the way a user does. The UndoManager coalesces
  // edits inside its capture window, so give it time to close the stack item
  // before asking for the undo.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  await page.keyboard.press('ControlOrMeta+z')

  await expect.poll(() => bodyText(page, OBJ_ID), { timeout: 5_000 }).toBe(INITIAL)
})
