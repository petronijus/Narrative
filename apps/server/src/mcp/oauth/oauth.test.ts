/**
 * mcp/oauth/oauth.test.ts — the MCP OAuth authorization server over real
 * HTTP: metadata, dynamic client registration, Client ID Metadata Documents,
 * the authorize → consent → code → token flow with PKCE, `offline_access`,
 * the failure paths (bad verifier, wrong redirect, reused code, expiry,
 * refresh rotation and replay (fingerprints, flags, security events),
 * revocation, CSRF), registered scopes / grant types, the redirect_uri rule
 * at /token, the CIMD host allowlist and the DCR switch, the housekeeping
 * sweep of stale registrations and the 30-day retention, the kill switch's
 * reach into pending authorizations, and the tokens' use on /mcp.
 *
 * Browser sessions are mocked at `lookupSession`: cookie
 * `narrative_session=s-<user>` is a signed-in <user>.
 */

import { createHash, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../auth/session.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../auth/session.js')>()
  return {
    ...original,
    lookupSession: vi.fn(async (_db: unknown, raw: string) =>
      raw.startsWith('s-')
        ? { userSub: raw.slice(2), userEmail: `${raw.slice(2)}@example.com`, userName: null }
        : null,
    ),
  }
})

import { createMcpWorld, type McpWorld } from '../../test-support/mcpWorld.js'
import {
  closeAgentSessionsForCredential,
  closeAgentSessionsForUser,
  credentialKeyForToken,
} from '../../auth/agentSessions.js'
import Fastify from 'fastify'
import { buildMcpPublicConfig, CLAUDE_AI_REDIRECT_URI } from '../config.js'
import { registerMcpOAuthRoutes } from './routes.js'
import { McpOAuthService } from './service.js'
import { createMemoryOAuthStore } from './store.js'
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  REFRESH_REUSE_GRACE_MS,
  RETENTION_MS,
  STALE_REGISTERED_CLIENT_MS,
} from './service.js'

let w: McpWorld
const LOOPBACK = 'http://127.0.0.1:33418/callback'

beforeEach(async () => {
  w = await createMcpWorld()
  w.world.createDeck('deck1')
  w.world.grant('deck1', 'user-1', 'editor')
})

afterEach(async () => {
  await w.destroy()
})

const session = (user: string) => ({ cookie: `narrative_session=s-${user}` })

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function register(body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${w.baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [LOOPBACK],
      token_endpoint_auth_method: 'none',
      // What claude.ai registers; without it RFC 7591 means no refresh tokens.
      grant_types: ['authorization_code', 'refresh_token'],
      ...body,
    }),
  })
}

async function clientId(body: Record<string, unknown> = {}): Promise<string> {
  const res = await register(body)
  expect(res.status).toBe(201)
  return ((await res.json()) as { client_id: string }).client_id
}

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${w.baseUrl}${path}`, { redirect: 'manual', headers })
}

function form(
  path: string,
  fields: Record<string, string | undefined>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.set(k, v)
  return fetch(`${w.baseUrl}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: body.toString(),
  })
}

function authorizeQuery(
  id: string,
  challenge: string,
  extra: Record<string, string | undefined> = {},
): string {
  const params: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: id,
    redirect_uri: LOOPBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    scope: 'mcp offline_access',
    resource: `${w.baseUrl}/mcp`,
    ...extra,
  }
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v)
  return q.toString()
}

/** Open the consent page as `user`; returns the form fields. */
async function consent(
  id: string,
  challenge: string,
  user = 'user-1',
  extra: Record<string, string | undefined> = {},
): Promise<{ request: string; csrf: string; html: string }> {
  const start = await get(`/oauth/authorize?${authorizeQuery(id, challenge, extra)}`)
  expect(start.status).toBe(302)
  const consentUrl = new URL(start.headers.get('location')!)
  const page = await get(consentUrl.pathname + consentUrl.search, session(user))
  expect(page.status).toBe(200)
  const html = await page.text()
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1] ?? ''
  return { request: field('request'), csrf: field('csrf'), html }
}

async function approve(
  id: string,
  challenge: string,
  user = 'user-1',
  extra: Record<string, string | undefined> = {},
): Promise<string> {
  const { request, csrf } = await consent(id, challenge, user, extra)
  const res = await form(
    '/oauth/authorize/decision',
    { request, csrf, decision: 'approve' },
    { ...session(user), origin: w.baseUrl },
  )
  expect(res.status).toBe(303)
  const to = new URL(res.headers.get('location')!)
  expect(to.origin + to.pathname).toBe(LOOPBACK)
  expect(to.searchParams.get('state')).toBe('st-1')
  expect(to.searchParams.get('iss')).toBe(w.baseUrl)
  return to.searchParams.get('code')!
}

interface Tokens {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope: string
}

async function exchange(
  id: string,
  code: string,
  verifier: string,
  extra: Record<string, string | undefined> = {},
): Promise<Response> {
  return form('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: id,
    code,
    code_verifier: verifier,
    redirect_uri: LOOPBACK,
    resource: `${w.baseUrl}/mcp`,
    ...extra,
  })
}

async function fullFlow(user = 'user-1'): Promise<{ id: string; tokens: Tokens }> {
  const id = await clientId()
  const { verifier, challenge } = pkce()
  const code = await approve(id, challenge, user)
  const res = await exchange(id, code, verifier)
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  return { id, tokens: (await res.json()) as Tokens }
}

