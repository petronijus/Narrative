/**
 * mcp/urlFetch.test.ts — a `{ url }` file source is an exfiltration channel,
 * so over MCP it runs only after the user confirmed its host (unless every
 * host is on AGENT_URL_FETCH_ALLOWED_HOSTS), every contacted host is logged
 * (`agent_ops.fetched_hosts`), and an allowlisted fetch may not be
 * redirected off the allowlist. Uses the test-only `media.fakeFetch`
 * (test-support/fakeCommands.ts), which downloads through the real SSRF
 * guard from a local server that answers for every host name.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createMcpWorld, type McpWorld } from '../test-support/mcpWorld.js'
import { setFakeFetchNetwork } from '../test-support/fakeCommands.js'

let server: http.Server
let port = 0

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { location: `http://evil.example:${port}/leak` })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end('PNGDATA')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  setFakeFetchNetwork(port)
})

afterAll(async () => {
  setFakeFetchNetwork(null)
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

let w: McpWorld | null = null
afterEach(async () => {
  await w?.destroy()
  w = null
})

async function world(allowed?: string[]): Promise<{ w: McpWorld; client: Client }> {
  w = await createMcpWorld(allowed === undefined ? {} : { urlFetchAllowedHosts: allowed })
  w.world.createDeck('deck1')
  w.world.grant('deck1', 'user-1', 'editor')
  const client = await w.client(await w.token('user-1'))
  return { w, client }
}

const call = (client: Client, args: Record<string, unknown>) =>
  client.callTool({ name: 'media_fakeFetch', arguments: args }) as Promise<CallToolResult>

const fetchOps = (world: McpWorld) =>
  world.world.store.ops.filter((o) => o.command === 'media.fakeFetch')

describe('URL downloads over MCP', () => {
  it('needs the user to confirm the host, then logs every host contacted', async () => {
    const { w, client } = await world()
    const url = `http://files.example:${port}/a.png?token=secret`
    const refused = await call(client, { deckId: 'deck1', file: { url } })
    expect(refused.structuredContent).toMatchObject({ error: { code: 'confirmation_required' } })
    const text = (refused.content[0] as { text: string }).text
    expect(text).toContain(`Downloads from: files.example:${port}`)
    expect(text).not.toContain('secret')
    expect(fetchOps(w)).toEqual([])

    const { confirmationId } = (
      refused.structuredContent as { error: { confirmation: { confirmationId: string } } }
    ).error.confirmation
    const view = w.world.runtime.confirmations.viewForUser(confirmationId, 'user-1')!
    expect(view.summary.reasons).toEqual(['url_fetch'])
    expect(view.summary.hosts).toEqual([`files.example:${port}`])
    w.world.runtime.confirmations.decide(confirmationId, 'user-1', true)

    const done = await call(client, { deckId: 'deck1', file: { url }, confirmationId })
    expect(done.isError).toBeFalsy()
    expect(fetchOps(w)[0]).toMatchObject({
      fetchedHosts: [`files.example:${port}`],
      confirmation: {
        via: 'out_of_band',
        reasons: ['url_fetch'],
        hosts: [`files.example:${port}`],
      },
    })
  })

  it('asks nothing for inline bytes', async () => {
    const { w, client } = await world()
    const done = await call(client, { deckId: 'deck1', file: { base64: 'AAAA' } })
    expect(done.isError).toBeFalsy()
    expect(fetchOps(w)[0]!.fetchedHosts).toBeUndefined()
  })

  it('lets allowlisted hosts through without a confirmation', async () => {
    const { w, client } = await world(['files.example'])
    const done = await call(client, {
      deckId: 'deck1',
      file: { url: `http://files.example:${port}/a.png` },
    })
    expect(done.isError).toBeFalsy()
    expect(fetchOps(w)[0]).toMatchObject({ fetchedHosts: [`files.example:${port}`] })
    expect(fetchOps(w)[0]!.confirmation).toBeUndefined()
  })

  it('refuses an allowlisted download that redirects off the allowlist', async () => {
    const { w, client } = await world(['files.example'])
    const result = await call(client, {
      deckId: 'deck1',
      file: { url: `http://files.example:${port}/redirect` },
    })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/evil\.example/)
    expect(fetchOps(w)[0]).toMatchObject({ fetchedHosts: [`files.example:${port}`] })
  })

  it('follows the redirect when the user confirmed the host, and logs both hosts', async () => {
    const { w, client } = await world()
    const url = `http://files.example:${port}/redirect`
    const refused = await call(client, { deckId: 'deck1', file: { url } })
    const { confirmationId } = (
      refused.structuredContent as { error: { confirmation: { confirmationId: string } } }
    ).error.confirmation
    w.world.runtime.confirmations.decide(confirmationId, 'user-1', true)
    const done = await call(client, { deckId: 'deck1', file: { url }, confirmationId })
    expect(done.isError).toBeFalsy()
    expect(fetchOps(w).at(-1)).toMatchObject({
      fetchedHosts: [`files.example:${port}`, `evil.example:${port}`],
    })
  })

  it('needs a confirmation on the command API too, given as the explicit list', async () => {
    const { w } = await world()
    const input = { file: { url: `http://files.example:${port}/a.png` } }
    const base = {
      actor: { userId: 'user-1' },
      surface: 'api' as const,
      target: { deckId: 'deck1' },
      invocation: { command: 'media.fakeFetch', input },
    }
    const refused = await w.world.runtime.host.execute(base)
    expect(refused).toMatchObject({ ok: false, error: { code: 'confirmation_required' } })
    const done = await w.world.runtime.host.execute({
      ...base,
      confirmation: { via: 'explicit', commands: ['media.fakeFetch'] },
    })
    expect(done).toMatchObject({ ok: true, result: { bytes: 7 } })
  })
})
