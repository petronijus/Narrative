/**
 * e2e/table-commands.spec.ts
 *
 * Table gestures with a real pointer and keyboard (A2.10): the chrome, the
 * Inspector and the cell editor write only through commands —
 * `table.resizeColumn` (keepTableSize) for a boundary drag, `table.setSize`
 * for the add / remove handles and the steppers, `object.update` for the
 * move handle, `object.fill.gradient` for a gradient on the whole table or
 * on the selected cells, `table.row.insert` for Tab past the last cell.
 * Results are read back through the command API, so the spec checks what
 * was stored, and a gesture stays one undo step.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

/** The table every test starts from: 3 x 3 cells of 300 x 100 px. */
const TABLE = { x: 300, y: 300, width: 900, height: 300 }

interface Pt {
  x: number
  y: number
}

interface TableView {
  x: number
  y: number
  width: number
  height: number
  colWidths: number[]
  rowHeights: number[]
  rows: Array<Array<Record<string, unknown>>>
  defaults: Record<string, unknown>
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

async function tableOf(request: APIRequestContext, deckId: string, id: string) {
  const slide = await command<{ objects: Array<Record<string, unknown>> }>(
    request,
    { deckId },
    'query.slide',
    { slide: { index: 0 } },
  )
  return slide.objects.find((o) => o['id'] === id) as unknown as TableView
}

async function drag(page: Page, from: Pt, to: Pt) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 })
  await page.mouse.move(to.x, to.y, { steps: 5 })
  await page.mouse.up()
}

async function centre(page: Page, selector: ReturnType<Page['locator']>): Promise<Pt> {
  await expect(selector).toBeVisible()
  const box = (await selector.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

const near = (a: readonly number[], b: readonly number[], tolerance = 3): boolean =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) <= tolerance)

/**
 * A deck with one 3 x 3 table, opened at 1920 x 1080 and fitted; the table
 * is selected. Returns the deck, the table id and a slide-px → screen
 * mapping.
 */
async function openTable(page: Page, title: string) {
  const { id: deckId } = await command<{ id: string }>(page.request, {}, 'deck.create', { title })
  const { objectId: tableId } = await command<{ objectId: string }>(
    page.request,
    { deckId },
    'table.insert',
    { slide: { index: 0 }, ...TABLE, rows: 3, cols: 3 },
  )
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
        page.evaluate((id) => window.__narrative_test_api!.sceneGraphHasMountedNode(id), tableId),
      { timeout: 8000 },
    )
    .toBe(true)
  await page.evaluate((id) => window.__narrative_test_api!.setSelection([id]), tableId)
  await expect(page.getByTestId('table-chrome')).toBeVisible()
  const box = (await artboard.boundingBox())!
  const scale = box.width / 1920
  const toScreen = (p: Pt): Pt => ({ x: box.x + p.x * scale, y: box.y + p.y * scale })
  return { deckId, tableId, scale, toScreen }
}

test('dragging a column boundary moves width between the two columns, as one undo step', async ({
  page,
}) => {
  const { deckId, tableId, scale } = await openTable(page, `table boundary ${Date.now()}`)
  const boundary = page.locator('[data-testid="table-chrome"] [style*="col-resize"]').first()
  const from = await centre(page, boundary)
  await drag(page, from, { x: from.x + 100 * scale, y: from.y })

  await expect
    .poll(async () =>
      near((await tableOf(page.request, deckId, tableId)).colWidths, [400, 200, 300]),
    )
    .toBe(true)
  expect((await tableOf(page.request, deckId, tableId)).width).toBeCloseTo(900, 6)

  await page.keyboard.press('Control+z')
  await expect
    .poll(async () =>
      near((await tableOf(page.request, deckId, tableId)).colWidths, [300, 300, 300]),
    )
    .toBe(true)
})

