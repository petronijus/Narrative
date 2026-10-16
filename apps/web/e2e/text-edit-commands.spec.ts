/**
 * e2e/text-edit-commands.spec.ts
 *
 * Typing on the canvas goes through `text.edit` (A2.11): keystrokes are
 * splices, Enter / Backspace are the command's rules, Tab is `text.list`.
 * Checked with real keys on a list, read back through the command API.
 */

import { test, expect, type APIRequestContext, type Page } from './fixtures/test'
import { caret } from './fixtures/keys.js'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

const BOX = { x: 300, y: 200, width: 1200, height: 600 }

interface Paragraph {
  runs: Array<{ text: string }>
  list?: string
  level?: number
}

async function command<T>(
  request: APIRequestContext,
  target: Record<string, string>,
  commandId: string,
  input: unknown,
): Promise<T> {
  const res = await request.post(`${API_BASE}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target, command: commandId, input },
  })
  const body = (await res.json()) as { ok: boolean; result: T; error?: { message: string } }
  expect(body.ok, `${commandId}: ${body.error?.message}`).toBe(true)
  return body.result
}

/** Each paragraph as [text, list, level]. */
async function paragraphs(request: APIRequestContext, deckId: string, id: string) {
  const { object } = await command<{ object: { text: string; paragraphs?: Paragraph[] } }>(
    request,
    { deckId },
    'query.object',
    { slide: { index: 0 }, object: id },
  )
  if (object.paragraphs === undefined)
    return object.text.split('\n\n').map((t) => [t, null, 0] as const)
  return object.paragraphs.map(
    (p) => [p.runs.map((r) => r.text).join(''), p.list ?? null, p.level ?? 0] as const,
  )
}

async function settleSelection(page: Page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
}

/** A deck with one text box holding `body`; opened, fitted, and in edit mode with the caret at the end. */
async function editBox(page: Page, title: string, body: unknown) {
  const { id: deckId } = await command<{ id: string }>(page.request, {}, 'deck.create', { title })
  const { objectId } = await command<{ objectId: string }>(
    page.request,
    { deckId },
    'object.create',
    { slide: { index: 0 }, object: { type: 'text', ...BOX, text: 'x', fontSize: 40 } },
  )
  await command(page.request, { deckId }, 'text.set', {
    target: { slide: { index: 0 }, object: objectId },
    text: body,
  })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`/deck/${deckId}`)
  const artboard = page.locator('.artboard')
  await expect(artboard).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
  await page.getByRole('button', { name: 'Fit to screen' }).click()
  await page.waitForTimeout(400)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 15_000 })
    .toBe('object')
  await expect
    .poll(
      () =>
        page.evaluate((id) => window.__narrative_test_api!.sceneGraphHasMountedNode(id), objectId),
      { timeout: 8000 },
    )
    .toBe(true)
  const box = (await artboard.boundingBox())!
  const scale = box.width / 1920
  // Bottom right of the box: below the text, so the caret lands at the end.
  await page.mouse.dblclick(
    box.x + (BOX.x + BOX.width - 20) * scale,
    box.y + (BOX.y + BOX.height - 20) * scale,
  )
  const editor = page.locator('[contenteditable="true"]').first()
  await expect(editor).toBeFocused()
  await page.keyboard.press(caret.textEnd)
  await settleSelection(page)
  return { deckId, objectId, editor }
}

test('Enter continues a list, Tab nests, Backspace outdents and then joins', async ({ page }) => {
  const { deckId, objectId } = await editBox(page, `list keys ${Date.now()}`, {
    paragraphs: [{ list: 'bullet', text: 'One' }],
  })
  await page.keyboard.press('Enter')
  await page.keyboard.type('Two')
  await expect
    .poll(() => paragraphs(page.request, deckId, objectId))
    .toEqual([
      ['One', 'bullet', 0],
      ['Two', 'bullet', 0],
    ])

  await page.keyboard.press('Tab')
  await expect
    .poll(async () => (await paragraphs(page.request, deckId, objectId))[1])
    .toEqual(['Two', 'bullet', 1])

  await page.keyboard.press(caret.lineStart)
  await settleSelection(page)
  await page.keyboard.press('Backspace')
  await expect
    .poll(async () => (await paragraphs(page.request, deckId, objectId))[1])
    .toEqual(['Two', 'bullet', 0])
  await page.keyboard.press('Backspace')
  await expect
    .poll(async () => (await paragraphs(page.request, deckId, objectId)).map((p) => p[0]))
    .toEqual(['OneTwo'])
  // The caret stays where the paragraphs met: typing lands between them.
  await page.keyboard.type('-')
  await expect
    .poll(async () => (await paragraphs(page.request, deckId, objectId)).map((p) => p[0]))
    .toEqual(['One-Two'])
})

test('Enter on an empty list item ends the list', async ({ page }) => {
  const { deckId, objectId } = await editBox(page, `list end ${Date.now()}`, {
    paragraphs: [{ list: 'number', text: 'First' }],
  })
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('After the list')
  await expect
    .poll(() => paragraphs(page.request, deckId, objectId))
    .toEqual([
      ['First', 'number', 0],
      ['After the list', null, 0],
    ])
})

test('a pasted blank line becomes a new paragraph', async ({ page }) => {
  const { deckId, objectId, editor } = await editBox(page, `paste ${Date.now()}`, 'Start')
  await editor.evaluate((el) => {
    const data = new DataTransfer()
    data.setData('text/plain', ' of it\n\nNext paragraph')
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  })
  await expect
    .poll(async () => (await paragraphs(page.request, deckId, objectId)).map((p) => p[0]))
    .toEqual(['Start of it', 'Next paragraph'])
  // The editor shows the model: typing continues the new paragraph.
  await page.keyboard.type('!')
  await expect
    .poll(async () => (await paragraphs(page.request, deckId, objectId)).map((p) => p[0]))
    .toEqual(['Start of it', 'Next paragraph!'])
})
