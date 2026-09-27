/**
 * e2e/agent-confirm.spec.ts — the agent confirmation page (`/confirm/:id`),
 * end to end against the dev stack (BYPASS_AUTH → dev-user):
 *
 *   an MCP client WITHOUT elicitation calls an irreversible tool
 *   (share_links_create) → the server refuses with confirmation_required and a
 *   Narrative link → the user opens it and sees exactly what will happen (the
 *   deck's title, the role) → Approve → the client retries with the
 *   server-issued confirmationId and the link is created → the same id cannot
 *   be used again. A second request is declined on the page and the retry is
 *   refused with not_confirmed.
 *
 * The MCP client is plain JSON-RPC over Streamable HTTP with a personal
 * access token (created through POST /access-tokens as the dev-user), so the
 * spec needs no MCP SDK. The link it creates is revoked at the end.
 */

import { expect, test, type APIRequestContext } from '@playwright/test'

const SERVER = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'

interface RpcResult {
  result?: {
    isError?: boolean
    content?: Array<{ type: string; text?: string }>
    structuredContent?: Record<string, unknown>
  }
  error?: { message: string }
}

/** A minimal MCP client: initialize once, then tools/call. */
async function mcpSession(request: APIRequestContext, token: string) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  }
  const parse = async (res: Awaited<ReturnType<APIRequestContext['post']>>): Promise<RpcResult> => {
    const body = await res.text()
    if ((res.headers()['content-type'] ?? '').includes('text/event-stream')) {
      const data = body
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => JSON.parse(l.slice(5)) as RpcResult & { id?: unknown })
        .find((m) => m.id !== undefined)
      return data ?? {}
    }
    return JSON.parse(body) as RpcResult
  }
  const init = await request.post(`${SERVER}/mcp`, {
    headers,
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'e2e-no-elicitation', version: '1' },
      },
    },
  })
  expect(init.status()).toBe(200)
  const sessionId = init.headers()['mcp-session-id']!
  expect(sessionId).toBeTruthy()
  const withSession = { ...headers, 'mcp-session-id': sessionId }
  await request.post(`${SERVER}/mcp`, {
    headers: withSession,
    data: { jsonrpc: '2.0', method: 'notifications/initialized' },
  })
  let id = 2
  return {
    async call(
      name: string,
      args: Record<string, unknown>,
    ): Promise<NonNullable<RpcResult['result']>> {
      const res = await request.post(`${SERVER}/mcp`, {
        headers: withSession,
        data: { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } },
      })
      const parsed = await parse(res)
      expect(parsed.error, parsed.error?.message).toBeUndefined()
      return parsed.result!
    },
    async close() {
      await request.delete(`${SERVER}/mcp`, { headers: withSession })
    },
  }
}

function confirmationOf(result: NonNullable<RpcResult['result']>): {
  confirmationId: string
  url: string
} {
  const error = (result.structuredContent as { error: { code: string; confirmation?: unknown } })
    .error
  expect(error.code).toBe('confirmation_required')
  return error.confirmation as { confirmationId: string; url: string }
}

test('an irreversible agent request is approved on the confirmation page', async ({ page }) => {
  const title = `Confirm e2e ${Date.now()}`
  const deck = await page.request.post(`${SERVER}/decks`, { data: { title } })
  expect(deck.ok()).toBe(true)
  const { id: deckId } = (await deck.json()) as { id: string }

  const created = await page.request.post(`${SERVER}/access-tokens`, {
    data: { name: 'e2e confirm', scopes: ['mcp'], expiresInDays: 30 },
  })
  expect(created.status()).toBe(201)
  const { token, accessToken: summary } = (await created.json()) as {
    token: string
    accessToken: { id: string }
  }

  const mcp = await mcpSession(page.request, token)
  try {
    const args = { deckId, role: 'viewer' }
    const refused = await mcp.call('share_links_create', args)
    expect(refused.isError).toBe(true)
    const { confirmationId, url } = confirmationOf(refused)
    expect(url).toMatch(new RegExp(`/confirm/${confirmationId}$`))

    // The page shows what the server built: the deck by its title, the role.
    await page.goto(`/confirm/${confirmationId}`)
    await expect(page.getByRole('heading', { name: /Create a share link/ })).toBeVisible()
    const details = page.getByTestId('confirm-details')
    await expect(details).toContainText(title)
    await expect(details).toContainText('viewer')
    await expect(page.getByText('Only approve if you just asked the agent')).toBeVisible()
    await expect(page.getByText('This cannot be undone with Revert.')).toBeVisible()

    await page.getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByRole('status')).toContainText('You approved this request')

    const done = await mcp.call('share_links_create', { ...args, confirmationId })
    expect(done.isError).toBeFalsy()
    const link = done.structuredContent as { id: string; url: string }
    expect(link.url).toContain('share_token=')

    const again = await mcp.call('share_links_create', { ...args, confirmationId })
    expect(again.isError).toBe(true)

    // Revoking the link needs its own confirmation — declined on the page first.
    const revokeArgs = { deckId, linkId: link.id }
    const revoke = confirmationOf(await mcp.call('share_links_revoke', revokeArgs))
    await page.goto(`/confirm/${revoke.confirmationId}`)
    await page.getByRole('button', { name: 'Decline' }).click()
    await expect(page.getByRole('status')).toContainText('You declined this request')
    const declined = await mcp.call('share_links_revoke', {
      ...revokeArgs,
      confirmationId: revoke.confirmationId,
    })
    expect((declined.structuredContent as { error: { code: string } }).error.code).toBe(
      'not_confirmed',
    )

    // Then approved, which cleans the link up.
    const revoke2 = confirmationOf(await mcp.call('share_links_revoke', revokeArgs))
    await page.goto(`/confirm/${revoke2.confirmationId}`)
    await page.getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByRole('status')).toContainText('You approved this request')
    const revoked = await mcp.call('share_links_revoke', {
      ...revokeArgs,
      confirmationId: revoke2.confirmationId,
    })
    expect(revoked.isError).toBeFalsy()
  } finally {
    await mcp.close()
    await page.request.delete(`${SERVER}/access-tokens/${summary.id}`)
  }
})

test('an unknown confirmation shows nothing to approve', async ({ page }) => {
  await page.goto('/confirm/AAAAAAAAAAAAAAAAAAAAAA')
  await expect(page.getByRole('alert')).toContainText('does not exist')
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0)
})