test('the add-column handle adds and removes columns at the right', async ({ page }) => {
  const { deckId, tableId, scale } = await openTable(page, `table add column ${Date.now()}`)
  const handle = page.getByRole('button', { name: 'Add or remove columns' })
  let from = await centre(page, handle)
  await drag(page, from, { x: from.x + 300 * scale, y: from.y })
  await expect
    .poll(async () => (await tableOf(page.request, deckId, tableId)).colWidths.length)
    .toBe(4)
  expect((await tableOf(page.request, deckId, tableId)).width).toBeCloseTo(1200, 6)

  // Two average columns (300 px each) to the left: 4 → 2.
  from = await centre(page, handle)
  await drag(page, from, { x: from.x - 600 * scale, y: from.y })
  await expect
    .poll(async () => (await tableOf(page.request, deckId, tableId)).colWidths.length)
    .toBe(2)
  const t = await tableOf(page.request, deckId, tableId)
  expect(t.width).toBeCloseTo(600, 6)
  expect(t.rows.every((row) => row.length === 2)).toBe(true)
})

test('the move handle moves the table', async ({ page }) => {
  const { deckId, tableId, scale } = await openTable(page, `table move ${Date.now()}`)
  const from = await centre(page, page.getByRole('button', { name: 'Move table' }))
  await drag(page, from, { x: from.x + 200 * scale, y: from.y + 100 * scale })
  await expect
    .poll(async () => {
      const t = await tableOf(page.request, deckId, tableId)
      return near([t.x, t.y], [TABLE.x + 200, TABLE.y + 100])
    })
    .toBe(true)
  expect((await tableOf(page.request, deckId, tableId)).width).toBe(TABLE.width)
})

test('the Rows stepper adds a row at the bottom', async ({ page }) => {
  const { deckId, tableId } = await openTable(page, `table rows ${Date.now()}`)
  // Structure: Rows then Columns, each a − / + pair.
  await page.getByRole('button', { name: 'Increase' }).first().click()
  await expect
    .poll(async () => (await tableOf(page.request, deckId, tableId)).rowHeights.length)
    .toBe(4)
  expect((await tableOf(page.request, deckId, tableId)).height).toBeCloseTo(400, 6)
})

test("a gradient with nothing but the table selected paints every cell, replacing cells' own", async ({
  page,
}) => {
  const { deckId, tableId } = await openTable(page, `table gradient ${Date.now()}`)
  await command(page.request, { deckId }, 'table.style.cell', {
    slide: { index: 0 },
    table: tableId,
    cell: { row: 1, col: 1 },
    style: {
      fillStyle: {
        kind: 'radialGradient',
        stops: [
          { color: '#000000', offset: 0 },
          { color: '#ffffff', offset: 1 },
        ],
      },
    },
  })
  await page.getByLabel('Fill type').selectOption('linearGradient')
  await expect
    .poll(
      async () =>
        ((await tableOf(page.request, deckId, tableId)).defaults['fillStyle'] as { kind?: string })
          ?.kind,
    )
    .toBe('linearGradient')
  const t = await tableOf(page.request, deckId, tableId)
  // A table without a fill starts from white and its 0.55 tint.
  expect((t.defaults['fillStyle'] as { stops: unknown }).stops).toEqual([
    { color: '#ffffff', offset: 0 },
    { color: '#8c8c8c', offset: 1 },
  ])
  expect(t.rows[1]![1]!['fillStyle']).toBeUndefined()
})

test('a gradient with a column selected fills only that column', async ({ page }) => {
  const { deckId, tableId } = await openTable(page, `table column gradient ${Date.now()}`)
  await page.locator('[data-col-letter="1"]').click()
  await page.getByLabel('Fill type').selectOption('radialGradient')
  await expect
    .poll(async () =>
      (await tableOf(page.request, deckId, tableId)).rows.map(
        (row) => (row[1]!['fillStyle'] as { kind?: string } | undefined)?.kind,
      ),
    )
    .toEqual(['radialGradient', 'radialGradient', 'radialGradient'])
  const t = await tableOf(page.request, deckId, tableId)
  expect(t.defaults['fillStyle']).toBeUndefined()
  expect(t.rows.map((row) => row[0]!['fillStyle'])).toEqual([undefined, undefined, undefined])
})

test('Typography with a column selected styles those cells, not the table', async ({ page }) => {
  const { deckId, tableId } = await openTable(page, `table typography ${Date.now()}`)
  await page.locator('[data-col-letter="0"]').click()
  await page
    .getByRole('group', { name: 'Horizontal alignment', exact: true })
    .getByRole('button', { name: 'Center' })
    .click()
  await expect
    .poll(async () =>
      (await tableOf(page.request, deckId, tableId)).rows.map((row) => row[0]!['align']),
    )
    .toEqual(['center', 'center', 'center'])
  const t = await tableOf(page.request, deckId, tableId)
  expect(t.defaults['align']).toBe('left')
  expect(t.rows.map((row) => row[1]!['align'])).toEqual([undefined, undefined, undefined])

  // One Inspector change, one undo step.
  await page.keyboard.press('Control+z')
  await expect
    .poll(async () =>
      (await tableOf(page.request, deckId, tableId)).rows.map((row) => row[0]!['align']),
    )
    .toEqual([undefined, undefined, undefined])
})

