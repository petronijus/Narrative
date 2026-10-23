// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveHttpUrl, resolveWsUrl } from './endpoints'

describe('resolveHttpUrl', () => {
  it('keeps an absolute base (development)', () => {
    expect(resolveHttpUrl('http://localhost:3001', 'http://localhost:5173/deck/x')).toBe(
      'http://localhost:3001',
    )
  })

  it('resolves a relative base against the page origin (production, the render worker)', () => {
    expect(resolveHttpUrl('/api', 'https://narrative.example.com/deck/x?slide=2')).toBe(
      'https://narrative.example.com/api',
    )
    expect(resolveHttpUrl('/api', 'http://caddy/render/x')).toBe('http://caddy/api')
  })

  it('drops a trailing slash so `${base}/path` never doubles it', () => {
    expect(resolveHttpUrl('/api/', 'https://n.example/')).toBe('https://n.example/api')
  })

  it("keeps '' as a same-origin prefix", () => {
    expect(resolveHttpUrl('', 'https://n.example/deck/x')).toBe('')
  })
})

describe('resolveWsUrl', () => {
  it('keeps an absolute ws URL (development)', () => {
    expect(resolveWsUrl('ws://localhost:3002', 'http://localhost:5173/')).toBe(
      'ws://localhost:3002',
    )
  })

  it('maps a relative path to wss on an https page and ws on an http page', () => {
    expect(resolveWsUrl('/ws', 'https://narrative.example.com/deck/x')).toBe(
      'wss://narrative.example.com/ws',
    )
    expect(resolveWsUrl('/ws', 'http://caddy/render/x')).toBe('ws://caddy/ws')
  })
})
