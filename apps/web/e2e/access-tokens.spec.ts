/**
 * access-tokens.spec.ts
 *
 * Account settings → Access tokens (agentic A1), driven through the real UI
 * against the dev stack (BYPASS_AUTH → dev-user):
 *
 *   user menu → Access tokens → create (name, scopes, expiry) → the secret is
 *   shown once → it is a live credential → closing the dialog forgets it →
 *   revoke with confirmation → the credential is dead.
 *
 * "Live credential" is checked against the server, not the DOM: a valid PAT
 * on a browser route gets 403 `token_not_accepted` (PATs only open the agent
 * surface), an invalid or revoked one gets 401.
 *
 * Connected apps: a connection is seeded through the real MCP OAuth flow over
 * HTTP (the client, authorize with PKCE, the consent page and its form, the
 * code exchange), so the page shows what a Claude client would have created;
 * disconnecting it in the UI must kill the app's access token on /mcp.
 *
 * The client is whatever the server offers, read from its metadata: dynamic
 * registration when it advertises `registration_endpoint`
 * (MCP_OAUTH_DCR_ENABLED=true), otherwise — the default — Claude Code's
 * Client ID Metadata Document (https://claude.ai/oauth/claude-code-client-metadata),
 * which the DEV SERVER FETCHES FROM claude.ai: that variant needs network
 * access to claude.ai, and claude.ai on MCP_OAUTH_CIMD_HOSTS (the default).
 */

import { createHash, randomBytes } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'

const SERVER = 'http://localhost:3001'

/**
 * Connect an OAuth client for the signed-in (dev) user the way an MCP client
 * does, and return its access token. Every step asserts the protocol answer,
 * so a broken flow fails here with a clear step rather than in the UI.
 */
const CLAUDE_CODE_CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata'

/**
 * The client to connect as: a fresh registration named `wantedName` when the
 * server offers dynamic registration, else Claude Code's metadata document
 * (whose name is fixed: "Claude Code").
 */
async function oauthClient(
  request: APIRequestContext,
  wantedName: string,
  redirectUri: string,
): Promise<{ clientId: string; clientName: string }> {
  const metadata = await request.get(`${SERVER}/.well-known/oauth-authorization-server`)
  expect(metadata.status()).toBe(200)
  const { registration_endpoint: registrationEndpoint } = (await metadata.json()) as {
    registration_endpoint?: string
  }
  if (registrationEndpoint === undefined) {
    return { clientId: CLAUDE_CODE_CLIENT_ID, clientName: 'Claude Code' }
  }
  const registered = await request.post(`${SERVER}/oauth/register`, {
    data: {
      client_name: wantedName,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    },
  })
  expect(registered.status()).toBe(201)
  const { client_id: clientId } = (await registered.json()) as { client_id: string }
  return { clientId, clientName: wantedName }
}

async function connectOAuthApp(
  request: APIRequestContext,
  wantedName: string,
): Promise<{ accessToken: string; clientName: string; connectionId: string }> {
  const redirectUri = 'http://127.0.0.1:1/callback'
  const { clientId, clientName } = await oauthClient(request, wantedName, redirectUri)

  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(8).toString('hex')
  const authorize = await request.get(`${SERVER}/oauth/authorize`, {
    params: {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'mcp',
      resource: `${SERVER}/mcp`,
      state,
    },
    maxRedirects: 0,
  })
  expect(authorize.status()).toBe(302)
  const consentUrl = authorize.headers()['location']!
  expect(consentUrl).toContain('/oauth/authorize/consent?request=')

  const consent = await request.get(consentUrl, { maxRedirects: 0 })
  expect(consent.status()).toBe(200)
  const html = await consent.text()
  const field = (name: string): string => {
    const m = new RegExp(`name="${name}" value="([^"]+)"`).exec(html)
    expect(m, `consent form field ${name}`).not.toBeNull()
    return m![1]!.replace(/&amp;/g, '&')
  }

  const decision = await request.post(`${SERVER}/oauth/authorize/decision`, {
    form: { request: field('request'), csrf: field('csrf'), decision: 'approve' },
    headers: { origin: SERVER },
    maxRedirects: 0,
  })
  expect(decision.status()).toBe(303)
  const callback = new URL(decision.headers()['location']!)
  expect(callback.searchParams.get('state')).toBe(state)
  const code = callback.searchParams.get('code')
  expect(code).not.toBeNull()

  const token = await request.post(`${SERVER}/oauth/token`, {
    form: {
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    },
  })
  expect(token.status()).toBe(200)
  const { access_token: accessToken } = (await token.json()) as { access_token: string }
  expect(accessToken).toMatch(/^nmo_/)
  // The connection just made: connections are listed newest first.
  const list = await request.get(`${SERVER}/oauth/connections`)
  const { connections } = (await list.json()) as {
    connections: Array<{ id: string; clientName: string }>
  }
  const connection = connections.find((c) => c.clientName === clientName)
  expect(connection, 'the new connection is listed').toBeDefined()
  return { accessToken, clientName, connectionId: connection!.id }
}

