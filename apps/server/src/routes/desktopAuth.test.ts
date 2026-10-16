/**
 * routes/desktopAuth.test.ts
 *
 * The desktop app's sign-in through the real routes (ADR 0015): the
 * desktop start parameters, the callback's hand-off page instead of a
 * session, and the ticket redeem with its cross-site guard. Google, the
 * database and the sign-in policy are stubbed; the cookies, the signed state
 * and the tickets are real.
 */

import cookie from '@fastify/cookie'
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify'
import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../db/client.js'
import { s256 } from '../auth/pkce.js'
import { clearDesktopTicketsForTests } from '../auth/desktopTickets.js'

vi.mock('../auth/session.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/session.js')>()
  return {
    ...original,
    createSession: vi.fn(async () => ({
      rawId: 'fresh-session-id',
      expiresAt: new Date(Date.now() + original.SESSION_LIFETIME_MS),
    })),
    revokeSession: vi.fn(async () => undefined),
    lookupSession: vi.fn(async () => null),
  }
})
vi.mock('../auth/signInPolicy.js', () => ({ isAllowedToSignIn: vi.fn(async () => true) }))
vi.mock('../auth/users.js', () => ({ upsertUser: vi.fn(async () => undefined) }))
vi.mock('../auth/invites.js', () => ({ consumePendingInvitesForEmail: vi.fn(async () => 0) }))

const { createSession, revokeSession } = await import('../auth/session.js')
const { registerAuthRoutes } = await import('./auth.js')
const { registerDesktopAuthRoutes, DESKTOP_REDEEM_RATE_LIMIT } = await import('./desktopAuth.js')
const { registerAuthPlugin } = await import('../auth/fastifyAuth.js')
const { registerRateLimit } = await import('../http/rateLimit.js')

const SPA = 'https://narrative.example.com'
const user = { sub: 'google-sub-1', email: 'petr@example.com', name: 'Petr', emailVerified: true }

let app: FastifyInstance

async function build({
  isProd = true,
  rateLimit = false,
}: { isProd?: boolean; rateLimit?: boolean } = {}): Promise<FastifyInstance> {
  const server = Fastify()
  await server.register(cookie, { secret: 'test-cookie-secret-0123456789abcdef' })
  if (rateLimit) {
    registerAuthPlugin(server, { db: {} as Database })
    await registerRateLimit(server, { ipPreLimit: false })
  }
  const opts = {
    db: {} as Database,
    verifier: { verify: vi.fn(async () => user) },
    spaOrigin: SPA,
    redirectUri: `${SPA}/api/auth/callback`,
    isProd,
    allowlist: { allowedEmails: [] },
  }
  registerAuthRoutes(server, opts)
  await registerDesktopAuthRoutes(server, opts)
  await server.ready()
  return server
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: s256(verifier) }
}

const desktopState = (): string => randomBytes(32).toString('base64url')

function startQuery(overrides: Record<string, string | undefined> = {}): string {
  const params: Record<string, string | undefined> = {
    client: 'desktop',
    scheme: 'narrative',
    code_challenge: pkcePair().challenge,
    code_challenge_method: 'S256',
    desktop_state: desktopState(),
    ...overrides,
  }
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v)
  return q.toString()
}

function setCookieValue(res: LightMyRequestResponse, name: string): string | undefined {
  return res.cookies.find((c) => c.name === name)?.value
}

/** Start a sign-in and complete Google's callback; the callback's response. */
async function signInThroughBrowser(query: string): Promise<LightMyRequestResponse> {
  const start = await app.inject({ method: 'GET', url: `/auth/start?${query}` })
  expect(start.statusCode).toBe(302)
  const google = new URL(start.headers.location as string)
  const state = google.searchParams.get('state')!
  const stateCookie = setCookieValue(start, 'narrative_oauth_state')!
  return app.inject({
    method: 'GET',
    url: `/auth/callback?code=google-code&state=${state}`,
    cookies: { narrative_oauth_state: stateCookie },
  })
}

function expectInvalidDesktopRequest(res: LightMyRequestResponse): void {
  expect(res.statusCode).toBe(302)
  expect(res.headers.location).toBe(`${SPA}/auth/error?reason=invalid_desktop_request`)
  expect(setCookieValue(res, 'narrative_oauth_state')).toBeUndefined()
}

function handoffLink(res: LightMyRequestResponse): URL {
  const href = /<a href="([^"]+)">Open Narrative<\/a>/.exec(res.body)?.[1]
  expect(href).toBeDefined()
  return new URL(href!.replaceAll('&amp;', '&'))
}

/** What the shell's redeem navigation sends. */
const SHELL = { 'sec-fetch-site': 'none', 'x-narrative-desktop': '1' }

function redeem(
  body: Record<string, string>,
  headers: Record<string, string> = SHELL,
  cookies: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/auth/desktop/redeem',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: new URLSearchParams(body).toString(),
    cookies,
  })
}

