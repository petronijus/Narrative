// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { withShareToken } from './shareToken'

describe('withShareToken', () => {
  it('appends the token as a query parameter', () => {
    expect(withShareToken('/api/decks/d1/fonts', 'tok')).toBe('/api/decks/d1/fonts?share_token=tok')
    expect(withShareToken('/api/media/a/url?variant=thumb', 'tok')).toBe(
      '/api/media/a/url?variant=thumb&share_token=tok',
    )
  })

  it('encodes it', () => {
    expect(withShareToken('/x', 'a b&c')).toBe('/x?share_token=a%20b%26c')
  })

  it('leaves the URL alone without a token', () => {
    expect(withShareToken('/x', null)).toBe('/x')
    expect(withShareToken('/x', '')).toBe('/x')
  })
})
