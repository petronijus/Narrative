/**
 * tests/agent-eval/lib/browser.ts — a real editor tab for scenarios that
 * need what a person's editor publishes (editor.context reads the slide and
 * selection from the tab's awareness state).
 *
 * Playwright is resolved from the workspace (apps/web depends on it; the
 * repo's node-linker is hoisted). Browser choice follows
 * apps/web/playwright.config.ts: PLAYWRIGHT_CHROME_EXECUTABLE, or
 * PLAYWRIGHT_USE_SYSTEM_CHROME=1 for the system Chrome (Ubuntu 26.04, where
 * Playwright cannot install its own), else Playwright's bundled Chromium.
 *
 * Needs the dev web app in BYPASS_AUTH mode (VITE_BYPASS_AUTH=true), where
 * the tab is the same user as the harness's access tokens — editor.context
 * only reads the caller's own tabs. The dev-only test API
 * (`window.__narrative_test_api`, apps/web/src/state/testApi.ts) is how the
 * selection is set, exactly as the e2e specs do it.
 */

import type { Browser, Page } from 'playwright'

interface TestApi {
  listSlideIds(): string[]
  setSelection(ids: string[]): void
  getSelection(): string[]
}

declare global {
  interface Window {
    __narrative_test_api?: TestApi
  }
}

const READY_TIMEOUT_MS = 45_000

async function poll<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== null) return value
    } catch (err) {
      last = err
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`,
  )
}

export class EditorBrowser {
  private browser: Browser | null = null
  private readonly pages: Page[] = []

  constructor(private readonly webUrl: string) {}

  private async launch(): Promise<Browser> {
    if (this.browser !== null) return this.browser
    const { chromium } = await import('playwright')
    const executablePath = process.env['PLAYWRIGHT_CHROME_EXECUTABLE']
    this.browser = await chromium.launch({
      headless: true,
      ...(executablePath
        ? { executablePath }
        : process.env['PLAYWRIGHT_USE_SYSTEM_CHROME'] === '1'
          ? { channel: 'chrome' }
          : {}),
    })
    return this.browser
  }

  /**
   * Open the deck, switch to `slideId` (click it in the slides panel, as a
   * person would) and select `objectIds`. Resolves once the editor shows
   * that state; the caller then waits for the server to see it.
   */
  async open(deckId: string, slideId: string, objectIds: string[]): Promise<void> {
    const browser = await this.launch()
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    this.pages.push(page)
    await page.goto(`${this.webUrl}/deck/${encodeURIComponent(deckId)}`)
    await poll('the editor to load the deck', READY_TIMEOUT_MS, () =>
      page.evaluate(
        (id) => (window.__narrative_test_api?.listSlideIds().includes(id) ? true : null),
        slideId,
      ),
    )
    const option = page.locator(`[role="option"][data-slide-id="${slideId}"]`)
    await option.waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS })
    await option.click()
    await poll('the slide to become active', 15_000, async () =>
      (await option.getAttribute('aria-selected')) === 'true' ? true : null,
    )
    await poll('the selection to apply', 15_000, () =>
      page.evaluate((ids) => {
        const api = window.__narrative_test_api
        if (api === undefined) return null
        const current = api.getSelection()
        if (current.length === ids.length && ids.every((id) => current.includes(id))) return true
        api.setSelection(ids)
        return null
      }, objectIds),
    )
  }

  /** Close the tabs a scenario opened (its editor presence goes away). */
  async closePages(): Promise<void> {
    for (const page of this.pages.splice(0)) await page.close().catch(() => undefined)
  }

  async close(): Promise<void> {
    await this.closePages()
    await this.browser?.close().catch(() => undefined)
    this.browser = null
  }
}
