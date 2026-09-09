import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'

/**
 * Points at a deployed environment, not the dev server, so it is opt-in:
 * set PROD_SMOKE_URL (e.g. https://narrative.bastla.com). Without it the spec
 * skips — the placeholder host it used to hard-code does not resolve, so the
 * local suite reported a DNS error as a product failure.
 */
const PROD = process.env['PROD_SMOKE_URL'] ?? ''
const ARTIFACT_DIR = '/tmp/narrative-prod-smoke'

mkdirSync(ARTIFACT_DIR, { recursive: true })

test.describe('Prod smoke', () => {
  test('redirects to login and produces a valid Google OAuth URL', async ({ page }) => {
    test.skip(PROD === '', 'deployment smoke — set PROD_SMOKE_URL to run it')
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => pageErrors.push(err.message))

    // 1. Navigate to the protected root.
    const resp = await page.goto(PROD + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    console.log('[smoke] initial status:', resp?.status(), 'final url:', page.url())

    // Cloudflare JS challenge fallback: if we see a CF interstitial, wait then reload once.
    if (/challenges\.cloudflare|just a moment/i.test(await page.content())) {
      console.log('[smoke] Cloudflare challenge detected — waiting 8s and reloading')
      await page.waitForTimeout(8000)
      await page.goto(PROD + '/', { waitUntil: 'domcontentloaded' })
    }

    // 2. Expect a redirect to a login page.
    await expect.poll(() => page.url(), { timeout: 15_000 }).toMatch(/\/auth\/login|\/login/i)
    const loginUrl = page.url()
    console.log('[smoke] login url:', loginUrl)

    // Screenshot the login page.
    const loginShot = `${ARTIFACT_DIR}/login-page.png`
    await page.screenshot({ path: loginShot, fullPage: true })
    console.log('[smoke] login screenshot:', loginShot)

    // 3. The page should expose a "Sign in with Google" button.
    const googleBtn = page
      .getByRole('button', { name: /sign in with google|continue with google|google/i })
      .or(page.getByRole('link', { name: /sign in with google|continue with google|google/i }))
      .first()
    await expect(googleBtn).toBeVisible({ timeout: 10_000 })

    // 4. Intercept the navigation to accounts.google.com BEFORE the user-facing
    //    consent screen loads.
    //
    //    Real flow: button click -> top-level nav to https://narrative.example.com/auth/google
    //    -> server replies 302 with Location: https://accounts.google.com/o/oauth2/v2/auth?...
    //    -> browser follows redirect to top-level Google auth page.
    //
    //    The /.well-known/openid-configuration request is a server-side fetch from
    //    the OIDC client (Caddy-side) and is NOT the user-facing URL we care about.
    //    We want the *document* request whose URL points at /o/oauth2/v2/auth.
    let capturedGoogleUrl: string | null = null

    // Watch top-level navigation requests (resource type 'document') only.
    page.on('request', (req) => {
      const u = req.url()
      if (
        u.startsWith('https://accounts.google.com/') &&
        req.resourceType() === 'document' &&
        u.includes('/oauth2/') &&
        u.includes('client_id=')
      ) {
        if (!capturedGoogleUrl) {
          capturedGoogleUrl = u
          console.log('[smoke] captured google auth doc url:', u)
        }
      }
    })

    // Also watch our own /auth/google response Location header (302 redirect).
    page.on('response', async (res) => {
      const u = res.url()
      if (u.includes('/auth/google') && !u.includes('callback')) {
        const status = res.status()
        const loc = res.headers()['location'] ?? ''
        console.log('[smoke] /auth/google response status:', status, 'location:', loc)
        if (loc.startsWith('https://accounts.google.com/') && !capturedGoogleUrl) {
          capturedGoogleUrl = loc
        }
      }
    })

    // Abort the actual nav to Google so we don't leak past the boundary.
    await page.route('https://accounts.google.com/**', async (route) => {
      if (route.request().resourceType() === 'document') {
        const u = route.request().url()
        if (u.includes('/oauth2/') && u.includes('client_id=') && !capturedGoogleUrl) {
          capturedGoogleUrl = u
        }
        await route.abort()
      } else {
        await route.continue()
      }
    })

    try {
      await Promise.all([
        page.waitForEvent('framenavigated', { timeout: 8000 }).catch(() => null),
        googleBtn.click(),
      ])
    } catch (err) {
      console.log('[smoke] click/nav threw (expected if aborted):', (err as Error).message)
    }

    // Give the aborted nav a moment to surface in our request listener.
    await page.waitForTimeout(1500)

    // 5. Validate the captured URL.
    expect(capturedGoogleUrl, 'No Google OAuth URL captured').toBeTruthy()
    const parsed = new URL(capturedGoogleUrl as string)
    console.log('[smoke] google host:', parsed.host, 'path:', parsed.pathname)
    expect(parsed.host).toBe('accounts.google.com')
    expect(parsed.pathname).toMatch(/\/o\/oauth2\/v2\/auth|\/oauth2\/v2\/auth/)

    const clientId = parsed.searchParams.get('client_id')
    const redirectUri = parsed.searchParams.get('redirect_uri')
    const responseType = parsed.searchParams.get('response_type')
    const scope = parsed.searchParams.get('scope') ?? ''
    const state = parsed.searchParams.get('state')

    console.log('[smoke] oauth params:', { clientId, redirectUri, responseType, scope, state })

    expect(clientId, 'client_id missing').toMatch(/\.apps\.googleusercontent\.com$/)
    expect(redirectUri, 'redirect_uri missing').toBe(`${PROD}/auth/callback`)
    expect(responseType).toBe('code')
    expect(scope).toMatch(/openid/)
    expect(scope).toMatch(/profile/)
    expect(scope).toMatch(/email/)
    expect(state, 'state missing').toBeTruthy()

    // Diagnostic dump.
    console.log('[smoke] console errors:', JSON.stringify(consoleErrors))
    console.log('[smoke] page errors:', JSON.stringify(pageErrors))
  })
})
