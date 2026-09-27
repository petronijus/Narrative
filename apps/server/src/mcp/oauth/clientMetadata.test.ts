/**
 * mcp/oauth/clientMetadata.test.ts — Client ID Metadata Documents: the
 * client_id URL rules, document validation, the Cache-Control bounds, and
 * the resolver's cache (lifetime, failures, concurrent resolutions, size).
 * The HTTP flow with a metadata-document client is in oauth.test.ts; the
 * SSRF guard the production fetcher uses is in net/ssrfGuard.test.ts.
 */

import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_REDIRECT_URIS } from '../config.js'
import {
  CIMD_DEFAULT_TTL_MS,
  CIMD_FAILURE_TTL_MS,
  CIMD_MAX_TTL_MS,
  ClientMetadataError,
  cacheLifetimeMs,
  clientIdUrlProblem,
  createClientMetadataResolver,
  parseClientMetadataDocument,
  type FetchedClientMetadata,
} from './clientMetadata.js'
import { SUPPORTED_SCOPES } from './service.js'

const URL_ = 'https://claude.ai/oauth/claude-code-client-metadata'
const DOC = {
  client_id: URL_,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}
const OPTS = { allowedRedirectUris: DEFAULT_REDIRECT_URIS, supportedScopes: SUPPORTED_SCOPES }

describe('clientIdUrlProblem', () => {
  it('accepts a canonical https URL with a path', () => {
    expect(clientIdUrlProblem(URL_)).toBeNull()
  })

  it.each([
    ['http', 'http://claude.ai/oauth/x'],
    ['no path', 'https://claude.ai'],
    ['the root path', 'https://claude.ai/'],
    ['a dot segment', 'https://claude.ai/a/./b'],
    ['a dot-dot segment', 'https://claude.ai/a/../b'],
    ['a query', 'https://claude.ai/a?b=1'],
    ['a fragment', 'https://claude.ai/a#b'],
    ['credentials', 'https://u:p@claude.ai/a'],
    ['a non-canonical host', 'https://Claude.AI/a'],
    ['a default port spelled out', 'https://claude.ai:443/a'],
    ['too long', `https://claude.ai/${'a'.repeat(600)}`],
    ['not a URL', 'https://'],
  ])('refuses %s', (_label, id) => {
    expect(clientIdUrlProblem(id)).not.toBeNull()
  })
})

describe('parseClientMetadataDocument', () => {
  it('accepts Claude Code’s document', () => {
    expect(parseClientMetadataDocument(URL_, DOC, OPTS)).toEqual({
      clientId: URL_,
      clientName: 'Claude Code',
      redirectUris: DOC.redirect_uris,
      clientUri: 'https://claude.ai',
      host: 'claude.ai',
      scopes: ['mcp', 'offline_access'],
      grantTypes: ['authorization_code', 'refresh_token'],
    })
  })

  it('sanitises the name like a peer label: control, bidi and markup characters go', () => {
    expect(
      parseClientMetadataDocument(URL_, { ...DOC, client_name: 'Claude\u0007 Code\n' }, OPTS)
        .clientName,
    ).toBe('Claude Code')
    expect(
      parseClientMetadataDocument(
        URL_,
        { ...DOC, client_name: '\u202eClaude <b>Code</b>' + 'x'.repeat(200) },
        OPTS,
      ).clientName,
    ).toMatch(/^Claude bCode\/bx+…$/)
  })

  it('keeps the declared scope and grant types, with the RFC 7591 defaults', () => {
    const declared = parseClientMetadataDocument(
      URL_,
      { ...DOC, scope: 'mcp', grant_types: ['authorization_code'] },
      OPTS,
    )
    expect(declared.scopes).toEqual(['mcp'])
    expect(declared.grantTypes).toEqual(['authorization_code'])
    const bare = parseClientMetadataDocument(URL_, { ...DOC, grant_types: undefined }, OPTS)
    expect(bare.scopes).toEqual(['mcp', 'offline_access'])
    expect(bare.grantTypes).toEqual(['authorization_code'])
  })

  it.each([
    ['not an object', []],
    ['another client_id', { ...DOC, client_id: `${URL_}-2` }],
    ['no client_name', { ...DOC, client_name: undefined }],
    ['a blank client_name', { ...DOC, client_name: '  ' }],
    ['a client_name of invisible characters only', { ...DOC, client_name: '\u200b\u202e<>' }],
    ['no redirect_uris', { ...DOC, redirect_uris: [] }],
    ['an https callback off the allowlist', { ...DOC, redirect_uris: ['https://evil.example/cb'] }],
    ['an IPv6 loopback callback', { ...DOC, redirect_uris: ['http://[::1]/callback'] }],
    ['client_secret_post', { ...DOC, token_endpoint_auth_method: 'client_secret_post' }],
    ['private_key_jwt', { ...DOC, token_endpoint_auth_method: 'private_key_jwt' }],
    ['a client secret', { ...DOC, client_secret: 'shh' }],
    ['the implicit grant', { ...DOC, grant_types: ['implicit'] }],
    ['a token response type', { ...DOC, response_types: ['token'] }],
    ['an unknown scope', { ...DOC, scope: 'mcp admin' }],
  ])('refuses %s', (_label, doc) => {
    expect(() => parseClientMetadataDocument(URL_, doc, OPTS)).toThrow(ClientMetadataError)
  })
})