/** Status of an unsessioned /mcp request: 400 (no session) once authenticated, 401 when not. */
async function mcpStatus(request: APIRequestContext, accessToken: string): Promise<number> {
  const res = await request.get(`${SERVER}/mcp`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'text/event-stream' },
  })
  return res.status()
}

test.describe('Access tokens', () => {
  test('create shows the token once; revoke kills it', async ({ page }) => {
    test.setTimeout(60_000)
    const name = `e2e token ${Date.now()}`

    await page.goto('/')
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'Access tokens' }).click()
    await expect(page).toHaveURL(/\/settings\/access-tokens$/)

    // Create: MCP is preselected; add API, pick 30 days.
    await page.getByRole('button', { name: 'New token' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name').fill(name)
    await dialog.getByRole('checkbox', { name: /API/ }).check()
    await dialog.getByLabel('Expires').selectOption('30')
    await dialog.getByRole('button', { name: 'Create token' }).click()

    // The secret, shown once.
    const tokenField = dialog.getByLabel('New access token')
    await expect(tokenField).toHaveValue(/^nrt_[A-Za-z0-9_-]{43}$/)
    const token = await tokenField.inputValue()
    // The Claude Code command carries it (MCP scope).
    await expect(dialog.locator('pre')).toContainText(`Authorization: Bearer ${token}`)

    // It is a live credential — and a browser route refuses it by design.
    const live = await page.request.get(`${SERVER}/decks`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(live.status()).toBe(403)
    expect(await live.json()).toMatchObject({ error: 'token_not_accepted' })

    // Closing the dialog forgets the secret: it is nowhere on the page.
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await page.content()).not.toContain(token)

    // The list shows the token by name and prefix.
    const row = page.getByRole('listitem').filter({ hasText: name })
    await expect(row).toContainText(token.slice(0, 10))

    // Revoke, confirming in the dialog.
    await row.getByRole('button', { name: `Revoke ${name}` }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke token' }).click()
    await expect(page.getByRole('listitem').filter({ hasText: name })).toHaveCount(0)

    const dead = await page.request.get(`${SERVER}/decks`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(dead.status()).toBe(401)
  })

  test('connected apps: an OAuth connection is listed and Disconnect revokes it', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    const { accessToken, clientName, connectionId } = await connectOAuthApp(
      page.request,
      `E2E connector ${Date.now()}`,
    )
    // The app's token opens /mcp (past auth, the request lacks a session: 400).
    expect(await mcpStatus(page.request, accessToken)).toBe(400)

    await page.goto('/settings/access-tokens')
    const apps = page.getByRole('region', { name: 'Your connected apps' })
    // With a metadata-document client the name is not unique (earlier runs,
    // a developer's own Claude Code): the list is newest first, ours is first.
    const rows = apps.getByRole('listitem').filter({ hasText: clientName })
    const row = rows.first()
    await expect(row).toBeVisible()
    const before = await rows.count()
    // A loopback callback is a program on this computer, whatever its port.
    await expect(row).toContainText('Returns to this computer')

    // Cancel keeps it.
    await row.getByRole('button', { name: `Disconnect ${clientName}` }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(rows).toHaveCount(before)
    expect(await mcpStatus(page.request, accessToken)).toBe(400)

    // Disconnect, confirming in the dialog.
    await row.getByRole('button', { name: `Disconnect ${clientName}` }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(rows).toHaveCount(before - 1)

    // The server agrees: the connection is gone and its token is dead.
    const list = await page.request.get(`${SERVER}/oauth/connections`)
    const { connections } = (await list.json()) as { connections: Array<{ id: string }> }
    expect(connections.map((c) => c.id)).not.toContain(connectionId)
    expect(await mcpStatus(page.request, accessToken)).toBe(401)
  })
})
