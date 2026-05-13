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
  /** Google's `email_verified` claim. Required when matching the allowlist
   *  by domain — without it a misconfigured IdP could mint a token for
   *  `evil@yourdomain.com` without the user controlling that mailbox. */
  emailVerified?: boolean | undefined
  name?: string | undefined
  groups?: string[] | undefined
}

export interface JwtVerifier {
  verify(raw: string): Promise<JwtPayload>
}

/**
 * Creates a JWT verifier backed by a remote JWKS endpoint.
 *
 * Only validates signature + iss + aud + sub presence. Authorization
 * (allowlist / invite / existing-permission) is the caller's
 * responsibility — see `isAllowedByEnv` + the DB-based fallback in
 * `routes/auth.ts`.
 *
 * @param opts.issuer    Expected 'iss' claim. For Google: `https://accounts.google.com`.
 * @param opts.jwksUrl   JWKS endpoint URL. For Google: `https://www.googleapis.com/oauth2/v3/certs`.
 * @param opts.audience  Expected 'aud' claim. For Google: the OAuth client_id ending in `.apps.googleusercontent.com`.
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

      const result: JwtPayload = { sub: payload['sub'] }
      if (email) result.email = email
      if (typeof payload['email_verified'] === 'boolean') {
        result.emailVerified = payload['email_verified']
      }
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

// ---------------------------------------------------------------------------
// Allowlist (env-based) — first gate. The /auth/callback handler combines
// this with a DB-based fallback (pending invite or existing permission)
// before rejecting a sign-in. See `routes/auth.ts`.
// ---------------------------------------------------------------------------

export interface AllowlistConfig {
  allowedEmails: string[]
  allowedDomain?: string | undefined
}

/**
 * Returns true when the JWT's email satisfies the env-configured allowlist:
 *   - exact match in `allowedEmails`, or
 *   - ends with `@${allowedDomain}` AND `email_verified` is true.
 *
 * When neither `allowedEmails` nor `allowedDomain` is configured, returns
 * true unconditionally (open-deployment mode — only sensible in dev).
 */
export function isAllowedByEnv(payload: JwtPayload, config: AllowlistConfig): boolean {
  const emails = config.allowedEmails.map((e) => e.trim().toLowerCase()).filter(Boolean)
  const domain = config.allowedDomain?.trim().toLowerCase() || undefined
  if (emails.length === 0 && !domain) return true
  const email = payload.email?.toLowerCase()
  if (!email) return false
  if (emails.includes(email)) return true
  if (domain && payload.emailVerified === true && email.endsWith(`@${domain}`)) return true
  return false
}
