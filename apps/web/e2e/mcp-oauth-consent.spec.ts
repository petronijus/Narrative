/**
 * e2e/mcp-oauth-consent.spec.ts
 *
 * Connecting Claude Code to Narrative over MCP OAuth, in a real browser:
 * authorize → the consent page → Allow → back to the client's loopback
 * callback with a code.
 *
 * Until 0.10.4 every Allow failed with "This request did not come from
 * Narrative.": the consent page's `<meta name="referrer" content=
 * "no-referrer">` made the browser post its own form with `Origin: null`,
 * which the decision endpoint refuses. The first fix, 0.10.3, changed only
 * the HTTP header, which the meta tag overrides.
 *
 * Caveat: this spec does NOT reproduce that failure. Headless Chrome on the
 * dev stack (http://localhost) sent the real `Origin` even under the old
 * `no-referrer` meta; Petr's Chrome on production (https, behind
 * Cloudflare) sent `Origin: null` (seen in Caddy's access log). What the
 * spec does guard: the whole flow works in a real browser, the page asks
 * for `same-origin`, and the browser posts the decision with the page's
 * origin.
 *
 * The client is the one Claude Code registers as: its public Client ID
 * Metadata Document on claude.ai, with a loopback callback. The dev server
 * fetches that document, so the spec needs internet access.
 */

import { createHash, randomBytes } from 'node:crypto'
import { test, expect } from '@playwright/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata'
const CALLBACK = 'http://localhost:59003/callback'

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

test('Allow on the consent page returns a code to the client', async ({ page }) => {
  const { challenge } = pkce()
  const state = randomBytes(12).toString('base64url')

  // The loopback callback is Claude Code's local listener; capture it here.
  let callback: URL | null = null
  await page.route('http://localhost:59003/**', async (route) => {
    callback = new URL(route.request().url())
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' })
  })
  // Every POST to the decision endpoint, with the Origin the browser sent.
  const decisionOrigins: Array<string | null> = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/oauth/authorize/decision'))
      decisionOrigins.push(req.headers()['origin'] ?? null)
  })

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'mcp offline_access',
  })
  await page.goto(`${API_BASE}/oauth/authorize?${query}`)
  await expect(page.getByRole('heading', { name: /Allow .* to use Narrative\?/ })).toBeVisible()
  // The page's form must post with the page's own origin.
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'same-origin')

  await page.getByRole('button', { name: 'Allow' }).click()

  await expect.poll(() => callback?.toString() ?? null, { timeout: 15_000 }).not.toBeNull()
  expect(decisionOrigins).toEqual([new URL(API_BASE).origin])
  expect(callback!.searchParams.get('state')).toBe(state)
  expect(callback!.searchParams.get('code')).toBeTruthy()
  expect(callback!.searchParams.get('error')).toBeNull()
})
