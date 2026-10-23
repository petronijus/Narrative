// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { hocuspocusAuthOptions, shareTokenFrom } from './hocuspocusAuth.js'

describe('hocuspocusAuthOptions', () => {
  it('connects a signed-in page to the sync server as it is, with the cookie sentinel', () => {
    expect(hocuspocusAuthOptions('wss://narrative.example/ws', '?slide=2')).toEqual({
      url: 'wss://narrative.example/ws',
      token: 'cookie',
    })
  })

  it("puts a share link's token into the WebSocket URL, where the server reads it", () => {
    const { url, token } = hocuspocusAuthOptions('wss://narrative.example/ws', '?share_token=a+b/c')
    expect(token).toBe('cookie')
    expect(new URL(url).pathname).toBe('/ws')
    expect(new URL(url).searchParams.get('share_token')).toBe('a b/c')
  })

  it('keeps what the base URL already carries', () => {
    const { url } = hocuspocusAuthOptions('ws://localhost:3002/?x=1', '?share_token=tok')
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ x: '1', share_token: 'tok' })
  })
})

describe('shareTokenFrom', () => {
  it('reads the share token of a page, or null', () => {
    expect(shareTokenFrom('?share_token=tok&y=2')).toBe('tok')
    expect(shareTokenFrom('')).toBeNull()
  })
})