async function mcpStatus(accessToken: string): Promise<Response> {
  return fetch(`${w.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'claude-ai', version: '1' },
      },
    }),
  })
}

describe('metadata', () => {
  it('serves protected-resource metadata at every path a client may build', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await get(path)
      expect(res.status, path).toBe(200)
      expect(await res.json()).toMatchObject({
        resource: `${w.baseUrl}/mcp`,
        authorization_servers: [w.baseUrl],
        scopes_supported: ['mcp'],
        bearer_methods_supported: ['header'],
      })
    }
    expect((await get('/.well-known/oauth-protected-resource/other')).status).toBe(404)
  })

  it('answers discovery without touching the store', async () => {
    const spy = vi.spyOn(w.oauthStore, 'getClient')
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
    ])
      expect((await get(path)).status).toBe(200)
    expect(spy).not.toHaveBeenCalled()
  })

  it('serves authorization-server metadata with PKCE S256 and registration', async () => {
    const res = await get('/.well-known/oauth-authorization-server')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      issuer: w.baseUrl,
      authorization_endpoint: `${w.baseUrl}/oauth/authorize`,
      token_endpoint: `${w.baseUrl}/oauth/token`,
      registration_endpoint: `${w.baseUrl}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      scopes_supported: ['mcp', 'offline_access'],
      // Both are needed for Claude to use a metadata document instead of DCR.
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: expect.arrayContaining(['none']),
    })
  })
})

describe('discovery with the production layout (issuer https://<domain>/api)', () => {
  it('answers the root, path-inserted forms Caddy passes through unstripped', async () => {
    const config = buildMcpPublicConfig({
      apiBaseUrl: 'https://narrative.example/api',
      spaOrigin: 'https://narrative.example',
    })
    const service = new McpOAuthService({
      store: createMemoryOAuthStore(),
      config,
      isOwnerAllowed: async () => true,
    })
    const app = Fastify({ logger: false })
    await registerMcpOAuthRoutes(app, { oauth: () => service })
    try {
      const as = await app.inject('/.well-known/oauth-authorization-server/api')
      expect(as.statusCode).toBe(200)
      expect(as.json()).toMatchObject({
        issuer: 'https://narrative.example/api',
        token_endpoint: 'https://narrative.example/api/oauth/token',
      })
      const pr = await app.inject('/.well-known/oauth-protected-resource/api/mcp')
      expect(pr.statusCode).toBe(200)
      // Exactly the URL a user enters in claude.ai; the first (only) server is the issuer.
      expect(pr.json()).toMatchObject({
        resource: 'https://narrative.example/api/mcp',
        authorization_servers: ['https://narrative.example/api'],
      })
      expect(config.resourceMetadataUrl).toBe(
        'https://narrative.example/api/.well-known/oauth-protected-resource/mcp',
      )
      expect((await app.inject('/.well-known/oauth-authorization-server/other')).statusCode).toBe(
        404,
      )
    } finally {
      await app.close()
    }
  })
})

