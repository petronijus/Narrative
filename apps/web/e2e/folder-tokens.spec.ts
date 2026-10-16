/**
 * e2e/folder-tokens.spec.ts
 *
 * A folder's design tokens change on the server (A2.12): Folder Settings and
 * the Inspector's preset actions call the token routes, the server writes
 * the folder document and carries a text-style change into every deck of
 * the folder — the one open in another tab and the one nobody has open. The
 * editor itself writes no folder document. Results are read back through the
 * command API (`query.object`, `token.list`).
 *
 * A colour token changes nothing in the decks that link to it — they hold
 * `{ $token }` — so the open canvas has to repaint on the folder document's
 * change alone (renderer/colourResolver.ts). That one is read off the pixels.
 */

import { test, expect, type APIRequestContext, type Page } from './fixtures/test'
import { PNG } from 'pngjs'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

const BOX = { x: 300, y: 300, width: 1000, height: 200 }

interface TextView {
  fontSize?: number
  textStyleId?: string
  textStyleOverrides?: string[]
}
interface TextStyle {
  id: string
  name: string
  size?: number
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

const textOf = async (request: APIRequestContext, deckId: string, id: string) =>
  (
    await command<{ object: TextView }>(request, { deckId }, 'query.object', {
      slide: { index: 0 },
      object: id,
    })
  ).object

const stylesOf = async (request: APIRequestContext, folderId: string) =>
  (await command<{ textStyles: TextStyle[] }>(request, { folderId }, 'token.list', {})).textStyles

/** A deck in `folderId` with one text box (48 px), optionally linked to a text style by name. */
async function deckWithText(
  request: APIRequestContext,
  folderId: string,
  title: string,
  style?: string,
) {
  const { id: deckId } = await command<{ id: string }>(request, {}, 'deck.create', {
    title,
    folderId,
  })
  const { objectId } = await command<{ objectId: string }>(request, { deckId }, 'object.create', {
    slide: { index: 0 },
    object: { type: 'text', ...BOX, text: 'Quarterly results', fontSize: 48, fontWeight: 400 },
  })
  if (style !== undefined)
    await command(request, { deckId }, 'text.style.apply', {
      slide: { index: 0 },
      objects: [objectId],
      style,
    })
  return { deckId, objectId }
}

/** Open a deck at 1920 x 1080 and select `objectId`. */
async function openDeck(page: Page, deckId: string, objectId: string) {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`/deck/${deckId}`)
  await expect(page.locator('.artboard')).toBeVisible({ timeout: 30_000 })
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
  await page.evaluate((id) => window.__narrative_test_api!.setSelection([id]), objectId)
}

test('a text style changed in Folder Settings reaches the open and the closed deck', async ({
  page,
  context,
}) => {
  const { id: folderId } = await command<{ id: string }>(page.request, {}, 'folder.create', {
    name: `Tokens e2e ${Date.now()}`,
  })
  const open = await deckWithText(page.request, folderId, 'open deck', 'Body')
  const closed = await deckWithText(page.request, folderId, 'closed deck', 'Body')
  const body = (await stylesOf(page.request, folderId)).find((s) => s.name === 'Body')!
  // A new folder comes with its default styles, seeded on the server.
  expect(body).toBeDefined()
  const target = (body.size ?? 24) + 7

  await openDeck(page, open.deckId, open.objectId)

  const settings = await context.newPage()
  await settings.goto(`/folder/${folderId}/settings?tab=textStyles`)
  await settings.getByRole('option', { name: /Body/ }).click()
  await settings.getByLabel('Font size').fill(String(target))

  await expect
    .poll(async () => (await textOf(page.request, open.deckId, open.objectId)).fontSize, {
      timeout: 15_000,
    })
    .toBe(target)
  await expect
    .poll(async () => (await textOf(page.request, closed.deckId, closed.objectId)).fontSize, {
      timeout: 15_000,
    })
    .toBe(target)
  // The style itself took the change.
  expect((await stylesOf(page.request, folderId)).find((s) => s.id === body.id)?.size).toBe(target)
})

