/**
 * e2e/route-load-failure.spec.ts — a lazy page whose code fails to download
 * shows a Retry / Reload card instead of a blank page (ui/RouteErrorBoundary,
 * ui/lazyRoute). Before, `net::ERR_NETWORK_CHANGED` on the DeckEditor chunk
 * unmounted the whole tree and the editor stayed white.
 *
 * The failure is a Playwright route abort on the module request (the dev
 * server serves each source file as its own module). Chrome caches a failed
 * module fetch for the life of the document, so these also pin down which
 * failures Retry can recover in place (the page's own chunk, through a
 * cache-busting URL) and which only Reload can (a failed dependency).
 */

import { expect, test, type Page } from '@playwright/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'

/** Abort the first `count` requests matching `pattern`, let the rest through. */
async function failFirstRequests(page: Page, pattern: string, count = 1): Promise<() => number> {
  let seen = 0
  await page.route(pattern, (route) => {
    seen += 1
    return seen <= count ? route.abort('internetdisconnected') : route.continue()
  })
  return () => seen
}

const failureCard = (page: Page) => page.getByRole('alert').filter({ hasText: /couldn.t load/ })

test.describe('route chunk load failure', () => {
  test('a failed page chunk shows the card, and Retry loads the page in place', async ({
    page,
  }) => {
    const requests = await failFirstRequests(page, '**/src/pages/AccessTokens.tsx*')
    await page.goto('/settings/access-tokens')

    const card = failureCard(page)
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: 'Retry' })).toBeFocused()

    await card.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByRole('heading', { name: 'Access tokens', exact: true })).toBeVisible()
    await expect(card).toHaveCount(0)
    // In place: the retry fetched the module again, the document stayed.
    expect(requests()).toBeGreaterThanOrEqual(2)
  })

  test('the deck editor recovers the same way', async ({ page }) => {
    const res = await page.request.post(`${API_BASE}/decks`, {
      data: { title: 'e2e-route-load-failure' },
    })
    expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
    const { id: deckId } = (await res.json()) as { id: string }
    try {
      await failFirstRequests(page, '**/src/pages/DeckEditor.tsx*')
      await page.goto(`/deck/${deckId}`)

      const card = failureCard(page)
      await expect(card).toBeVisible()
      await card.getByRole('button', { name: 'Retry' }).click()

      await expect(card).toHaveCount(0)
      await expect
        .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
        .toBe('object')
      await expect(page.locator('canvas').first()).toBeVisible()
    } finally {
      await page.request.delete(`${API_BASE}/decks/${deckId}`).catch(() => undefined)
    }
  })

  test('a failed dependency needs a reload: Retry says so, Reload recovers', async ({ page }) => {
    // A module the page imports, not the page itself: Chrome keeps the failed
    // dependency in the module map, so no in-page retry can fetch it again.
    await failFirstRequests(page, '**/src/pages/accessTokenList.ts*')
    await page.goto('/settings/access-tokens')

    const card = failureCard(page)
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: 'Retry' }).click()

    await expect(card).toContainText('Retrying didn’t help')
    const reload = card.getByRole('button', { name: 'Reload' })
    await expect(reload).toBeFocused()
    await reload.click()
    await expect(page.getByRole('heading', { name: 'Access tokens', exact: true })).toBeVisible()
  })

  test('after a deploy the page reloads once to pick it up, never in a loop', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible()

    // A deploy lands while the tab is open: the server now advertises another
    // build, and the chunk the running bundle asks for is gone for good.
    const newBuild = 'e2e-newer-build'
    await page.route('**/version.json', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ version: newBuild }),
      }),
    )
    await page.route('**/src/pages/AccessTokens.tsx*', (route) =>
      route.abort('internetdisconnected'),
    )
    let documentLoads = 0
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documentLoads += 1
    })

    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'Access tokens' }).click()

    // One reload for the new build; the chunk is still missing after it, and
    // the guard remembers it already reloaded for this version — the card.
    const card = failureCard(page)
    await expect(card).toBeVisible({ timeout: 15_000 })
    expect(documentLoads).toBe(1)
    expect(
      await page.evaluate(() => sessionStorage.getItem('narrative:version-guard:reloaded-for')),
    ).toBe(newBuild)
  })
})
