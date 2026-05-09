/**
 * auth/jwt.ts
 *
 * Google OIDC ID-token verification via remote JWKS.
 *
 * The implementation is intentionally generic (driven entirely by the issuer/
 * jwks/audience triple) so it could be pointed at any provider exposing a
 * standard `.well-known/jwks.json`, but only Google is supported in production.
 *
 * Token contract: callers send the OIDC **ID token** as `Authorization: Bearer`.
 * (Google access_tokens are opaque, not JWTs — the web client passes id_token.)
 *
 * Since Google's identity layer authenticates *anyone* with a Google account,
 * an explicit allowlist is enforced here (`allowedEmails` / `allowedDomain`)
 * to keep the deployment private — we gate by email.
 *
 * Error messages are intentionally generic — callers always receive
 * "Invalid credentials" regardless of failure reason.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose'

export interface JwtPayload {
  /** Stable per-user identifier from the IdP ('sub' claim). */
  sub: string
  email?: string | undefined
  name?: string | undefined
  groups?: string[] | undefined
}

export interface JwtVerifier {
  verify(raw: string): Promise<JwtPayload>
}

/**
 * Creates a JWT verifier backed by a remote JWKS endpoint.
 *
 * @param opts.issuer          Expected 'iss' claim. For Google: `https://accounts.google.com`.
 * @param opts.jwksUrl         JWKS endpoint URL. For Google: `https://www.googleapis.com/oauth2/v3/certs`.
 * @param opts.audience        Expected 'aud' claim. For Google: the OAuth client_id ending in `.apps.googleusercontent.com`.
 * @param opts.allowedEmails   Optional exact-match email allowlist.
 * @param opts.allowedDomain   Optional email-domain allowlist (e.g. `example.com`).
 *                             At least one of allowedEmails / allowedDomain SHOULD be set when using Google.
 */
export function createJwtVerifier(opts: {
  issuer: string
  jwksUrl: string
  audience: string
  allowedEmails?: string[]
  allowedDomain?: string
}): JwtVerifier {
  const { issuer, jwksUrl, audience } = opts
  const allowedEmails = (opts.allowedEmails ?? [])
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  const allowedDomain = opts.allowedDomain?.trim().toLowerCase()

  // jose handles caching + JWKS refresh internally.
  // cacheMaxAge default = 600_000ms (10min), cooldownDuration default = 30_000ms (30s).
  const jwks = createRemoteJWKSet(new URL(jwksUrl))

  // Google issues two valid issuers ('https://accounts.google.com' and
  // 'accounts.google.com' without scheme). Accept both when configured for Google.
  const issuerList =
    issuer === 'https://accounts.google.com'
      ? ['https://accounts.google.com', 'accounts.google.com']
      : issuer

  return {
    async verify(raw: string): Promise<JwtPayload> {
      let payload: Record<string, unknown>

      try {
        const result = await jwtVerify(raw, jwks, {
          issuer: issuerList,
          audience,
        })
        payload = result.payload as Record<string, unknown>
      } catch {
        throw new Error('Invalid credentials')
      }

      if (typeof payload['sub'] !== 'string' || payload['sub'].length === 0) {
        throw new Error('Invalid credentials')
      }

      const email =
        typeof payload['email'] === 'string' ? payload['email'].toLowerCase() : undefined

      // Allowlist enforcement — only when configured.
      if (allowedEmails.length > 0 || allowedDomain) {
        if (!email) throw new Error('Invalid credentials')
        // Domain allowlists are vulnerable to unverified-email impersonation:
        // a misconfigured IdP could mint a token for `evil@yourdomain.com`
        // without the user actually controlling that mailbox. Exact-email
        // allowlists do not have this problem (the email is the identity).
        if (allowedDomain && payload['email_verified'] !== true) {
          throw new Error('Invalid credentials')
        }
        const emailOk = allowedEmails.includes(email)
        const domainOk = allowedDomain ? email.endsWith(`@${allowedDomain}`) : false
        if (!emailOk && !domainOk) throw new Error('Invalid credentials')
      }

      const result: JwtPayload = { sub: payload['sub'] }
      if (email) result.email = email
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
