/**
 * auth/jwt.ts
 *
 * JWT verification via Authentik JWKS.
 *
 * Uses `jose` — supports JWKS auto-refresh, RS256/ES256, expiry checks.
 * Keys are cached in-process (jose default: 10m cacheMaxAge, 30s cooldown).
 *
 * Error messages are intentionally generic to avoid information leakage.
 * Callers receive "Invalid credentials" regardless of failure reason.
 * Internal details are logged at debug level only.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JwtPayload {
  /** Authentik user UUID ('sub' claim) */
  sub: string
  email?: string | undefined
  name?: string | undefined
  groups?: string[] | undefined
}

export interface JwtVerifier {
  verify(raw: string): Promise<JwtPayload>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a JWT verifier backed by a remote JWKS endpoint.
 *
 * @param opts.issuer   Expected 'iss' claim — must match Authentik issuer URL exactly.
 * @param opts.jwksUrl  URL of the JWKS endpoint (e.g. https://auth.example.com/application/o/<slug>/jwks/).
 * @param opts.audience Expected 'aud' claim — the Authentik application client_id.
 */
export function createJwtVerifier(opts: {
  issuer: string
  jwksUrl: string
  audience: string
}): JwtVerifier {
  const { issuer, jwksUrl, audience } = opts

  // jose handles caching + JWKS refresh internally.
  // cacheMaxAge default = 600_000ms (10min), cooldownDuration default = 30_000ms (30s).
  const jwks = createRemoteJWKSet(new URL(jwksUrl))

  return {
    async verify(raw: string): Promise<JwtPayload> {
      let payload: Record<string, unknown>

      try {
        const result = await jwtVerify(raw, jwks, {
          issuer,
          audience,
        })
        payload = result.payload as Record<string, unknown>
      } catch {
        // Do not expose signature/issuer/audience details to callers.
        throw new Error('Invalid credentials')
      }

      // 'sub' is required by OIDC spec and Authentik always sets it.
      if (typeof payload['sub'] !== 'string' || payload['sub'].length === 0) {
        throw new Error('Invalid credentials')
      }

      const result: JwtPayload = { sub: payload['sub'] }
      if (typeof payload['email'] === 'string') result.email = payload['email']
      if (typeof payload['name'] === 'string') result.name = payload['name']
      if (Array.isArray(payload['groups'])) {
        result.groups = (payload['groups'] as unknown[]).filter(
          (g): g is string => typeof g === 'string',
        )
      }
      return result
    },
  }
}
