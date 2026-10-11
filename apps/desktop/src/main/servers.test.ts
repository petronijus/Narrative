import { describe, expect, it } from 'vitest'
import servers from '../../servers.json'
import {
  apiUrl,
  displayHost,
  feedBase,
  normalizeCustomOrigin,
  parseServerArg,
  partitionFor,
  serverOrigin,
} from './servers.js'

describe('servers', () => {
  it('pins production and the dev stack', () => {
    expect(serverOrigin({ kind: 'production' })).toBe('https://narrative.bastla.com')
    expect(apiUrl({ kind: 'production' })).toBe('https://narrative.bastla.com/api')
    expect(serverOrigin({ kind: 'development' })).toBe('http://localhost:5173')
    // The dev web app's API_URL (apps/web/src/lib/endpoints.ts).
    expect(apiUrl({ kind: 'development' })).toBe('http://localhost:3001')
  })

  it('gives each server its own partition and shows the host outside production', () => {
    const custom = { kind: 'custom', origin: 'https://narrative.example.com' } as const
    const partitions = [
      partitionFor({ kind: 'production' }),
      partitionFor({ kind: 'development' }),
      partitionFor(custom),
      partitionFor({ kind: 'custom', origin: 'https://other.example.com' }),
    ]
    expect(new Set(partitions).size).toBe(4)
    expect(partitions.every((p) => p.startsWith('persist:narrative-'))).toBe(true)
    expect(displayHost({ kind: 'production' })).toBeNull()
    expect(displayHost({ kind: 'development' })).toBe('localhost:5173')
    expect(displayHost(custom)).toBe('narrative.example.com')
    expect(apiUrl(custom)).toBe('https://narrative.example.com/api')
  })

  it.each([
    ['https://narrative.example.com', 'https://narrative.example.com'],
    ['https://narrative.example.com/', 'https://narrative.example.com'],
    ['https://narrative.example.com:8443', 'https://narrative.example.com:8443'],
    ['http://localhost:5173', 'http://localhost:5173'],
    ['http://127.0.0.1:5173', 'http://127.0.0.1:5173'],
    ['http://[::1]:5173', 'http://[::1]:5173'],
  ])('accepts %s as a custom server', (raw, origin) => {
    expect(normalizeCustomOrigin(raw)).toBe(origin)
  })

  it.each([
    'http://narrative.example.com',
    'https://narrative.example.com/app',
    'https://narrative.example.com/?x=1',
    'https://narrative.example.com/#x',
    'https://user:pw@narrative.example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'narrative.example.com',
    '',
  ])('refuses %s as a custom server', (raw) => {
    expect(normalizeCustomOrigin(raw)).toBeNull()
  })

  it('reads --server aliases and origins', () => {
    expect(parseServerArg(['x', '--server=prod'])).toEqual({ kind: 'production' })
    expect(parseServerArg(['--server=production'])).toEqual({ kind: 'production' })
    expect(parseServerArg(['--server=dev'])).toEqual({ kind: 'development' })
    expect(parseServerArg(['--server=development'])).toEqual({ kind: 'development' })
    expect(parseServerArg(['--server=http://127.0.0.1:4000'])).toEqual({
      kind: 'custom',
      origin: 'http://127.0.0.1:4000',
    })
    expect(parseServerArg(['--server=http://evil.example'])).toBeNull()
    expect(parseServerArg(['--other'])).toBeNull()
  })

  it('keeps the update feed a directory URL', () => {
    expect(servers.updateFeed.endsWith('/')).toBe(true)
    expect(new URL('narrative-1.0.0.dmg', feedBase()).pathname).toBe('/desktop/narrative-1.0.0.dmg')
  })

  it('pins the update signing key from 1Password', () => {
    expect(servers.updatePublicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=*$/)
  })
})
