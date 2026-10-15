/**
 * e2e/path-editing.spec.ts
 *
 * Point-drawn objects with a real pointer (A2.6): draw a path with the pen,
 * turn a rectangle into a path and drag one of its corners, drag the end of
 * a rotated line. Each gesture is an `object.path.*` / `object.line.*`
 * command; the result is read back from the document through the command
 * API, so the spec checks what was stored — and, for the rotated line,
 * that the handles sit where the line is drawn.
 */

import { test, expect, type APIRequestContext, type Page } from './fixtures/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

type Obj = Record<string, unknown> & {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
}
interface Pt {
  x: number
  y: number
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

async function objectsOf(request: APIRequestContext, deckId: string): Promise<Obj[]> {
  const slide = await command<{ objects: Obj[] }>(request, { deckId }, 'query.slide', {
    slide: { index: 0 },
  })
  return slide.objects
}

/** Where a local point of an unmirrored object is drawn (rotation about the box centre). */
function drawnAt(o: Obj, p: Pt): Pt {
  const cx = o.x + o.width / 2
  const cy = o.y + o.height / 2
  const lx = p.x - o.width / 2
  const ly = p.y - o.height / 2
  const cos = Math.cos(o.rotation)
  const sin = Math.sin(o.rotation)
  return { x: cx + cos * lx - sin * ly, y: cy + sin * lx + cos * ly }
}

/** Pointer positions map to slide px through the zoom: allow a few px. */
const near = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) < 3 && Math.abs(a.y - b.y) < 3

async function drag(page: Page, from: Pt, to: Pt) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 })
  await page.mouse.move(to.x, to.y, { steps: 5 })
  await page.mouse.up()
}

async function openDeck(page: Page, title: string) {
  const { id: deckId } = await command<{ id: string }>(page.request, {}, 'deck.create', { title })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`/deck/${deckId}`)
  const artboard = page.locator('.artboard')
  await expect(artboard).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
  await page.getByRole('button', { name: 'Fit to screen' }).click()
  await page.waitForTimeout(400)
  const box = (await artboard.boundingBox())!
  const scale = box.width / 1920
  /** Viewport point of a slide-space position (1920 × 1080). */
  const at = (p: Pt): Pt => ({ x: box.x + p.x * scale, y: box.y + p.y * scale })
  /** Slide-space point of a viewport position. */
  const slideAt = (p: Pt): Pt => ({ x: (p.x - box.x) / scale, y: (p.y - box.y) / scale })
  return { deckId, at, slideAt, scale }
}

test('pen: clicks then Enter draw a path through the clicked points', async ({ page }) => {
  const { deckId, at } = await openDeck(page, `pen ${Date.now()}`)
  const points = [
    { x: 400, y: 300 },
    { x: 800, y: 500 },
    { x: 500, y: 700 },
  ]
  await page.keyboard.press('p')
  for (const p of points) {
    const v = at(p)
    await page.mouse.click(v.x, v.y)
  }
  await page.keyboard.press('Enter')

  await expect.poll(async () => (await objectsOf(page.request, deckId)).length).toBe(1)
  const [path] = await objectsOf(page.request, deckId)
  expect(path!.type).toBe('path')
  const drawn = (path!['anchors'] as Pt[]).map((a) => drawnAt(path!, a))
  drawn.forEach((d, i) => {
    expect(Math.abs(d.x - points[i]!.x)).toBeLessThan(3)
    expect(Math.abs(d.y - points[i]!.y)).toBeLessThan(3)
  })
})

test('double-clicking a rectangle makes it a path; dragging a corner moves only that corner', async ({
  page,
}) => {
  const { deckId, at } = await openDeck(page, `to path ${Date.now()}`)
  const { objectId } = await command<{ objectId: string }>(
    page.request,
    { deckId },
    'object.create',
    {
      slide: { index: 0 },
      object: { type: 'rectangle', x: 600, y: 300, width: 400, height: 300, fill: '#2e86ab' },
    },
  )
  await expect.poll(async () => (await objectsOf(page.request, deckId)).length).toBe(1)

  const centre = at({ x: 800, y: 450 })
  await page.mouse.dblclick(centre.x, centre.y)
  await expect.poll(async () => (await objectsOf(page.request, deckId))[0]!.type).toBe('path')
  const [path] = await objectsOf(page.request, deckId)
  expect(path!.id).toBe(objectId)

  const handles = page.locator('[data-path-points-handle="true"]')
  await expect(handles).toHaveCount(4)
  // The top-right corner (outline order TL, TR, BR, BL) to 1100, 200.
  const from = at({ x: 1000, y: 300 })
  const to = at({ x: 1100, y: 200 })
  await drag(page, from, to)

  await expect
    .poll(async () => {
      const [p] = await objectsOf(page.request, deckId)
      return near(drawnAt(p!, (p!['anchors'] as Pt[])[1]!), { x: 1100, y: 200 })
    })
    .toBe(true)
  const [after] = await objectsOf(page.request, deckId)
  const corners = (after!['anchors'] as Pt[]).map((a) => drawnAt(after!, a))
  expect(corners[0]!.x).toBeCloseTo(600, 0)
  expect(corners[0]!.y).toBeCloseTo(300, 0)
  expect(corners[2]!.x).toBeCloseTo(1000, 0)
  expect(corners[2]!.y).toBeCloseTo(600, 0)
})

test('a rotated line: the end handles sit on its drawn ends and a drag moves that end', async ({
  page,
}) => {
  const { deckId, at, slideAt } = await openDeck(page, `line ${Date.now()}`)
  await command(page.request, { deckId }, 'object.create', {
    slide: { index: 0 },
    object: {
      type: 'line',
      x: 600,
      y: 600,
      width: 400,
      height: 0,
      p1: { x: 0, y: 0 },
      p2: { x: 400, y: 0 },
      rotation: Math.PI / 6,
      stroke: '#1b2a4a',
      strokeWidth: 8,
    },
  })
  await expect.poll(async () => (await objectsOf(page.request, deckId)).length).toBe(1)
  const [line] = await objectsOf(page.request, deckId)
  const end1 = drawnAt(line!, line!['p1'] as Pt)
  const end2 = drawnAt(line!, line!['p2'] as Pt)

  const mid = at({ x: 800, y: 600 })
  await page.mouse.click(mid.x, mid.y)
  const handles = page.getByLabel('Line endpoint')
  await expect(handles).toHaveCount(2)
  for (const [i, end] of [end1, end2].entries()) {
    const b = (await handles.nth(i).boundingBox())!
    const onSlide = slideAt({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
    expect(Math.abs(onSlide.x - end.x)).toBeLessThan(3)
    expect(Math.abs(onSlide.y - end.y)).toBeLessThan(3)
  }

  await drag(page, at(end2), at({ x: 1300, y: 400 }))
  await expect
    .poll(async () => {
      const [l] = await objectsOf(page.request, deckId)
      return near(drawnAt(l!, l!['p2'] as Pt), { x: 1300, y: 400 })
    })
    .toBe(true)
  const [after] = await objectsOf(page.request, deckId)
  const start = drawnAt(after!, after!['p1'] as Pt)
  expect(start.x).toBeCloseTo(end1.x, 0)
  expect(start.y).toBeCloseTo(end1.y, 0)
})