beforeEach(async () => {
  vi.stubEnv('OIDC_CLIENT_ID', 'client-id')
  vi.stubEnv('OIDC_CLIENT_SECRET', 'client-secret')
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify({ id_token: 'google-id-token' }), { status: 200 }),
    ),
  )
  vi.mocked(createSession).mockClear()
  vi.mocked(revokeSession).mockClear()
  app = await build()
})

afterEach(async () => {
  await app.close()
  clearDesktopTicketsForTests()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('GET /auth/start with client=desktop', () => {
  it.each([
    ['a missing challenge', { code_challenge: undefined }],
    ['a malformed challenge', { code_challenge: 'short' }],
    ['a method other than S256', { code_challenge_method: 'plain' }],
    ['an unknown scheme', { scheme: 'evil' }],
    ['a missing state', { desktop_state: undefined }],
    ['a malformed state', { desktop_state: 'x'.repeat(42) }],
    ['another client', { client: 'mobile' }],
  ])('refuses %s', async (_label, overrides) => {
    const res = await app.inject({ method: 'GET', url: `/auth/start?${startQuery(overrides)}` })
    expectInvalidDesktopRequest(res)
  })

  it('refuses desktop parameters without client=desktop', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/start?code_challenge=${pkcePair().challenge}`,
    })
    expectInvalidDesktopRequest(res)
  })

  it('refuses a repeated parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/start?${startQuery()}&scheme=narrative-dev`,
    })
    expectInvalidDesktopRequest(res)
  })

  it('goes to Google with the desktop request in the signed state cookie', async () => {
    const res = await app.inject({ method: 'GET', url: `/auth/start?${startQuery()}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//)
    const raw = setCookieValue(res, 'narrative_oauth_state')!
    const unsigned = app.unsignCookie(raw)
    expect(unsigned.valid).toBe(true)
    expect(JSON.parse(unsigned.value!).desktop).toMatchObject({ scheme: 'narrative' })
  })

  it('keeps the browser sign-in unchanged', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/start?returnTo=/deck/abc' })
    expect(res.statusCode).toBe(302)
    const payload = JSON.parse(
      app.unsignCookie(setCookieValue(res, 'narrative_oauth_state')!).value!,
    )
    expect(payload.returnTo).toBe('/deck/abc')
    expect(payload.desktop).toBeUndefined()
  })
})

describe('GET /auth/callback for a desktop sign-in', () => {
  it('answers a hand-off page with a ticket instead of a session', async () => {
    const state = desktopState()
    const res = await signInThroughBrowser(startQuery({ desktop_state: state }))
    expect(res.statusCode).toBe(200)
    expect(createSession).not.toHaveBeenCalled()
    expect(setCookieValue(res, 'narrative_session')).toBeUndefined()

    const link = handoffLink(res)
    expect(`${link.protocol}//${link.host}${link.pathname}`).toBe('narrative://auth/complete')
    expect(link.searchParams.get('ticket')).toMatch(/^ndt_[A-Za-z0-9_-]{43}$/)
    expect(link.searchParams.get('state')).toBe(state)
    expect(res.body).toContain('http-equiv="refresh"')
    expect(res.headers.location).toBeUndefined()
  })

  it('sends the page with no-store, no-referrer and a script-free CSP', async () => {
    const res = await signInThroughBrowser(startQuery())
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
  })

  it('uses the dev scheme against a development server only', async () => {
    const refused = await app.inject({
      method: 'GET',
      url: `/auth/start?${startQuery({ scheme: 'narrative-dev' })}`,
    })
    expectInvalidDesktopRequest(refused)
    await app.close()
    app = await build({ isProd: false })
    const res = await signInThroughBrowser(startQuery({ scheme: 'narrative-dev' }))
    expect(handoffLink(res).protocol).toBe('narrative-dev:')
  })

  it('names the account and the desktop app on the hand-off page', async () => {
    const res = await signInThroughBrowser(startQuery())
    expect(res.body).toContain(`<strong>${user.email}</strong>`)
    expect(res.body).toContain('Narrative desktop app')
  })

  it('keeps the browser callback unchanged: a session and a redirect', async () => {
    const res = await signInThroughBrowser('returnTo=/deck/abc')
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`${SPA}/deck/abc`)
    expect(createSession).toHaveBeenCalledOnce()
    expect(setCookieValue(res, 'narrative_session')).toBe('fresh-session-id')
  })
})

