/**
 * mcp/config.test.ts — the MCP server's public URLs from the environment:
 * PUBLIC_API_URL, and the defaults when it is unset. In production the
 * default must come from the SPA origin (the server container is never given
 * DOMAIN), so the resource is https://<domain>/api/mcp, never localhost.
 * Also MCP_OAUTH_CIMD_HOSTS and MCP_OAUTH_DCR_ENABLED.
 */

import { describe, expect, it } from 'vitest'
import { mcpPublicConfigFromEnv } from './config.js'

describe('mcpPublicConfigFromEnv', () => {
  it('defaults production to <SPA origin>/api, whatever DOMAIN says', () => {
    const c = mcpPublicConfigFromEnv(
      {},
      {
        apiPort: 3001,
        isProd: true,
        spaOrigin: 'https://narrative.example/',
      },
    )
    expect(c.resource).toBe('https://narrative.example/api/mcp')
    expect(c.issuer).toBe('https://narrative.example/api')
    expect(c.resourceMetadataUrl).toBe(
      'https://narrative.example/api/.well-known/oauth-protected-resource/mcp',
    )
  })

  it('defaults development to the API port on localhost', () => {
    const c = mcpPublicConfigFromEnv(
      {},
      {
        apiPort: 4001,
        isProd: false,
        spaOrigin: 'http://localhost:5173',
      },
    )
    expect(c.resource).toBe('http://localhost:4001/mcp')
  })

  it('takes PUBLIC_API_URL and MCP_OAUTH_REDIRECT_URIS when set', () => {
    const c = mcpPublicConfigFromEnv(
      {
        PUBLIC_API_URL: 'https://api.narrative.example/',
        MCP_OAUTH_REDIRECT_URIS: ' https://tools.example/cb , http://localhost/oauth/callback ',
      },
      { apiPort: 3001, isProd: true, spaOrigin: 'https://narrative.example' },
    )
    expect(c.resource).toBe('https://api.narrative.example/mcp')
    expect(c.allowedRedirectUris).toEqual([
      'https://claude.ai/api/mcp/auth_callback',
      'http://localhost/callback',
      'http://127.0.0.1/callback',
      'https://tools.example/cb',
      'http://localhost/oauth/callback',
    ])
  })

  it('accepts Claude’s metadata documents and refuses dynamic registration by default', () => {
    const c = mcpPublicConfigFromEnv(
      { MCP_OAUTH_CIMD_HOSTS: '  ', MCP_OAUTH_DCR_ENABLED: '' },
      { apiPort: 3001, isProd: true, spaOrigin: 'https://narrative.example' },
    )
    expect(c.cimdHosts).toEqual(['claude.ai'])
    expect(c.dcrEnabled).toBe(false)
  })

  it('takes MCP_OAUTH_CIMD_HOSTS (or none) and MCP_OAUTH_DCR_ENABLED=true', () => {
    const defaults = { apiPort: 3001, isProd: true, spaOrigin: 'https://narrative.example' }
    const c = mcpPublicConfigFromEnv(
      { MCP_OAUTH_CIMD_HOSTS: 'claude.ai, Tools.Example:8443', MCP_OAUTH_DCR_ENABLED: 'TRUE' },
      defaults,
    )
    expect(c.cimdHosts).toEqual(['claude.ai', 'tools.example:8443'])
    expect(c.dcrEnabled).toBe(true)
    expect(mcpPublicConfigFromEnv({ MCP_OAUTH_CIMD_HOSTS: 'none' }, defaults).cimdHosts).toEqual([])
  })

  it('fails the start on an unusable CIMD host or DCR flag', () => {
    const defaults = { apiPort: 3001, isProd: true, spaOrigin: 'https://narrative.example' }
    expect(() =>
      mcpPublicConfigFromEnv({ MCP_OAUTH_CIMD_HOSTS: 'https://claude.ai/oauth' }, defaults),
    ).toThrow(/MCP_OAUTH_CIMD_HOSTS/)
    expect(() => mcpPublicConfigFromEnv({ MCP_OAUTH_DCR_ENABLED: 'yes' }, defaults)).toThrow(
      /MCP_OAUTH_DCR_ENABLED/,
    )
  })
})
