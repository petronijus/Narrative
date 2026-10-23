/**
 * e2e/route-load-failure.spec.ts — a lazy page whose code fails to download
 * shows a Retry / Reload card instead of a blank page (ui/RouteErrorBoundary,
 * ui/lazyRoute). Before, `net::ERR_NETWORK_CHANGED` on the DeckEditor chunk
 * unmounted the whole tree and the editor stayed white.
 *
 * The failure is a Playwright route abort on the module request (the dev
 * server serves each source file as its own module). Whether a browser keeps
 * a failed module fetch in the document's module map differs: Chrome 153
 * (Playwright's chromium-1243) did, so a failed dependency stayed failed
 * until a reload; Chrome 156 (chromium-1248, 2026-10-16) fetches it again on
 * the next import, so Retry recovers it in place. The specs therefore do not
 * lean on that cache: a load Retry cannot recover is one whose module is
 * still unreachable when Retry runs.
 *
 * A first load retries once by itself before the card (2026-10-23), with one
 * request (a caching browser: the cache-busting URL) or two (a browser that
 * fetches again: the loader, then the cache-busting URL). So a spec that
 * wants the card keeps the module unreachable until the card is up, instead
 * of counting requests; one aborted request must load the page with no card
 * at all.
 */

import { expect, test, type Page } from './fixtures/test'

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

/**
 * Abort every request matching `pattern` until the returned `restore` runs —
 * the automatic retry fails too, however many requests it makes. `aborted`
 * counts the requests turned away.
 */
async function failUntilRestored(
  page: Page,
  pattern: string,
): Promise<{ restore: () => void; aborted: () => number }> {
  let reachable = false
  let aborted = 0
  await page.route(pattern, (route) => {
    if (reachable) return route.continue()
    aborted += 1
    return route.abort('internetdisconnected')
  })
  return { restore: () => (reachable = true), aborted: () => aborted }
}

const failureCard = (page: Page) => page.getByRole('alert').filter({ hasText: /couldn.t load/ })

/** From the first document on: whether the failure card was ever in the DOM. */
async function watchForFailureCard(page: Page): Promise<() => Promise<boolean>> {
  await page.addInitScript(() => {
    const flag = '__narrative_route_card_seen'
    const check = () => {
      for (const alert of document.querySelectorAll('[role="alert"]')) {
        if (/couldn.t load/.test(alert.textContent ?? '')) {
          ;(window as unknown as Record<string, boolean>)[flag] = true
        }
      }
    }
    new MutationObserver(check).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    })
  })
  return () =>
    page.evaluate(
      () => (window as unknown as Record<string, boolean>)['__narrative_route_card_seen'] === true,
    )
}

test.describe('route chunk load failure', () => {
  test('one aborted page-chunk request: the automatic retry loads the page, no card', async ({
    page,
  }) => {
    const cardSeen = await watchForFailureCard(page)
    const requests = await failFirstRequests(page, '**/src/pages/AccessTokens.tsx*')
    let documentLoads = 0
    page.on('request', (request) => {
      if (request.resourceType() === 'document') documentLoads += 1
    })
    await page.goto('/settings/access-tokens')

    await expect(page.getByRole('heading', { name: 'Access tokens', exact: true })).toBeVisible()
    expect(await cardSeen()).toBe(false)
    // In place: the page module was requested again, the document was not.
    expect(requests()).toBeGreaterThanOrEqual(2)
    expect(documentLoads).toBe(1)
  })

  test('a page chunk the automatic retry cannot fetch shows the card, and Retry loads the page in place', async ({
    page,
  }) => {
    const chunk = await failUntilRestored(page, '**/src/pages/AccessTokens.tsx*')
    await page.goto('/settings/access-tokens')

    const card = failureCard(page)
    await expect(card).toBeVisible()
    await expect(card).toContainText('Part of Narrative didn’t download')
    await expect(card.getByRole('button', { name: 'Retry' })).toBeFocused()
    // The card came after the automatic retry, which asked for the module again.
    expect(chunk.aborted()).toBeGreaterThanOrEqual(2)

    chunk.restore()
    await card.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByRole('heading', { name: 'Access tokens', exact: true })).toBeVisible()
    await expect(card).toHaveCount(0)
  })

  test('the deck editor recovers the same way', async ({ page }) => {
    const res = await page.request.post(`${API_BASE}/decks`, {
      data: { title: 'e2e-route-load-failure' },
    })
    expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
    const { id: deckId } = (await res.json()) as { id: string }
    try {
      const chunk = await failUntilRestored(page, '**/src/pages/DeckEditor.tsx*')
      await page.goto(`/deck/${deckId}`)

      const card = failureCard(page)
      await expect(card).toBeVisible()
      chunk.restore()
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

  test('a dependency Retry cannot fetch needs a reload: Retry says so, Reload recovers', async ({
    page,
  }) => {
    // A module the page imports, not the page itself, unreachable through the
    // retry — in a browser that caches the failure the retry cannot fetch it
    // again, in one that does not it fails again — and back before the reload.
    let reachable = false
    await page.route('**/src/pages/accessTokenList.ts*', (route) =>
      reachable ? route.continue() : route.abort('internetdisconnected'),
    )
    await page.goto('/settings/access-tokens')

    const card = failureCard(page)
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: 'Retry' }).click()

    await expect(card).toContainText('Retrying didn’t help')
    const reload = card.getByRole('button', { name: 'Reload' })
    await expect(reload).toBeFocused()
    reachable = true
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
