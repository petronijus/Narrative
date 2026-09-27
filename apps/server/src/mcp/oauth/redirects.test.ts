/**
 * mcp/oauth/redirects.test.ts — the redirect URI allowlist and matching: the
 * claude.ai callback exactly, Claude Code's loopback callbacks on any port,
 * the operator's extras, and nothing else.
 */

import { describe, expect, it } from 'vitest'
import { buildMcpPublicConfig, DEFAULT_REDIRECT_URIS } from '../config.js'
import {
  isLoopbackRedirect,
  onlyLoopbackRedirects,
  redirectUriAllowed,
  redirectUriRegistrationProblem,
  sameRedirect,
} from './redirects.js'

describe('the built-in allowlist', () => {
  it('is exactly the claude.ai callback and Claude Code’s loopback callbacks', () => {
    expect(DEFAULT_REDIRECT_URIS).toEqual([
      'https://claude.ai/api/mcp/auth_callback',
      'http://localhost/callback',
      'http://127.0.0.1/callback',
    ])
  })

  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'http://localhost:54321/callback',
    'http://127.0.0.1:1/callback',
    'http://localhost/callback',
  ])('allows %s', (uri) => {
    expect(redirectUriAllowed(uri, DEFAULT_REDIRECT_URIS)).toBe(true)
    expect(redirectUriRegistrationProblem(uri, DEFAULT_REDIRECT_URIS)).toBeNull()
  })

  it.each([
    'https://claude.com/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/auth_callback/',
    'https://claude.ai/api/mcp/auth_callback?x=1',
    'http://claude.ai/api/mcp/auth_callback',
    'http://localhost:54321/oauth/callback',
    'http://127.0.0.1:1/callback?x=1',
    'http://[::1]:1/callback',
    'http://127.0.0.2/callback',
    'http://localhost.evil.example/callback',
    'http://127.0.0.1/callback#frag',
    'http://user@127.0.0.1/callback',
  ])('refuses %s', (uri) => {
    expect(redirectUriAllowed(uri, DEFAULT_REDIRECT_URIS)).toBe(false)
    expect(redirectUriRegistrationProblem(uri, DEFAULT_REDIRECT_URIS)).not.toBeNull()
  })
})

describe('sameRedirect', () => {
  it('ignores the port of loopback URIs only', () => {
    expect(sameRedirect('http://127.0.0.1:1/callback', 'http://127.0.0.1:2/callback')).toBe(true)
    expect(sameRedirect('http://127.0.0.1/callback', 'http://localhost/callback')).toBe(false)
    expect(sameRedirect('https://a.example:8443/cb', 'https://a.example/cb')).toBe(false)
  })
})

describe('MCP_OAUTH_REDIRECT_URIS', () => {
  const config = (extra: string[]) =>
    buildMcpPublicConfig({
      apiBaseUrl: 'https://narrative.example/api',
      spaOrigin: 'https://narrative.example',
      extraRedirectUris: extra,
    })

  it('adds https callbacks and loopback callbacks for other local clients', () => {
    const { allowedRedirectUris } = config([
      'https://tools.example/oauth/cb',
      'http://localhost/oauth/callback',
    ])
    expect(redirectUriAllowed('https://tools.example/oauth/cb', allowedRedirectUris)).toBe(true)
    expect(redirectUriAllowed('http://localhost:6274/oauth/callback', allowedRedirectUris)).toBe(
      true,
    )
  })

  it.each(['http://example.com/cb', 'https://x.example/cb#f', 'ftp://x.example/', 'not a url'])(
    'refuses %s at start',
    (uri) => {
      expect(() => config([uri])).toThrow(/MCP_OAUTH_REDIRECT_URIS/)
    },
  )
})

describe('loopback helpers', () => {
  it('knows loopback callbacks and loopback-only clients', () => {
    expect(isLoopbackRedirect('http://localhost:9/callback')).toBe(true)
    expect(isLoopbackRedirect('https://localhost/callback')).toBe(false)
    expect(onlyLoopbackRedirects(['http://localhost/callback', 'http://127.0.0.1/callback'])).toBe(
      true,
    )
    expect(
      onlyLoopbackRedirects([
        'http://localhost/callback',
        'https://claude.ai/api/mcp/auth_callback',
      ]),
    ).toBe(false)
    expect(onlyLoopbackRedirects([])).toBe(false)
  })
})