describe('dynamic client registration', () => {
  it('registers claude.ai and loopback clients', async () => {
    const res = await register({
      redirect_uris: [CLAUDE_AI_REDIRECT_URI, LOOPBACK, 'http://localhost:9/callback'],
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      client_name: 'Claude',
      token_endpoint_auth_method: 'none',
      scope: 'mcp offline_access',
    })
    expect(body['client_secret']).toBeUndefined()
  })

  it.each([
    ['a foreign https callback', 'https://evil.example/cb'],
    ['a callback Anthropic does not use', 'https://claude.com/api/mcp/auth_callback'],
    ['http off loopback', 'http://example.com/cb'],
    ['IPv6 loopback', 'http://[::1]:1/callback'],
    ['another loopback path', 'http://127.0.0.1:1/cb'],
    ['a fragment', 'http://127.0.0.1:1/callback#x'],
    ['another scheme', 'javascript:alert(1)'],
  ])('refuses %s', async (_label, uri) => {
    const res = await register({ redirect_uris: [uri] })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_redirect_uri' })
  })

  it('accepts only JSON', async () => {
    const res = await form('/oauth/register', {
      client_name: 'x',
      redirect_uris: LOOPBACK,
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_client_metadata' })
  })

  it('refuses at /authorize a callback an older registration holds but the allowlist dropped', async () => {
    const id = await clientId()
    w.oauthStore.clients.get(id)!.redirectUris.push('https://claude.com/api/mcp/auth_callback')
    const res = await get(
      `/oauth/authorize?${authorizeQuery(id, pkce().challenge, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' })}`,
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })

  it('issues a secret to confidential clients and checks it', async () => {
    const res = await register({ token_endpoint_auth_method: 'client_secret_basic' })
    const { client_id, client_secret } = (await res.json()) as {
      client_id: string
      client_secret: string
    }
    expect(client_secret).toMatch(/^nms_/)
    const { verifier, challenge } = pkce()
    const code = await approve(client_id, challenge)
    const basic = (secret: string) => ({
      authorization: `Basic ${Buffer.from(`${client_id}:${secret}`).toString('base64')}`,
    })
    const wrong = await form(
      '/oauth/token',
      { grant_type: 'authorization_code', code, code_verifier: verifier },
      basic('nope'),
    )
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('www-authenticate')).toMatch(/^Basic/)
    const ok = await form(
      '/oauth/token',
      { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: LOOPBACK },
      basic(client_secret),
    )
    expect(ok.status).toBe(200)
  })
})

describe('authorization code flow', () => {
  it('issues tokens that work on /mcp as the user who approved', async () => {
    const { tokens } = await fullFlow()
    expect(tokens).toMatchObject({
      token_type: 'Bearer',
      scope: 'mcp offline_access',
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    })
    expect(tokens.access_token).toMatch(/^nmo_/)
    expect(tokens.refresh_token).toMatch(/^nmr_/)
    const res = await mcpStatus(tokens.access_token)
    expect(res.status).toBe(200)
    const sessionId = res.headers.get('mcp-session-id')!
    expect(w.mcp.sessions.sessionsOf('user-1')).toEqual([sessionId])
  })

  it('issues no refresh token unless offline_access was approved', async () => {
    const id = await clientId()
    const { verifier, challenge } = pkce()
    const { html } = await consent(id, challenge, 'user-1', { scope: 'mcp' })
    expect(html).toContain('ends after one hour')
    const code = await approve(id, challenge, 'user-1', { scope: 'mcp' })
    const tokens = (await (await exchange(id, code, verifier)).json()) as Tokens
    expect(tokens.scope).toBe('mcp')
    expect(tokens.refresh_token).toBeUndefined()
    expect((await mcpStatus(tokens.access_token)).status).toBe(200)
  })

  it('requires the mcp scope (offline_access alone is not enough)', async () => {
    const id = await clientId()
    const res = await get(
      `/oauth/authorize?${authorizeQuery(id, pkce().challenge, { scope: 'offline_access' })}`,
    )
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope')
  })

  it('sends a signed-out user through the normal sign-in, then back to the consent page', async () => {
    const id = await clientId()
    const start = await get(`/oauth/authorize?${authorizeQuery(id, pkce().challenge)}`)
    const consentUrl = new URL(start.headers.get('location')!)
    const res = await get(consentUrl.pathname + consentUrl.search)
    expect(res.status).toBe(302)
    const login = new URL(res.headers.get('location')!)
    expect(login.pathname).toBe('/auth/start')
    expect(login.searchParams.get('returnTo')).toBe(consentUrl.pathname + consentUrl.search)
  })

  it('names the client (sanitised), its callback host and the scope on a frame-proof page', async () => {
    const id = await clientId({ client_name: '<script>x</script> Claude & Co' })
    const start = await get(`/oauth/authorize?${authorizeQuery(id, pkce().challenge)}`)
    const consentUrl = new URL(start.headers.get('location')!)
    const page = await get(consentUrl.pathname + consentUrl.search, session('user-1'))
    const html = await page.text()
    // Markup characters are dropped at registration; what is left is escaped.
    expect(html).toContain('scriptx/script Claude &amp; Co')
    expect(html).not.toContain('<script>')
    expect(html).toContain('<code>127.0.0.1:33418</code>')
    expect(html).toContain('a program on this computer')
    expect(html).toContain('<code>mcp</code>')
    // Self-registered: nobody vouches for the name; every callback is loopback.
    expect(html).toContain('Narrative cannot verify it')
    expect(html).toContain('can only receive the approval on this computer')
    expect(html).toContain('stays connected until you disconnect it')
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    expect(page.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/)
    expect(page.headers.get('content-security-policy')).toMatch(
      /form-action .*http:\/\/127\.0\.0\.1:33418/,
    )
    // Not `no-referrer`: under it a browser posts the page's own form with
    // `Origin: null`, which the decision endpoint refuses (as it must).
    expect(page.headers.get('referrer-policy')).toBe('same-origin')
    // …and the meta tag, which overrides the header, says the same (0.10.3
    // fixed only the header, and consent kept failing).
    expect(html).toContain('<meta name="referrer" content="same-origin">')
    expect(html).not.toContain('content="no-referrer"')
    // The user's address stays readable behind Cloudflare's Email Obfuscation.
    expect(html).toMatch(/<!--email_off-->[^<]*<!--\/email_off-->/)
  })

  it('shows a web callback host prominently, without the loopback warning', async () => {
    const id = await clientId({ redirect_uris: [CLAUDE_AI_REDIRECT_URI, LOOPBACK] })
    const { html } = await consent(id, pkce().challenge, 'user-1', {
      redirect_uri: CLAUDE_AI_REDIRECT_URI,
    })
    expect(html).toMatch(/<div class="dest">.*<strong>claude\.ai<\/strong><\/div>/s)
    expect(html).not.toContain('program on this computer')
    expect(html).not.toContain('can only receive the approval on this computer')
  })

  it('denies with access_denied', async () => {
    const id = await clientId()
    const { request, csrf } = await consent(id, pkce().challenge)
    const res = await form(
      '/oauth/authorize/decision',
      { request, csrf, decision: 'deny' },
      { ...session('user-1'), origin: w.baseUrl },
    )
    const to = new URL(res.headers.get('location')!)
    expect(to.searchParams.get('error')).toBe('access_denied')
    expect(to.searchParams.get('code')).toBeNull()
  })

  it('never redirects to an unregistered redirect URI', async () => {
    const id = await clientId()
    const res = await get(
      `/oauth/authorize?${authorizeQuery(id, pkce().challenge, { redirect_uri: 'https://evil.example/cb' })}`,
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    const unknown = await get(
      `/oauth/authorize?${authorizeQuery('no-such-client', pkce().challenge)}`,
    )
    expect(unknown.status).toBe(400)
  })

  it('allows another loopback port for a loopback registration (RFC 8252)', async () => {
    const id = await clientId()
    const res = await get(
      `/oauth/authorize?${authorizeQuery(id, pkce().challenge, { redirect_uri: 'http://127.0.0.1:50000/callback' })}`,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/oauth/authorize/consent')
    // …but never another loopback host or path.
    for (const other of ['http://localhost:50000/callback', 'http://127.0.0.1:50000/other']) {
      const refused = await get(
        `/oauth/authorize?${authorizeQuery(id, pkce().challenge, { redirect_uri: other })}`,
      )
      expect(refused.status, other).toBe(400)
    }
  })

  it.each([
    ['plain PKCE', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['no PKCE', { code_challenge: '' }, 'invalid_request'],
    ['another scope', { scope: 'admin' }, 'invalid_scope'],
    ['another resource', { resource: 'https://other.example/mcp' }, 'invalid_target'],
    ['implicit flow', { response_type: 'token' }, 'unsupported_response_type'],
  ])('returns %s to the client as an error', async (_label, extra, error) => {
    const id = await clientId()
    const res = await get(`/oauth/authorize?${authorizeQuery(id, pkce().challenge, extra)}`)
    expect(res.status).toBe(302)
    const to = new URL(res.headers.get('location')!)
    expect(to.searchParams.get('error')).toBe(error)
    expect(to.searchParams.get('state')).toBe('st-1')
  })
})

describe('consent is CSRF-safe', () => {
  it('refuses a wrong CSRF token, another user, a foreign origin, and a second answer', async () => {
    const id = await clientId()
    const { request, csrf } = await consent(id, pkce().challenge)
    const post = (fields: Record<string, string>, headers: Record<string, string>) =>
      form('/oauth/authorize/decision', { request, csrf, decision: 'approve', ...fields }, headers)

    expect(
      (await post({ csrf: 'forged' }, { ...session('user-1'), origin: w.baseUrl })).status,
    ).toBe(403)
    expect((await post({}, { ...session('user-2'), origin: w.baseUrl })).status).toBe(403)
    expect((await post({}, { ...session('user-1'), origin: 'https://evil.example' })).status).toBe(
      403,
    )
    // An opaque origin (sandboxed or no-referrer form) is refused too.
    expect((await post({}, { ...session('user-1'), origin: 'null' })).status).toBe(403)
    expect((await post({}, { origin: w.baseUrl })).status).toBe(401)
    expect((await post({}, { ...session('user-1'), origin: w.baseUrl })).status).toBe(303)
    expect((await post({}, { ...session('user-1'), origin: w.baseUrl })).status).toBe(400)
  })

  it('binds a request to the first user who opens it', async () => {
    const id = await clientId()
    const { challenge } = pkce()
    const start = await get(`/oauth/authorize?${authorizeQuery(id, challenge)}`)
    const consentUrl = new URL(start.headers.get('location')!)
    expect((await get(consentUrl.pathname + consentUrl.search, session('user-1'))).status).toBe(200)
    expect((await get(consentUrl.pathname + consentUrl.search, session('user-2'))).status).toBe(400)
  })
})

describe('token endpoint failures', () => {
  it('refuses a wrong PKCE verifier', async () => {
    const id = await clientId()
    const { challenge } = pkce()
    const code = await approve(id, challenge)
    const res = await exchange(id, code, pkce().verifier)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('refuses a code for another redirect URI or client', async () => {
    const id = await clientId()
    const { verifier, challenge } = pkce()
    const code = await approve(id, challenge)
    expect(
      await (
        await exchange(id, code, verifier, { redirect_uri: 'http://127.0.0.1:1/other' })
      ).json(),
    ).toMatchObject({ error: 'invalid_grant' })
    const other = await clientId()
    const { verifier: v2, challenge: c2 } = pkce()
    const code2 = await approve(id, c2)
    expect(await (await exchange(other, code2, v2)).json()).toMatchObject({
      error: 'invalid_grant',
    })
  })

  it('treats a reused code as theft: refused, and the tokens it produced are revoked', async () => {
    const id = await clientId()
    const { verifier, challenge } = pkce()
    const code = await approve(id, challenge)
    const first = (await (await exchange(id, code, verifier)).json()) as Tokens
    expect((await mcpStatus(first.access_token)).status).toBe(200)
    const again = await exchange(id, code, verifier)
    expect(again.status).toBe(400)
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' })
    expect((await mcpStatus(first.access_token)).status).toBe(401)
  })

  it('refuses an expired code', async () => {
    const id = await clientId()
    const { verifier, challenge } = pkce()
    const code = await approve(id, challenge)
    w.advance(AUTHORIZATION_CODE_TTL_MS + 1000)
    expect(await (await exchange(id, code, verifier)).json()).toMatchObject({
      error: 'invalid_grant',
    })
  })

  it('refuses expired access tokens with a challenge, and rotates refresh tokens', async () => {
    const { id, tokens } = await fullFlow()
    w.advance(ACCESS_TOKEN_TTL_MS + 1000)
    const expired = await mcpStatus(tokens.access_token)
    expect(expired.status).toBe(401)
    expect(expired.headers.get('www-authenticate')).toMatch(
      /error="invalid_token".*resource_metadata=/,
    )

    const refreshed = await form('/oauth/token', {
      grant_type: 'refresh_token',
      client_id: id,
      refresh_token: tokens.refresh_token!,
    })
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as Tokens
    expect(next.refresh_token).toMatch(/^nmr_/)
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    expect((await mcpStatus(next.access_token)).status).toBe(200)

    // A replay within the grace window is refused but does not log the user out…
    const racing = await form('/oauth/token', {
      grant_type: 'refresh_token',
      client_id: id,
      refresh_token: tokens.refresh_token!,
    })
    expect(await racing.json()).toMatchObject({ error: 'invalid_grant' })
    expect((await mcpStatus(next.access_token)).status).toBe(200)
    // …after it, it is theft: the whole grant goes.
    w.advance(REFRESH_REUSE_GRACE_MS + 1000)
    await form('/oauth/token', {
      grant_type: 'refresh_token',
      client_id: id,
      refresh_token: tokens.refresh_token!,
    })
    expect((await mcpStatus(next.access_token)).status).toBe(401)
  })

  it('rejects repeated form parameters, in the OAuth error format', async () => {
    const res = await fetch(`${w.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&grant_type=authorization_code',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('answers every refresh failure with invalid_grant, also for a client that no longer exists', async () => {
    const { id, tokens } = await fullFlow()
    const refresh = (clientId: string, token = tokens.refresh_token!) =>
      form('/oauth/token', {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: token,
      })
    for (const res of [
      await refresh(id, 'nmr_' + 'x'.repeat(43)),
      await refresh('no-such-client'),
      await refresh('https://claude.ai/oauth/claude-code-client-metadata'),
      await refresh(await clientId()),
    ]) {
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'invalid_grant' })
    }
    // None of those burned the real refresh token.
    expect((await refresh(id)).status).toBe(200)
  })
})

describe('revocation', () => {
  it('revokes through the revocation endpoint and closes the grant sessions', async () => {
    const { id, tokens } = await fullFlow()
    expect((await mcpStatus(tokens.access_token)).status).toBe(200)
    expect(w.mcp.sessions.size).toBe(1)
    const res = await form('/oauth/revoke', { token: tokens.refresh_token!, client_id: id })
    expect(res.status).toBe(200)
    expect((await mcpStatus(tokens.access_token)).status).toBe(401)
    expect(w.mcp.sessions.size).toBe(0)
  })

  it('lets the user list and disconnect connections with their session (never with a token)', async () => {
    const { tokens } = await fullFlow()
    const list = await get('/oauth/connections', session('user-1'))
    const { connections } = (await list.json()) as {
      connections: Array<{ id: string; clientName: string }>
    }
    expect(connections).toEqual([expect.objectContaining({ clientName: 'Claude' })])
    const byToken = await fetch(`${w.baseUrl}/oauth/connections`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    expect(byToken.status).toBe(401)
    const other = await fetch(`${w.baseUrl}/oauth/connections/${connections[0]!.id}`, {
      method: 'DELETE',
      headers: session('user-2'),
    })
    expect(other.status).toBe(404)
    const del = await fetch(`${w.baseUrl}/oauth/connections/${connections[0]!.id}`, {
      method: 'DELETE',
      headers: session('user-1'),
    })
    expect(del.status).toBe(204)
    expect((await mcpStatus(tokens.access_token)).status).toBe(401)
  })

  it('refuses tokens of a user who may no longer sign in', async () => {
    const { tokens, id } = await fullFlow()
    w.refusedOwners.add('user-1')
    expect((await mcpStatus(tokens.access_token)).status).toBe(401)
    const refresh = await form('/oauth/token', {
      grant_type: 'refresh_token',
      client_id: id,
      refresh_token: tokens.refresh_token!,
    })
    expect(await refresh.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('never accepts a browser session on /mcp', async () => {
    const res = await fetch(`${w.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        ...session('user-1'),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })
})

describe('Client ID Metadata Documents', () => {
  const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata'
  // Claude Code's real document (fetched 2026-09-27): port-less loopback callbacks.
  const claudeCodeDoc = {
    client_id: CLAUDE_CODE,
    client_name: 'Claude Code',
    client_uri: 'https://claude.ai',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }

  beforeEach(() => {
    w.metadataDocuments.set(CLAUDE_CODE, {
      body: claudeCodeDoc,
      cacheControl: 'public, max-age=300',
    })
  })

  it('runs the whole flow for a metadata-document client, which is never stored as a registration', async () => {
    const { verifier, challenge } = pkce()
    const { html } = await consent(CLAUDE_CODE, challenge)
    expect(html).toContain('Allow Claude Code to use Narrative?')
    expect(html).toContain('described by <strong>claude.ai</strong>')
    expect(html).toContain('<code>127.0.0.1:33418</code>')
    expect(html).toContain('can only receive the approval on this computer')

    const code = await approve(CLAUDE_CODE, challenge)
    const res = await exchange(CLAUDE_CODE, code, verifier)
    expect(res.status).toBe(200)
    const tokens = (await res.json()) as Tokens
    expect(tokens.refresh_token).toMatch(/^nmr_/)
    expect((await mcpStatus(tokens.access_token)).status).toBe(200)

    const refreshed = await form('/oauth/token', {
      grant_type: 'refresh_token',
      client_id: CLAUDE_CODE,
      refresh_token: tokens.refresh_token!,
    })
    expect(refreshed.status).toBe(200)

    expect(w.oauthStore.clients.size).toBe(0)
    const { connections } = (await (await get('/oauth/connections', session('user-1'))).json()) as {
      connections: Array<Record<string, unknown>>
    }
    expect(connections).toEqual([
      expect.objectContaining({
        clientName: 'Claude Code',
        kind: 'metadata_document',
        redirectHosts: ['127.0.0.1:33418'],
      }),
    ])
  })

  it('matches the localhost callback on any port too, and refuses a callback the document lacks', async () => {
    const ok = await get(
      `/oauth/authorize?${authorizeQuery(CLAUDE_CODE, pkce().challenge, { redirect_uri: 'http://localhost:61000/callback' })}`,
    )
    expect(ok.status).toBe(302)
    const refused = await get(
      `/oauth/authorize?${authorizeQuery(CLAUDE_CODE, pkce().challenge, { redirect_uri: CLAUDE_AI_REDIRECT_URI })}`,
    )
    expect(refused.status).toBe(400)
  })

  it('caches the document within its Cache-Control lifetime', async () => {
    for (let i = 0; i < 3; i++)
      expect(
        (await get(`/oauth/authorize?${authorizeQuery(CLAUDE_CODE, pkce().challenge)}`)).status,
      ).toBe(302)
    expect(w.metadataFetches).toEqual([CLAUDE_CODE])
    w.advance(301_000)
    await get(`/oauth/authorize?${authorizeQuery(CLAUDE_CODE, pkce().challenge)}`)
    expect(w.metadataFetches).toEqual([CLAUDE_CODE, CLAUDE_CODE])
  })

  it.each([
    ['a document for another client_id', { ...claudeCodeDoc, client_id: 'https://evil.example/c' }],
    [
      'a redirect URI off the allowlist',
      { ...claudeCodeDoc, redirect_uris: ['https://evil.example/cb'] },
    ],
    ['no client_name', { ...claudeCodeDoc, client_name: undefined }],
    [
      'a confidential client',
      { ...claudeCodeDoc, token_endpoint_auth_method: 'client_secret_basic' },
    ],
  ])('shows an error page, never a redirect, for %s', async (_label, body) => {
    w.metadataDocuments.set(CLAUDE_CODE, { body })
    const res = await get(`/oauth/authorize?${authorizeQuery(CLAUDE_CODE, pkce().challenge)}`)
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.text()).toContain('metadata document is not usable')
  })

  it('shows an error page for an unreachable document or an unusable client_id URL', async () => {
    w.metadataDocuments.set(CLAUDE_CODE, new Error('connect ECONNREFUSED'))
    for (const id of [
      CLAUDE_CODE,
      'https://claude.ai/',
      'https://claude.ai/oauth/../x',
      'https://claude.ai/x?y=1',
      'https://CLAUDE.ai/oauth/claude-code-client-metadata',
    ]) {
      const res = await get(`/oauth/authorize?${authorizeQuery(id, pkce().challenge)}`)
      expect(res.status, id).toBe(400)
      expect(res.headers.get('location'), id).toBeNull()
    }
    // Only the syntactically valid URL was fetched.
    expect(w.metadataFetches).toEqual([CLAUDE_CODE])
  })

  it('refuses at the token endpoint a code issued to another client_id', async () => {
    const { verifier, challenge } = pkce()
    const code = await approve(CLAUDE_CODE, challenge)
    const res = await exchange('https://claude.ai/oauth/other-client-metadata', code, verifier)
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' })
  })
})

describe('housekeeping', () => {
  it('deletes registrations without a live grant after 7 days of inactivity, and keeps the rest', async () => {
    const idle = await clientId()
    const { id: connected } = await fullFlow()
    const { id: disconnected, tokens } = await fullFlow('user-2')
    await form('/oauth/revoke', { token: tokens.refresh_token!, client_id: disconnected })
    // A pending request keeps its client alive even when the client is old.
    const pending = await clientId()

    w.advance(STALE_REGISTERED_CLIENT_MS - 60_000)
    expect(await w.mcp.oauth.runMaintenance()).toMatchObject({ staleClients: 0 })
    w.advance(120_000)
    await get(`/oauth/authorize?${authorizeQuery(pending, pkce().challenge)}`)
    expect(await w.mcp.oauth.runMaintenance()).toMatchObject({ staleClients: 2 })
    expect([...w.oauthStore.clients.keys()].sort()).toEqual([connected, pending].sort())
    // The deleted client's revoked grant and tokens went with it.
    expect([...w.oauthStore.grants.values()].every((g) => g.clientId === connected)).toBe(true)
    expect(idle).not.toBe(connected)
  })
})

describe('kill switches reach live MCP sessions', () => {
  it('ends every MCP session of a user — OAuth and PAT alike — and nobody else’s', async () => {
    w.world.grant('deck1', 'user-2', 'editor')
    const { tokens } = await fullFlow()
    expect((await mcpStatus(tokens.access_token)).status).toBe(200)
    await w.client(await w.token('user-1'))
    await w.client(await w.token('user-2'))
    expect(w.mcp.sessions.sessionsOf('user-1')).toHaveLength(2)

    expect(await closeAgentSessionsForUser('user-1')).toBe(2)
    expect(w.mcp.sessions.sessionsOf('user-1')).toHaveLength(0)
    expect(w.mcp.sessions.sessionsOf('user-2')).toHaveLength(1)
  })

  it('ends the sessions of one revoked personal access token only', async () => {
    const mint = async () =>
      w.pats.create('user-1', { name: 'laptop', scopes: ['mcp'], expiresInDays: 30 })
    const revoked = await mint()
    const kept = await mint()
    await w.client(revoked.token)
    await w.client(kept.token)
    expect(w.mcp.sessions.sessionsOf('user-1')).toHaveLength(2)

    // What DELETE /access-tokens/:id does after revoking (routes/accessTokens.ts).
    expect(await closeAgentSessionsForCredential(credentialKeyForToken(revoked.summary.id))).toBe(1)
    expect(w.mcp.sessions.sessionsOf('user-1')).toHaveLength(1)
  })
})

describe('dynamic registration is opt-in (MCP_OAUTH_DCR_ENABLED)', () => {
  it('is neither advertised nor served when off, and metadata documents still work', async () => {
    const off = await createMcpWorld({ dcrEnabled: false })
    try {
      const meta = (await (
        await fetch(`${off.baseUrl}/.well-known/oauth-authorization-server`)
      ).json()) as Record<string, unknown>
      expect(meta['registration_endpoint']).toBeUndefined()
      expect(meta['client_id_metadata_document_supported']).toBe(true)
      const res = await fetch(`${off.baseUrl}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'x', redirect_uris: [LOOPBACK] }),
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ error: 'invalid_request' })
      expect(off.oauthStore.clients.size).toBe(0)
    } finally {
      await off.destroy()
    }
  })
})

describe('registered scopes and grant types', () => {
  it('follows RFC 7591: no grant_types means no refresh token, and says so on the consent page', async () => {
    const id = await clientId({ grant_types: undefined })
    const { verifier, challenge } = pkce()
    const { html } = await consent(id, challenge)
    expect(html).toContain('ends after one hour')
    const code = await approve(id, challenge)
    const tokens = (await (await exchange(id, code, verifier)).json()) as Tokens
    expect(tokens.scope).toBe('mcp')
    expect(tokens.refresh_token).toBeUndefined()
    expect(w.oauthStore.clients.get(id)).toMatchObject({
      grantTypes: ['authorization_code'],
      scopes: ['mcp', 'offline_access'],
    })
  })

  it('grants no more than the registered scopes', async () => {
    const id = await clientId({ scope: 'mcp' })
    const { verifier, challenge } = pkce()
    const code = await approve(id, challenge)
    const tokens = (await (await exchange(id, code, verifier)).json()) as Tokens
    expect(tokens.scope).toBe('mcp')
    expect(tokens.refresh_token).toBeUndefined()
  })

  it('refuses a refresh with unauthorized_client once the client may not refresh', async () => {
    const { id, tokens } = await fullFlow()
    for (const g of w.oauthStore.grants.values()) g.grantTypes = ['authorization_code']
    const res = await form('/oauth/token', {
      grant_type: 'refresh_token',
      client_id: id,
      refresh_token: tokens.refresh_token!,
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'unauthorized_client' })
  })

  it('honours a metadata document without refresh_token the same way', async () => {
    const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata'
    w.metadataDocuments.set(CLAUDE_CODE, {
      body: {
        client_id: CLAUDE_CODE,
        client_name: 'Claude Code',
        redirect_uris: ['http://127.0.0.1/callback'],
        token_endpoint_auth_method: 'none',
      },
    })
    const { verifier, challenge } = pkce()
    const code = await approve(CLAUDE_CODE, challenge)
    const tokens = (await (await exchange(CLAUDE_CODE, code, verifier)).json()) as Tokens
    expect(tokens.refresh_token).toBeUndefined()
    expect([...w.oauthStore.grants.values()][0]!.grantTypes).toEqual(['authorization_code'])
  })

  it('sanitises the registered client_name like a peer label', async () => {
    const res = await register({ client_name: '\u202eClaude\u200b <img src=x>' })
    expect(((await res.json()) as { client_name: string }).client_name).toBe('Claude img src=x')
    const blank = await register({ client_name: '\u200b' })
    expect(((await blank.json()) as { client_name: string }).client_name).toBe('Unnamed MCP client')
  })
})

describe('redirect_uri at the token endpoint', () => {
  it('is required, and must match exactly, when /authorize named one', async () => {
    const id = await clientId()
    const { verifier, challenge } = pkce()
    const code = await approve(id, challenge)
    const missing = await exchange(id, code, verifier, { redirect_uri: undefined })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({
      error: 'invalid_grant',
      error_description: expect.stringContaining('redirect_uri is required'),
    })
  })

  it('may be left out when /authorize used the client’s only redirect URI implicitly', async () => {
    const id = await clientId()
    const { verifier, challenge } = pkce()
    const code = await approve(id, challenge, 'user-1', { redirect_uri: undefined })
    const res = await exchange(id, code, verifier, { redirect_uri: undefined })
    expect(res.status).toBe(200)
  })
})

describe('consent page', () => {
  it('always asks "only approve if you started this" and shows when the request was made', async () => {
    const id = await clientId({ redirect_uris: [CLAUDE_AI_REDIRECT_URI, LOOPBACK] })
    const { html } = await consent(id, pkce().challenge, 'user-1', {
      redirect_uri: CLAUDE_AI_REDIRECT_URI,
    })
    expect(html).toContain('Only approve if you just started connecting Narrative from Claude')
    expect(html).toMatch(
      /Requested <time datetime="\d{4}-\d\d-\d\dT[^"]+">\d+ \w{3} \d{4}, \d\d:\d\d UTC<\/time>/,
    )
  })
})

describe('Client ID Metadata Document hosts (MCP_OAUTH_CIMD_HOSTS)', () => {
  it('refuses a document on a host off the list before fetching anything', async () => {
    const other = 'https://tools.example/oauth/client'
    w.metadataDocuments.set(other, {
      body: { client_id: other, client_name: 'Tools', redirect_uris: [LOOPBACK] },
    })
    const res = await get(`/oauth/authorize?${authorizeQuery(other, pkce().challenge)}`)
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.text()).toContain('MCP_OAUTH_CIMD_HOSTS')
    expect(w.metadataFetches).toEqual([])
  })

  it('accepts the hosts the operator lists', async () => {
    const custom = await createMcpWorld({ cimdHosts: ['tools.example'] })
    try {
      const other = 'https://tools.example/oauth/client'
      custom.metadataDocuments.set(other, {
        body: { client_id: other, client_name: 'Tools', redirect_uris: [LOOPBACK] },
      })
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: other,
        redirect_uri: LOOPBACK,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      })
      const res = await fetch(`${custom.baseUrl}/oauth/authorize?${q}`, { redirect: 'manual' })
      expect(res.status).toBe(302)
      const claude = new URLSearchParams({
        response_type: 'code',
        client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
        redirect_uri: LOOPBACK,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      })
      const refused = await fetch(`${custom.baseUrl}/oauth/authorize?${claude}`, {
        redirect: 'manual',
      })
      expect(refused.status).toBe(400)
    } finally {
      await custom.destroy()
    }
  })
})

describe('refresh token replay', () => {
  const refresh = (id: string, token: string, userAgent = 'claude-ai/1') =>
    form(
      '/oauth/token',
      { grant_type: 'refresh_token', client_id: id, refresh_token: token },
      { 'user-agent': userAgent },
    )

  async function connections(): Promise<Array<{ flaggedAt: string | null }>> {
    return (
      (await (await get('/oauth/connections', session('user-1'))).json()) as {
        connections: Array<{ flaggedAt: string | null }>
      }
    ).connections
  }

  it('keeps the grant when the first rotator races itself, but flags it and logs a security event', async () => {
    const events: unknown[] = []
    ;(w.mcp.oauth as unknown as { onSecurityEvent: (e: unknown) => void }).onSecurityEvent = (e) =>
      events.push(e)
    const { id, tokens } = await fullFlow()
    const rotated = await refresh(id, tokens.refresh_token!)
    expect(rotated.status).toBe(200)
    const next = (await rotated.json()) as Tokens
    const racing = await refresh(id, tokens.refresh_token!)
    expect(await racing.json()).toMatchObject({ error: 'invalid_grant' })
    expect((await mcpStatus(next.access_token)).status).toBe(200)
    expect(events).toEqual([
      expect.objectContaining({
        event: 'mcp_oauth_refresh_replay',
        sameFingerprint: true,
        withinGrace: true,
        revoked: false,
      }),
    ])
    expect((await connections())[0]!.flaggedAt).not.toBeNull()
  })

  it('revokes the grant when someone other than the first rotator replays, even inside the grace window', async () => {
    const events: Array<Record<string, unknown>> = []
    ;(w.mcp.oauth as unknown as { onSecurityEvent: (e: unknown) => void }).onSecurityEvent = (e) =>
      events.push(e as Record<string, unknown>)
    const { id, tokens } = await fullFlow()
    const next = (await (await refresh(id, tokens.refresh_token!)).json()) as Tokens
    const thief = await refresh(id, tokens.refresh_token!, 'curl/8')
    expect(await thief.json()).toMatchObject({ error: 'invalid_grant' })
    expect((await mcpStatus(next.access_token)).status).toBe(401)
    expect(events[0]).toMatchObject({ sameFingerprint: false, withinGrace: true, revoked: true })
    expect([...w.oauthStore.grants.values()][0]!.flagReason).toMatch(/revoked/)
  })
})

describe('retention', () => {
  it('deletes exchanged authorizations and revoked grants after 30 days — metadata-document grants too', async () => {
    const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata'
    w.metadataDocuments.set(CLAUDE_CODE, {
      body: {
        client_id: CLAUDE_CODE,
        client_name: 'Claude Code',
        redirect_uris: ['http://127.0.0.1/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    })
    const { tokens: live } = await fullFlow()
    // A metadata-document grant is never swept with a stale registration:
    // only retention removes it once revoked.
    const { verifier, challenge } = pkce()
    const code = await approve(CLAUDE_CODE, challenge, 'user-2')
    const tokens = (await (await exchange(CLAUDE_CODE, code, verifier)).json()) as Tokens
    await form('/oauth/revoke', { token: tokens.refresh_token!, client_id: CLAUDE_CODE })

    w.advance(RETENTION_MS - 60_000)
    expect(await w.mcp.oauth.runMaintenance()).toMatchObject({
      purgedAuthorizations: 0,
      purgedGrants: 0,
    })
    w.advance(120_000)
    const purged = await w.mcp.oauth.runMaintenance()
    expect(purged.purgedGrants).toBe(1)
    // Both exchanged authorizations (the live grant's too: 30 days is past code replay).
    expect(purged.purgedAuthorizations).toBe(2)
    expect([...w.oauthStore.grants.values()].map((g) => g.userSub)).toEqual(['user-1'])
    expect(w.oauthStore.authorizations.size).toBe(0)
    expect(live.refresh_token).toMatch(/^nmr_/)
  })
})

describe('the account kill switch reaches pending authorizations', () => {
  it('makes a code approved before it unexchangeable, and a pending consent undecidable', async () => {
    const id = await clientId()
    const { verifier, challenge } = pkce()
    const code = await approve(id, challenge)
    const pending = await consent(id, pkce().challenge)
    await w.oauthStore.revokeAllForUser('user-1', new Date(Date.now() + 1))
    w.advance(1000)
    const res = await exchange(id, code, verifier)
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' })
    expect(w.oauthStore.grants.size).toBe(0)
    const late = await form(
      '/oauth/authorize/decision',
      { request: pending.request, csrf: pending.csrf, decision: 'approve' },
      { ...session('user-1'), origin: w.baseUrl },
    )
    expect(late.status).toBe(400)
  })
})