/** A small solid-colour PNG to upload. */
function solidPng(): Buffer {
  const png = new PNG({ width: 16, height: 16 })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 30
    png.data[i + 1] = 90
    png.data[i + 2] = 230
    png.data[i + 3] = 255
  }
  return PNG.sync.write(png)
}

test('Image fill on a table writes nothing until a picture is chosen, then fills the table', async ({
  page,
}) => {
  const { deckId, tableId } = await openTable(page, `table image fill ${Date.now()}`)
  await page.getByLabel('Fill type').selectOption('image')
  // The picker opens; an image fill without a picture is not a fill.
  const choose = page.getByText('Choose image…')
  await expect(choose).toBeVisible()
  await expect(page.getByLabel('Fill type')).toHaveValue('image')
  expect((await tableOf(page.request, deckId, tableId)).defaults['fillStyle']).toBeUndefined()

  const input = page.locator('input[type="file"][accept="image/*"]').last()
  await input.setInputFiles({ name: 'fill.png', mimeType: 'image/png', buffer: solidPng() })
  await expect
    .poll(
      async () =>
        (await tableOf(page.request, deckId, tableId)).defaults['fillStyle'] as
          | { kind?: string; assetId?: string }
          | undefined,
      { timeout: 20_000 },
    )
    .toMatchObject({ kind: 'image', assetId: expect.stringMatching(/.+/) })
  await expect(page.getByText('Replace image')).toBeVisible()
})

/** The plain text of every cell, row by row. */
async function cellTexts(request: APIRequestContext, deckId: string, tableId: string) {
  const t = await tableOf(request, deckId, tableId)
  return t.rows.map((row) => row.map((c) => (typeof c['text'] === 'string' ? c['text'] : '')))
}

const editor = (page: Page) =>
  page.getByTestId('table-cell-editor').locator('[contenteditable="true"]')

test('Tab into the next cell edits that cell, showing its own text', async ({ page }) => {
  const { deckId, tableId, toScreen } = await openTable(page, `table tab next ${Date.now()}`)
  for (const [col, text] of [
    [0, 'abc'],
    [1, 'xyz'],
  ] as const) {
    await command(page.request, { deckId }, 'text.set', {
      target: { slide: { index: 0 }, object: tableId, cell: { row: 0, col } },
      text,
    })
  }
  const first = toScreen({ x: TABLE.x + 150, y: TABLE.y + 50 })
  await page.mouse.dblclick(first.x, first.y)
  await expect(editor(page)).toBeFocused()
  await expect(editor(page)).toHaveText('abc')
  await page.keyboard.press('Tab')
  // The editor shows the new cell's body (it used to keep the previous
  // cell's, and the next keystroke wrote that into the new cell).
  await expect(editor(page)).toHaveText('xyz')
  await expect(editor(page)).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.type('1')
  await expect
    .poll(async () => (await cellTexts(page.request, deckId, tableId))[0])
    .toEqual(['abc', 'xyz1', ''])
})

test('Tab in the last cell adds a row and moves into it; typing at once lands there', async ({
  page,
}) => {
  const { deckId, tableId, toScreen } = await openTable(page, `table tab ${Date.now()}`)
  // The centre of the bottom-right cell.
  const cell = toScreen({ x: TABLE.x + 750, y: TABLE.y + 250 })
  await page.mouse.dblclick(cell.x, cell.y)
  await expect(editor(page)).toBeFocused()
  // No wait between Tab and typing: the new row reaches the editor's
  // snapshot a frame later, and the keystrokes must not fall in between.
  await page.keyboard.press('Tab')
  await page.keyboard.type('next')
  await expect
    .poll(async () => await cellTexts(page.request, deckId, tableId))
    .toEqual([
      ['', '', ''],
      ['', '', ''],
      ['', '', ''],
      ['next', '', ''],
    ])
})