describe('POST /auth/desktop/redeem', () => {
  async function mintedTicket(
    returnTo = '/deck/abc',
  ): Promise<{ ticket: string; verifier: string }> {
    const { verifier, challenge } = pkcePair()
    const res = await signInThroughBrowser(startQuery({ code_challenge: challenge, returnTo }))
    return { ticket: handoffLink(res).searchParams.get('ticket')!, verifier }
  }

  it('creates a session, sets the session cookie and goes into the app', async () => {
    const { ticket, verifier } = await mintedTicket()
    const res = await redeem({ ticket, verifier })
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe(`${SPA}/deck/abc`)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(createSession).toHaveBeenCalledOnce()
    expect(vi.mocked(createSession).mock.calls[0]![1].user).toEqual({
      sub: user.sub,
      email: user.email,
      name: user.name,
    })
    const session = res.cookies.find((c) => c.name === 'narrative_session')!
    expect(session.value).toBe('fresh-session-id')
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })
  })

  it('ends a session the window held before', async () => {
    const { ticket, verifier } = await mintedTicket()
    await redeem({ ticket, verifier }, undefined, { narrative_session: 'old-session' })
    // The same person: their other devices' editors stay connected.
    expect(revokeSession).toHaveBeenCalledWith(expect.anything(), 'old-session', {
      keepConnectionsOf: user.sub,
    })
  })

  it('answers every refused ticket the same way', async () => {
    const failed = `${SPA}/auth/error?reason=desktop_sign_in_failed`
    const { ticket, verifier } = await mintedTicket()
    expect((await redeem({ ticket, verifier })).statusCode).toBe(303)
    const reused = await redeem({ ticket, verifier })
    const other = await mintedTicket()
    const wrongVerifier = await redeem({ ticket: other.ticket, verifier: pkcePair().verifier })
    const unknown = await redeem({ ticket: `ndt_${'a'.repeat(43)}`, verifier })
    for (const res of [reused, wrongVerifier, unknown]) {
      expect(res.statusCode).toBe(303)
      expect(res.headers.location).toBe(failed)
      expect(setCookieValue(res, 'narrative_session')).toBeUndefined()
    }
    expect(createSession).toHaveBeenCalledOnce()
  })

  it.each([
    ['cross-site', { ...SHELL, 'sec-fetch-site': 'cross-site' }],
    ['same-site', { ...SHELL, 'sec-fetch-site': 'same-site' }],
    // A form on a page of the app's own origin (an inline upload, an XSS).
    ['same-origin', { ...SHELL, 'sec-fetch-site': 'same-origin' }],
    ['shell-less navigation', { 'sec-fetch-site': 'none' }],
    ['header-only, foreign origin', { 'x-narrative-desktop': '1', origin: 'https://evil.example' }],
    ['header-only, Origin: null', { 'x-narrative-desktop': '1', origin: 'null' }],
    ['header-only, the app origin', { 'x-narrative-desktop': '1', origin: SPA }],
  ])('refuses a %s request', async (_label, headers) => {
    const { ticket, verifier } = await mintedTicket()
    const res = await redeem({ ticket, verifier }, headers)
    expect(res.statusCode).toBe(403)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('accepts the header without fetch metadata only when no Origin is sent', async () => {
    const t = await mintedTicket()
    expect((await redeem(t, { 'x-narrative-desktop': '1' })).statusCode).toBe(303)
    expect(createSession).toHaveBeenCalledOnce()
  })

  it('never goes anywhere but a path of the app', async () => {
    for (const returnTo of ['/\\evil.example', '/x\r\nSet-Cookie: a=b']) {
      const t = await mintedTicket(returnTo)
      const res = await redeem(t)
      expect(res.headers.location).toBe(`${SPA}/`)
    }
  })

  it('limits redeems per caller', async () => {
    await app.close()
    app = await build({ rateLimit: true })
    const junk = { ticket: `ndt_${'a'.repeat(43)}`, verifier: pkcePair().verifier }
    for (let i = 0; i < DESKTOP_REDEEM_RATE_LIMIT.max; i++) {
      expect((await redeem(junk)).statusCode).toBe(303)
    }
    expect((await redeem(junk)).statusCode).toBe(429)
  })

  it('refuses JSON and a repeated parameter', async () => {
    const { ticket, verifier } = await mintedTicket()
    const json = await app.inject({
      method: 'POST',
      url: '/auth/desktop/redeem',
      headers: { 'content-type': 'application/json', ...SHELL },
      payload: JSON.stringify({ ticket, verifier }),
    })
    expect(json.statusCode).toBe(415)
    const repeated = await app.inject({
      method: 'POST',
      url: '/auth/desktop/redeem',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...SHELL },
      payload: `ticket=${ticket}&ticket=${ticket}&verifier=${verifier}`,
    })
    expect(repeated.statusCode).toBe(400)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('answers 500 when sign-in is not configured', async () => {
    vi.stubEnv('OIDC_CLIENT_SECRET', '')
    const res = await redeem({ ticket: `ndt_${'a'.repeat(43)}`, verifier: pkcePair().verifier })
    expect(res.statusCode).toBe(500)
  })
})
