/**
 * e2e/animation-commands.spec.ts
 *
 * Animation gestures with a real pointer (A2.9): dragging a timeline bar
 * places the step at an absolute time (`animation.retime` derives the play
 * order, triggers and delays), dragging a bar's right edge sets its
 * duration, dragging the move-to handle sets a moveTo target
 * (`animation.update`). The result is read back from the document through
 * the command API, so the spec checks what was stored.
 */

import { test, expect, type APIRequestContext, type Page } from './fixtures/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

/** The timeline's default zoom (AnimationTimeline DEFAULT_PX_PER_SEC). */
const PX_PER_SEC = 80

interface Pt {
  x: number
  y: number
}
interface Step {
  id: string
  objectId: string
  preset: string
  trigger: string
  duration: number
  delay: number
  start: number
  params?: Record<string, unknown>
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

async function stepsOf(request: APIRequestContext, deckId: string): Promise<Step[]> {
  const slide = await command<{ animations: Step[] }>(request, { deckId }, 'query.slide', {
    slide: { index: 0 },
  })
  return slide.animations
}

async function drag(page: Page, from: Pt, to: Pt) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 })
  await page.mouse.move(to.x, to.y, { steps: 5 })
  await page.mouse.up()
}

/**
 * A deck with two rectangles, each animated for one second: A (fadeIn,
 * 0–1 s) then B (popIn, 1–2 s). Opens it at 1920 × 1080, fitted.
 */
async function openAnimatedDeck(page: Page, title: string) {
  const { id: deckId } = await command<{ id: string }>(page.request, {}, 'deck.create', { title })
  const target = { deckId }
  const create = (x: number, fill: string, name: string) =>
    command<{ objectId: string }>(page.request, target, 'object.create', {
      slide: { index: 0 },
      object: { type: 'rectangle', x, y: 300, width: 300, height: 200, fill, name },
    })
  const a = await create(300, '#e03c31', 'Card A')
  const b = await create(1000, '#2f6fed', 'Card B')
  await command(page.request, target, 'animation.add', {
    slide: { index: 0 },
    object: a.objectId,
    preset: 'fadeIn',
    duration: 1,
  })
  await command(page.request, target, 'animation.add', {
    slide: { index: 0 },
    object: b.objectId,
    preset: 'popIn',
    duration: 1,
  })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`/deck/${deckId}`)
  await expect(page.locator('.artboard')).toBeVisible({ timeout: 30_000 })
  return { deckId, a: a.objectId, b: b.objectId }
}

test('dragging a bar past its neighbour reorders the steps and derives their triggers', async ({
  page,
}) => {
  const { deckId, a, b } = await openAnimatedDeck(page, `retime ${Date.now()}`)
  const bar = page.getByRole('button', { name: 'Animation fadeIn, trigger afterPrevious' })
  await expect(bar).toBeVisible()
  const box = (await bar.boundingBox())!
  // Grab the middle of the bar (clear of the trigger picker on the left and
  // the resize grip on the right) and move it 1.5 s later: A now starts at
  // 1.5 s, inside B (1–2 s).
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await drag(page, from, { x: from.x + 1.5 * PX_PER_SEC, y: from.y })

  await expect
    .poll(async () => (await stepsOf(page.request, deckId)).map((s) => s.objectId))
    .toEqual([b, a])
  const steps = await stepsOf(page.request, deckId)
  expect(steps.map((s) => [s.trigger, s.start])).toEqual([
    ['afterPrevious', 1],
    ['withPrevious', 1.5],
  ])
  expect(steps[1]!.delay).toBeCloseTo(0.5, 6)
})

test("dragging a bar's right edge sets its duration; the next step follows", async ({ page }) => {
  const { deckId } = await openAnimatedDeck(page, `resize ${Date.now()}`)
  const grip = page.getByLabel('Resize fadeIn', { exact: true })
  await expect(grip).toBeVisible()
  const box = (await grip.boundingBox())!
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await drag(page, from, { x: from.x + 0.5 * PX_PER_SEC, y: from.y })

  await expect.poll(async () => (await stepsOf(page.request, deckId))[0]!.duration).toBe(1.5)
  const steps = await stepsOf(page.request, deckId)
  expect(steps.map((s) => s.start)).toEqual([0, 1.5])
})

test('dragging the move-to handle sets the target', async ({ page }) => {
  const { id: deckId } = await command<{ id: string }>(page.request, {}, 'deck.create', {
    title: `move to ${Date.now()}`,
  })
  const target = { deckId }
  const { objectId } = await command<{ objectId: string }>(page.request, target, 'object.create', {
    slide: { index: 0 },
    object: { type: 'rectangle', x: 200, y: 300, width: 300, height: 200, fill: '#1b2a4a' },
  })
  await command(page.request, target, 'animation.add', {
    slide: { index: 0 },
    object: objectId,
    preset: 'moveTo',
    params: { targetX: 960, targetY: 540 },
  })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`/deck/${deckId}`)
  const artboard = page.locator('.artboard')
  await expect(artboard).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
  await page.getByRole('button', { name: 'Fit to screen' }).click()
  await page.waitForTimeout(400)
  const scale = (await artboard.boundingBox())!.width / 1920

  // Selecting the step in the timeline shows its target handle.
  await page.getByRole('button', { name: 'Animation moveTo, trigger afterPrevious' }).click()
  const handle = page.getByRole('button', { name: 'Drag move-to target' })
  await expect(handle).toBeVisible()
  const box = (await handle.boundingBox())!
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await drag(page, from, { x: from.x + 300 * scale, y: from.y - 150 * scale })

  // Pointer positions map to slide px through the zoom: allow a few px.
  await expect
    .poll(async () => {
      const params = (await stepsOf(page.request, deckId))[0]!.params ?? {}
      const x = params['targetX'] as number
      const y = params['targetY'] as number
      return Math.abs(x - 1260) < 3 && Math.abs(y - 390) < 3
    })
    .toBe(true)
})
