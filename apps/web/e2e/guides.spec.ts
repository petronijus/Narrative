/**
 * e2e/guides.spec.ts
 *
 * Alignment guides with a real pointer: drag one out of a ruler, move it,
 * drag it off the slide to delete it, delete one from its context menu.
 * Every gesture is a `guide.*` command (A2.3); the result is read back from
 * the document through the command API, so the spec checks what was
 * stored, not what was drawn.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

interface Guide {
  id: string
  orientation: 'horizontal' | 'vertical'
  position: number
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

async function guidesOf(request: APIRequestContext, deckId: string): Promise<Guide[]> {
  const outline = await command<{ guides: Guide[] }>(request, { deckId }, 'query.deck', {})
  return outline.guides
}

/** Drag with the real mouse from one viewport point to another, in steps. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 })
  await page.mouse.move(to.x, to.y, { steps: 5 })
  await page.mouse.up()
}

test('guides: drag out of a ruler, move, drag off the slide, delete from the menu', async ({
  page,
}) => {
  // Rulers are off by default; they remember their state per tab.
  await page.addInitScript(() => sessionStorage.setItem('narrative:rulers:visible', '1'))
  const { id: deckId } = await command<{ id: string }>(page.request, {}, 'deck.create', {
    title: `guides ${Date.now()}`,
  })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`/deck/${deckId}`)
  const artboard = page.locator('[data-artboard-root="1"]')
  await expect(artboard).toBeVisible({ timeout: 30_000 })
  // The whole slide and both rulers on screen (the zoom cluster opens on hover).
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
  await page.getByRole('button', { name: 'Fit to screen' }).click()
  await page.waitForTimeout(400)
  const topRuler = page.locator('[data-ruler="top"]')
  const leftRuler = page.locator('[data-ruler="left"]')
  await expect(topRuler).toBeVisible()

  const box = (await artboard.boundingBox())!
  const top = (await topRuler.boundingBox())!
  const left = (await leftRuler.boundingBox())!
  /** Viewport point of a slide-space position (1920 × 1080). */
  const at = (sx: number, sy: number) => ({
    x: box.x + (sx / 1920) * box.width,
    y: box.y + (sy / 1080) * box.height,
  })

  // 1. Drag a horizontal guide out of the top ruler to a quarter of the height.
  await drag(page, { x: top.x + top.width / 2, y: top.y + top.height / 2 }, at(960, 270))
  await expect.poll(() => guidesOf(page.request, deckId)).toHaveLength(1)
  const [horizontal] = await guidesOf(page.request, deckId)
  expect(horizontal!.orientation).toBe('horizontal')
  expect(horizontal!.position).toBeCloseTo(270, -1)

  // 2. Move it to the middle.
  await drag(page, at(700, horizontal!.position), at(700, 540))
  await expect
    .poll(async () => (await guidesOf(page.request, deckId))[0]?.position ?? -1)
    .toBeGreaterThan(520)
  expect((await guidesOf(page.request, deckId))[0]!.position).toBeCloseTo(540, -1)

  // 3. Drag it off the slide: it is deleted.
  await drag(page, at(700, 540), { x: box.x + box.width / 2, y: box.y - 40 })
  await expect.poll(() => guidesOf(page.request, deckId)).toHaveLength(0)

  // 4. A vertical guide from the left ruler, deleted from its context menu.
  await drag(page, { x: left.x + left.width / 2, y: left.y + left.height / 2 }, at(480, 540))
  await expect.poll(() => guidesOf(page.request, deckId)).toHaveLength(1)
  const [vertical] = await guidesOf(page.request, deckId)
  expect(vertical!.orientation).toBe('vertical')
  expect(vertical!.position).toBeCloseTo(480, -1)
  const line = at(vertical!.position, 300)
  await page.mouse.click(line.x, line.y, { button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete guide' }).click()
  await expect.poll(() => guidesOf(page.request, deckId)).toHaveLength(0)
})