test("the Inspector makes a style from a box and pushes the box's look into it", async ({
  page,
}) => {
  const { id: folderId } = await command<{ id: string }>(page.request, {}, 'folder.create', {
    name: `Presets e2e ${Date.now()}`,
  })
  const { deckId, objectId } = await deckWithText(page.request, folderId, 'preset deck')
  const other = await deckWithText(page.request, folderId, 'other deck')
  await openDeck(page, deckId, objectId)

  // Create new text style → the box is linked to it exactly.
  await page.getByRole('button', { name: 'Preset actions' }).click()
  await page.getByRole('menuitem', { name: 'Create new text style' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create new text style' })
  await dialog.locator('#new-preset-name').fill('Quote e2e')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  const quote = (await stylesOf(page.request, folderId)).find((s) => s.name === 'Quote e2e')!
  expect(quote).toMatchObject({ size: 48 })
  await expect
    .poll(async () => (await textOf(page.request, deckId, objectId)).textStyleId)
    .toBe(quote.id)

  // Another deck's box takes the style; then the first box is set by hand…
  await command(page.request, { deckId: other.deckId }, 'text.style.apply', {
    slide: { index: 0 },
    objects: [other.objectId],
    style: quote.id,
  })
  await command(page.request, { deckId }, 'text.setBoxTypography', {
    slide: { index: 0 },
    objects: [objectId],
    style: { fontSize: 60 },
  })
  await expect
    .poll(async () => (await textOf(page.request, deckId, objectId)).textStyleOverrides)
    .toEqual(['fontSize'])

  // …and Update preset makes that the style's, everywhere it is linked.
  await page.getByRole('button', { name: 'Preset actions' }).click()
  await page.getByRole('menuitem', { name: 'Update preset' }).click()
  await expect
    .poll(
      async () => (await stylesOf(page.request, folderId)).find((s) => s.id === quote.id)?.size,
      {
        timeout: 15_000,
      },
    )
    .toBe(60)
  await expect
    .poll(async () => (await textOf(page.request, other.deckId, other.objectId)).fontSize, {
      timeout: 15_000,
    })
    .toBe(60)
  // The box matches its style exactly again.
  await expect
    .poll(async () => (await textOf(page.request, deckId, objectId)).textStyleOverrides ?? [])
    .toEqual([])
})

// ---------------------------------------------------------------------------
// A colour token edited while a deck linking to it is open
// ---------------------------------------------------------------------------

/** Hot pink and cyan: neither is in the editor chrome or the default palette. */
const PINK = { hex: '#ff2bd6', r: 0xff, g: 0x2b, b: 0xd6 }
const CYAN = { hex: '#00c8ff', r: 0x00, g: 0xc8, b: 0xff }
type Rgb = { r: number; g: number; b: number }

/** Slide-space regions, each painted by one token-linked colour slot. */
const REGIONS = {
  // rectangle fill
  fill: { x: 80, y: 80, width: 480, height: 300 },
  // ellipse stroke (the white fill inside is not the token's)
  stroke: { x: 680, y: 80, width: 480, height: 300 },
  // text colour
  text: { x: 1280, y: 80, width: 560, height: 300 },
  // one table cell's fill
  cell: { x: 80, y: 560, width: 600, height: 400 },
  // the offset strip of a rectangle's drop shadow (the rectangle is white)
  shadow: { x: 1100, y: 620, width: 70, height: 250 },
} as const
type Region = keyof typeof REGIONS

function countColour(png: PNG, colour: Rgb): number {
  let count = 0
  for (let i = 0; i < png.data.length; i += 4) {
    if (
      Math.abs(png.data[i]! - colour.r) <= 12 &&
      Math.abs(png.data[i + 1]! - colour.g) <= 12 &&
      Math.abs(png.data[i + 2]! - colour.b) <= 12
    )
      count++
  }
  return count
}

/** Pixels of `colour` in each region of the live canvas (a page screenshot). */
async function colourByRegion(page: Page, colour: Rgb): Promise<Record<Region, number>> {
  const box = await page.locator('.artboard').boundingBox()
  if (box === null) throw new Error('no artboard')
  const scale = box.width / 1920
  const counts = {} as Record<Region, number>
  for (const [name, r] of Object.entries(REGIONS) as [Region, (typeof REGIONS)[Region]][]) {
    const shot = await page.screenshot({
      clip: {
        x: box.x + r.x * scale,
        y: box.y + r.y * scale,
        width: r.width * scale,
        height: r.height * scale,
      },
    })
    counts[name] = countColour(PNG.sync.read(shot), colour)
  }
  return counts
}

/** The share of the slide thumbnail's pixels that are `colour`. */
async function thumbnailShare(page: Page, colour: Rgb): Promise<number> {
  const dataUrl = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('img')).find(
        (el) => el.src.startsWith('data:image/png') && el.naturalWidth > 100,
      )?.src ?? null,
  )
  if (dataUrl === null) return 0
  const png = PNG.sync.read(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
  return countColour(png, colour) / (png.width * png.height)
}

const everyRegion = (min: number) =>
  Object.fromEntries(Object.keys(REGIONS).map((k) => [k, min])) as Record<Region, number>

test('a colour token changed while the deck is open repaints everything linked to it', async ({
  page,
}) => {
  const { id: folderId } = await command<{ id: string }>(page.request, {}, 'folder.create', {
    name: `Live colour e2e ${Date.now()}`,
  })
  try {
    const { tokenId } = await command<{ tokenId: string }>(
      page.request,
      { folderId },
      'token.create',
      { category: 'colors', name: 'Live pink', value: PINK.hex },
    )
    const ref = { $token: `colors.${tokenId}` }
    const { id: deckId } = await command<{ id: string }>(page.request, {}, 'deck.create', {
      title: 'live colour',
      folderId,
    })
    const create = (object: Record<string, unknown>) =>
      command<{ objectId: string }>(page.request, { deckId }, 'object.create', {
        slide: { index: 0 },
        object,
      })
    const ids: string[] = []
    ids.push((await create({ type: 'rectangle', ...REGIONS.fill, fill: ref })).objectId)
    ids.push(
      (
        await create({
          type: 'ellipse',
          ...REGIONS.stroke,
          fill: 0xffffff,
          stroke: ref,
          strokeWidth: 40,
        })
      ).objectId,
    )
    ids.push(
      (
        await create({
          type: 'text',
          ...REGIONS.text,
          text: 'MMM',
          fontSize: 200,
          fontWeight: 900,
          color: ref,
        })
      ).objectId,
    )
    ids.push(
      (
        await create({
          type: 'rectangle',
          x: 800,
          y: 560,
          width: 300,
          height: 300,
          fill: 0xffffff,
          shadow: { color: ref, blur: 0, offsetX: 60, offsetY: 60, opacity: 1 },
        })
      ).objectId,
    )
    const { objectId: tableId } = await command<{ objectId: string }>(
      page.request,
      { deckId },
      'table.insert',
      { slide: { index: 0 }, ...REGIONS.cell, rows: 1, cols: 1 },
    )
    ids.push(tableId)
    await command(page.request, { deckId }, 'table.style.cell', {
      slide: { index: 0 },
      table: tableId,
      cell: { row: 0, col: 0 },
      style: { fill: ref },
    })

    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(`/deck/${deckId}`)
    await expect(page.locator('.artboard')).toBeVisible({ timeout: 30_000 })
    // Fitted, the whole artboard sits between the panels: at 100 % its left
    // edge is under the slides panel, and the regions would count the
    // thumbnail there instead of the canvas.
    await page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
    await page.getByRole('button', { name: 'Fit to screen' }).click()
    await expect
      .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 15_000 })
      .toBe('object')
    for (const id of ids) {
      await expect
        .poll(
          () => page.evaluate((i) => window.__narrative_test_api!.sceneGraphHasMountedNode(i), id),
          { timeout: 8000 },
        )
        .toBe(true)
    }

    // Every slot paints the folder's pink, on the canvas and in the thumbnail.
    await expect
      .poll(
        async () => {
          const counts = await colourByRegion(page, PINK)
          return Object.fromEntries(
            Object.entries(counts).map(([k, n]) => [k, Math.min(n, 1000)]),
          ) as Record<Region, number>
        },
        { timeout: 15_000 },
      )
      .toEqual(everyRegion(1000))
    await expect.poll(() => thumbnailShare(page, PINK), { timeout: 15_000 }).toBeGreaterThan(0.02)

    // The palette changes on the server; the deck document does not.
    await command(page.request, { folderId }, 'token.update', {
      category: 'colors',
      tokenId,
      value: CYAN.hex,
    })

    // Every slot follows — and no pink is left anywhere it was.
    await expect
      .poll(
        async () => {
          const counts = await colourByRegion(page, CYAN)
          return Object.fromEntries(
            Object.entries(counts).map(([k, n]) => [k, Math.min(n, 1000)]),
          ) as Record<Region, number>
        },
        { timeout: 15_000 },
      )
      .toEqual(everyRegion(1000))
    expect(await colourByRegion(page, PINK)).toEqual(everyRegion(0))
    await expect.poll(() => thumbnailShare(page, CYAN), { timeout: 15_000 }).toBeGreaterThan(0.02)
    expect(await thumbnailShare(page, PINK)).toBe(0)
  } finally {
    const res = await page.request.delete(`${API_BASE}/folders/${folderId}`)
    expect(res.ok() || res.status() === 404, `DELETE /folders/${folderId}`).toBe(true)
  }
})