describe('cacheLifetimeMs', () => {
  it.each([
    [null, CIMD_DEFAULT_TTL_MS],
    ['public, max-age=300', 300_000],
    ['max-age="60"', 60_000],
    ['max-age=0', 0],
    ['no-store', 0],
    ['public, no-cache, max-age=600', 0],
    ['max-age=99999999', CIMD_MAX_TTL_MS],
    ['public', CIMD_DEFAULT_TTL_MS],
  ])('%s → %d ms', (header, ms) => {
    expect(cacheLifetimeMs(header)).toBe(ms)
  })
})

describe('createClientMetadataResolver', () => {
  function setup(
    serve: (url: string) => FetchedClientMetadata | Promise<FetchedClientMetadata>,
    extra: { maxEntries?: number } = {},
  ) {
    let now = 1_000_000
    const fetch = vi.fn(async (url: string) => serve(url))
    const resolver = createClientMetadataResolver({
      ...OPTS,
      fetch,
      now: () => now,
      ...extra,
    })
    return { resolver, fetch, advance: (ms: number) => (now += ms) }
  }
  const json = (body: unknown, cacheControl: string | null = null): FetchedClientMetadata => ({
    body: Buffer.from(JSON.stringify(body)),
    contentType: 'application/json',
    cacheControl,
  })

  it('caches a document for its lifetime, then fetches it again', async () => {
    const { resolver, fetch, advance } = setup(() => json(DOC, 'max-age=300'))
    await resolver.resolve(URL_)
    await resolver.resolve(URL_)
    expect(fetch).toHaveBeenCalledTimes(1)
    advance(300_001)
    await resolver.resolve(URL_)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not cache a no-store document', async () => {
    const { resolver, fetch } = setup(() => json(DOC, 'no-store'))
    await resolver.resolve(URL_)
    await resolver.resolve(URL_)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('remembers a failure briefly, so a broken host is not fetched on every request', async () => {
    let fail = true
    const { resolver, fetch, advance } = setup(() => {
      if (fail) throw new Error('ECONNREFUSED')
      return json(DOC)
    })
    await expect(resolver.resolve(URL_)).rejects.toThrow(/could not be fetched/)
    fail = false
    await expect(resolver.resolve(URL_)).rejects.toThrow(ClientMetadataError)
    expect(fetch).toHaveBeenCalledTimes(1)
    advance(CIMD_FAILURE_TTL_MS + 1)
    await expect(resolver.resolve(URL_)).resolves.toMatchObject({ clientName: 'Claude Code' })
  })

  it('shares one fetch between concurrent resolutions', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { resolver, fetch } = setup(async () => {
      await gate
      return json(DOC)
    })
    const both = Promise.all([resolver.resolve(URL_), resolver.resolve(URL_)])
    release()
    await both
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses a document not served as JSON, or not parseable', async () => {
    const html = setup(() => ({ ...json(DOC), contentType: 'text/html' }))
    await expect(html.resolver.resolve(URL_)).rejects.toThrow(/not served as JSON/)
    const broken = setup(() => ({ ...json(DOC), body: Buffer.from('{') }))
    await expect(broken.resolver.resolve(URL_)).rejects.toThrow(/not valid JSON/)
  })

  it('never fetches an unusable client_id URL', async () => {
    const { resolver, fetch } = setup(() => json(DOC))
    await expect(resolver.resolve('https://claude.ai/')).rejects.toThrow(ClientMetadataError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('evicts the least recently used document beyond its size', async () => {
    const other = 'https://example.com/client'
    const { resolver, fetch } = setup((url) => json({ ...DOC, client_id: url }, 'max-age=3600'), {
      maxEntries: 1,
    })
    await resolver.resolve(URL_)
    await resolver.resolve(other)
    await resolver.resolve(URL_)
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([URL_, other, URL_])
  })
})
