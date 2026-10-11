import { describe, expect, it } from 'vitest'
import { PKCE_CHALLENGE, PKCE_VERIFIER, s256, s256Matches } from './pkce.js'

// RFC 7636 Appendix B.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

describe('pkce', () => {
  it('computes the RFC 7636 S256 example', () => {
    expect(s256(RFC_VERIFIER)).toBe(RFC_CHALLENGE)
    expect(PKCE_CHALLENGE.test(RFC_CHALLENGE)).toBe(true)
  })

  it('accepts the verifier that produced the challenge', () => {
    expect(s256Matches(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true)
  })

  it('rejects another verifier, a malformed one, and a challenge of another length', () => {
    expect(s256Matches(RFC_VERIFIER.replace(/.$/, 'Y'), RFC_CHALLENGE)).toBe(false)
    expect(s256Matches('too-short', s256('too-short'))).toBe(false)
    expect(s256Matches(RFC_VERIFIER, RFC_CHALLENGE.slice(1))).toBe(false)
  })

  it('bounds the verifier to 43–128 unreserved characters', () => {
    expect(PKCE_VERIFIER.test('a'.repeat(42))).toBe(false)
    expect(PKCE_VERIFIER.test('a'.repeat(43))).toBe(true)
    expect(PKCE_VERIFIER.test('a'.repeat(128))).toBe(true)
    expect(PKCE_VERIFIER.test('a'.repeat(129))).toBe(false)
    expect(PKCE_VERIFIER.test(`${'a'.repeat(42)}+`)).toBe(false)
  })
})
