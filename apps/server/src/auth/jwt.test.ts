/**
 * auth/jwt.test.ts
 *
 * Tests for JWT verification.
 *
 * Uses jose's SignJWT + generateKeyPair to sign test tokens in-process.
 * The JWKS endpoint is mocked via vi.mock('jose') so no network calls occur.
 *
 * Test strategy:
 *   - We test verifyToken behaviour by calling the real createJwtVerifier
 *     but injecting a fake JWKSet that returns our test key.
 *   - The mock intercepts createRemoteJWKSet and returns a synchronous key function.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { generateKeyPair, SignJWT } from 'jose'
import type { webcrypto } from 'crypto'

// ---------------------------------------------------------------------------
// Test key pair — generated once, shared across all tests
// ---------------------------------------------------------------------------

type CryptoKeyType = webcrypto.CryptoKey

let privateKey: CryptoKeyType
let publicKey: CryptoKeyType

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  publicKey = pair.publicKey
})

// ---------------------------------------------------------------------------
// Mock createRemoteJWKSet so we never hit the network
// ---------------------------------------------------------------------------

// We mock the entire 'jose' module for the jwt.ts under test.
// createRemoteJWKSet returns a function that resolves our in-process publicKey.
vi.mock('jose', async (importOriginal) => {
  const original = await importOriginal<typeof import('jose')>()
  return {
    ...original,
    createRemoteJWKSet: vi.fn(() => {
      // Return a fake JWKS function that always returns the test public key.
      // The function signature matches what jwtVerify expects: (protectedHeader, token) => key
      return async () => {
        // publicKey is set in beforeAll — vi.mock hoisting means publicKey may be undefined
        // when the mock factory runs. We use a closure that reads the module-level var lazily.
        return publicKey
      }
    }),
  }
})

// Import after mocking
const { createJwtVerifier, isAllowedByEnv } = await import('./jwt.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISSUER = 'https://auth.example.com/application/o/narrative/'
const AUDIENCE = 'narrative-client-id'

function makeVerifier() {
  return createJwtVerifier({
    issuer: ISSUER,
    jwksUrl: 'https://auth.example.com/jwks',
    audience: AUDIENCE,
  })
}

async function signToken(
  claims: Record<string, unknown>,
  overrides: {
    issuer?: string
    audience?: string | string[]
    expiresIn?: string
    privateKey?: CryptoKeyType
  } = {},
): Promise<string> {
  const builder = new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)

  if (overrides.expiresIn !== 'never') {
    builder.setExpirationTime(overrides.expiresIn ?? '1h')
  }

  return builder.sign(overrides.privateKey ?? privateKey)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createJwtVerifier', () => {
  describe('valid token', () => {
    it('returns sub claim', async () => {
      const verifier = makeVerifier()
      const token = await signToken({ sub: 'user-uuid-123' })
      const payload = await verifier.verify(token)
      expect(payload.sub).toBe('user-uuid-123')
    })

    it('returns email and name when present', async () => {
      const verifier = makeVerifier()
      const token = await signToken({
        sub: 'user-uuid-123',
        email: 'alice@example.com',
        name: 'Alice',
      })
      const payload = await verifier.verify(token)
      expect(payload.email).toBe('alice@example.com')
      expect(payload.name).toBe('Alice')
    })

    it('returns groups array', async () => {
      const verifier = makeVerifier()
      const token = await signToken({
        sub: 'user-uuid-123',
        groups: ['admin', 'editors'],
      })
      const payload = await verifier.verify(token)
      expect(payload.groups).toEqual(['admin', 'editors'])
    })

    it('omits optional fields when absent', async () => {
      const verifier = makeVerifier()
      const token = await signToken({ sub: 'user-uuid-123' })
      const payload = await verifier.verify(token)
      expect(payload.email).toBeUndefined()
      expect(payload.name).toBeUndefined()
      expect(payload.groups).toBeUndefined()
    })
  })

  describe('invalid tokens', () => {
    it('throws on wrong issuer', async () => {
      const verifier = makeVerifier()
      const token = await signToken({ sub: 'x' }, { issuer: 'https://evil.example.com/' })
      await expect(verifier.verify(token)).rejects.toThrow('Invalid credentials')
    })

    it('throws on wrong audience', async () => {
      const verifier = makeVerifier()
      const token = await signToken({ sub: 'x' }, { audience: 'wrong-client' })
      await expect(verifier.verify(token)).rejects.toThrow('Invalid credentials')
    })

    it('throws on expired token', async () => {
      const verifier = makeVerifier()
      // expiresIn in the past — use -1s
      const builder = new SignJWT({ sub: 'x' })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('-1s')
      const token = await builder.sign(privateKey)
      await expect(verifier.verify(token)).rejects.toThrow('Invalid credentials')
    })

    it('throws on malformed token string', async () => {
      const verifier = makeVerifier()
      await expect(verifier.verify('not.a.jwt')).rejects.toThrow('Invalid credentials')
    })

    it('throws on empty string', async () => {
      const verifier = makeVerifier()
      await expect(verifier.verify('')).rejects.toThrow('Invalid credentials')
    })
  })
})

// ---------------------------------------------------------------------------
// isAllowedByEnv (env-allowlist gate; route handler combines this with the
// DB-based implicit allowlist).
// ---------------------------------------------------------------------------

describe('isAllowedByEnv', () => {
  it('accepts everything when no allowlist is configured (open mode)', () => {
    expect(
      isAllowedByEnv({ sub: 'u', email: 'a@b.c' }, { allowedEmails: [], allowedDomain: undefined }),
    ).toBe(true)
  })

  it('rejects a missing email when allowlist is set', () => {
    expect(
      isAllowedByEnv({ sub: 'u' }, { allowedEmails: ['x@y.z'], allowedDomain: undefined }),
    ).toBe(false)
  })

  it('accepts exact-match email (case-insensitive); does NOT require email_verified', () => {
    const cfg = { allowedEmails: ['KNOWN@EXAMPLE.COM'], allowedDomain: undefined }
    expect(isAllowedByEnv({ sub: 'u', email: 'known@example.com' }, cfg)).toBe(true)
    expect(isAllowedByEnv({ sub: 'u', email: 'unknown@example.com' }, cfg)).toBe(false)
  })

  it('accepts a domain-matched email when emailVerified=true', () => {
    const cfg = { allowedEmails: [], allowedDomain: 'example.com' }
    expect(isAllowedByEnv({ sub: 'u', email: 'a@example.com', emailVerified: true }, cfg)).toBe(
      true,
    )
  })

  it('rejects a domain-matched email when emailVerified is missing or false', () => {
    const cfg = { allowedEmails: [], allowedDomain: 'example.com' }
    expect(isAllowedByEnv({ sub: 'u', email: 'evil@example.com' }, cfg)).toBe(false)
    expect(isAllowedByEnv({ sub: 'u', email: 'evil@example.com', emailVerified: false }, cfg)).toBe(
      false,
    )
  })
})
