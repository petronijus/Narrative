/**
 * e2e/folder-thumbnails-lazy.spec.ts
 *
 * A folder page fetches the thumbnails near the viewport, not all of them. A
 * folder of hundreds that fetched every card up front kept the browser's
 * connections to the server busy, and opening a deck from it waited behind that
 * queue for seconds (measured in the Tauri window, 2026-11-06: 659 requests after
 * the click, the slide on screen after 3.5 s; 26 requests and 0.5 s once lazy).
 */

import { expect, test } from './fixtures/test'
import { API_BASE } from './perf/lib/seed'

const DECKS = 120
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg=='

test('a large folder fetches only the thumbnails near the viewport', async ({ page }) => {
  test.setTimeout(120_000)
  const api = page.request
  const folder = await api.post(`${API_BASE}/folders`, {
    data: { name: `lazy thumbnails ${Date.now()}` },
  })
  expect(folder.ok()).toBe(true)
  const { id: folderId } = (await folder.json()) as { id: string }

  const seedDeck = async (i: number): Promise<void> => {
    const deck = await api.post(`${API_BASE}/decks`, { data: { title: `deck ${i}`, folderId } })
    expect(deck.ok()).toBe(true)
    const { id } = (await deck.json()) as { id: string }
    const thumb = await api.put(`${API_BASE}/decks/${id}/thumbnail`, {
      data: { dataUrl: PNG_1PX },
    })
    expect(thumb.ok(), `thumbnail: ${thumb.status()}`).toBe(true)
  }
  for (let i = 0; i < DECKS; i += 8)
    await Promise.all(Array.from({ length: 8 }, (_, k) => seedDeck(i + k)))

  const fetched = new Set<string>()
  page.on('request', (r) => {
    if (r.resourceType() === 'image' && r.url().includes('/thumb-')) fetched.add(r.url())
  })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/folder/${folderId}`)

  // Every card arrives (the list pages in behind the first page) …
  await expect(page.locator('img[src*="/thumb-"]')).toHaveCount(DECKS, { timeout: 30_000 })
  // … the first ones load, and the browser has had the time to start the rest if it were going to.
  await expect
    .poll(() =>
      page
        .locator('img[src*="/thumb-"]')
        .first()
        .evaluate((i: HTMLImageElement) => i.naturalWidth),
    )
    .toBeGreaterThan(0)
  await page.waitForLoadState('networkidle')

  expect(fetched.size).toBeGreaterThan(0)
  expect(fetched.size, 'thumbnails fetched while most cards are far below the fold').toBeLessThan(
    DECKS,
  )
})
