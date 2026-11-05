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

/**
 * A deck with one text box holding `body` (and the box's own `fields`); opened, fitted, and in
 * edit mode with the caret at the end.
 */
async function editBox(
  page: Page,
  title: string,
  body: unknown,
  fields: Record<string, unknown> = {},
) {
  const { id: deckId } = await command<{ id: string }>(page.request, {}, 'deck.create', { title })
  const { objectId } = await command<{ objectId: string }>(
    page.request,
    { deckId },
    'object.create',
    { slide: { index: 0 }, object: { type: 'text', ...BOX, text: 'x', fontSize: 40, ...fields } },
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

test('a box underline is one line under each run, typed text and Inspector changes included', async ({
  page,
}) => {
  const { deckId, objectId, editor } = await editBox(
    page,
    `underline ${Date.now()}`,
    'Underlined',
    { underline: true },
  )
  /**
   * Each run of text in the editor with the number of underlines the page draws under it: one
   * per decorating box around it (a second, from the editor's root, stacked two antialiased
   * lines where the canvas draws one — ADR 0018).
   */
  const underlines = () =>
    editor.evaluate((root) => {
      root.normalize()
      const out: Array<[string, number]> = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        const text = n.nodeValue ?? ''
        if (text === '') continue
        let lines = 0
        for (let e = n.parentElement; e !== null; e = e.parentElement) {
          if (getComputedStyle(e).textDecorationLine.includes('underline')) lines += 1
          if (e === root) break
        }
        out.push([text, lines])
      }
      return out
    })
  expect(await underlines()).toEqual([['Underlined', 1]])

  // Typed into an empty paragraph, where the browser puts a bare text node.
  await page.keyboard.press('Enter')
  await page.keyboard.type('Typed')
  await expect.poll(underlines).toEqual([
    ['Underlined', 1],
    ['Typed', 1],
  ])
  // Over a selection the browser replaces with a bare text node.
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.type('ing')
  await expect.poll(underlines).toEqual([
    ['Underlined', 1],
    ['Typing', 1],
  ])

  // The box's underline changed while editing (the Inspector's toggle): the runs follow.
  await command(page.request, { deckId }, 'text.setBoxTypography', {
    slide: { index: 0 },
    objects: [objectId],
    style: { underline: false },
  })
  await expect.poll(underlines).toEqual([
    ['Underlined', 0],
    ['Typing', 0],
  ])
  // The caret stayed where it was.
  await expect(editor).toBeFocused()
  await page.keyboard.type('!')
  await expect
    .poll(async () => (await paragraphs(page.request, deckId, objectId)).map((p) => p[0]))
    .toEqual(['Underlined', 'Typing!'])
})

/** The body as `query.object` shows it: a soft break is "\n", a paragraph break "\n\n". */
async function bodyText(request: APIRequestContext, deckId: string, id: string) {
  const { object } = await command<{ object: { text: string } }>(
    request,
    { deckId },
    'query.object',
    { slide: { index: 0 }, object: id },
  )
  return object.text
}

/** Paragraph blocks and drawn lines of the editor (its height over one line's). */
async function shape(editor: ReturnType<Page['locator']>, lineHeight: number) {
  const { blocks, height } = await editor.evaluate((e) => ({
    blocks: e.querySelectorAll(':scope > div').length,
    height: e.getBoundingClientRect().height,
  }))
  return { blocks, lines: Math.round(height / lineHeight) }
}

/** Let the undo history close its step (the UndoManager's capture window). */
const closeStep = (page: Page) => page.waitForTimeout(700)

test('Shift+Enter breaks the line inside its paragraph, mid-text and at its end; undo and redo step through it', async ({
  page,
}) => {
  const { deckId, objectId, editor } = await editBox(page, `soft break ${Date.now()}`, 'One Two')
  const line = (await editor.boundingBox())!.height
  const state = async () => ({
    text: await bodyText(page.request, deckId, objectId),
    ...(await shape(editor, line)),
  })

  // At the paragraph's end: a line break, and the new line is there to type on.
  await page.keyboard.press('Shift+Enter')
  await expect.poll(state).toEqual({ text: 'One Two\n', blocks: 1, lines: 2 })
  await page.keyboard.type('Three')
  await expect.poll(state).toEqual({ text: 'One Two\nThree', blocks: 1, lines: 2 })
  await closeStep(page)

  // Mid-text.
  await page.keyboard.press(caret.textStart)
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+Enter')
  await expect.poll(state).toEqual({ text: 'One\n Two\nThree', blocks: 1, lines: 3 })
  await closeStep(page)

  // Several at the end.
  await page.keyboard.press(caret.textEnd)
  await page.keyboard.press('Shift+Enter')
  await closeStep(page)
  await page.keyboard.press('Shift+Enter')
  await expect.poll(state).toEqual({ text: 'One\n Two\nThree\n\n', blocks: 1, lines: 5 })
  await closeStep(page)

  // Undo, while editing, takes each step back; redo puts it again.
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(state).toEqual({ text: 'One\n Two\nThree\n', blocks: 1, lines: 4 })
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(state).toEqual({ text: 'One\n Two\nThree', blocks: 1, lines: 3 })
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(state).toEqual({ text: 'One Two\nThree', blocks: 1, lines: 2 })
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(state).toEqual({ text: 'One\n Two\nThree', blocks: 1, lines: 3 })
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(state).toEqual({ text: 'One\n Two\nThree\n', blocks: 1, lines: 4 })
  // The caret is where the redo put the break: typing lands on the new line.
  await expect(editor).toBeFocused()
  await page.keyboard.type('Four')
  await expect.poll(state).toEqual({ text: 'One\n Two\nThree\nFour', blocks: 1, lines: 4 })
})

test('select all and delete empties the box; typing starts it again; undo brings the text back', async ({
  page,
}) => {
  const { deckId, objectId, editor } = await editBox(page, `delete all ${Date.now()}`, {
    paragraphs: [{ text: 'First line' }, { text: 'Second' }],
  })
  const line = (await editor.boundingBox())!.height / 2
  const state = async () => ({
    text: await bodyText(page.request, deckId, objectId),
    ...(await shape(editor, line)),
  })
  await closeStep(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await expect.poll(state).toEqual({ text: '', blocks: 1, lines: 1 })
  await closeStep(page)
  await page.keyboard.type('New')
  await expect.poll(state).toEqual({ text: 'New', blocks: 1, lines: 1 })
  await closeStep(page)

  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(state).toEqual({ text: '', blocks: 1, lines: 1 })
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(state).toEqual({ text: 'First line\n\nSecond', blocks: 2, lines: 2 })
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(state).toEqual({ text: '', blocks: 1, lines: 1 })
})
