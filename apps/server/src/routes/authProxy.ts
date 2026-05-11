/**
 * routes/authProxy.ts
 *
 * POST /api/auth/google/exchange — server-side OAuth token-exchange proxy.
 *
 * Why this exists
 * ---------------
 * Google's "Web application" OAuth client type requires `client_secret` on
 * every code-to-token exchange, even when the browser flow uses PKCE.
 * Shipping `client_secret` in the SPA bundle would expose it to anyone
 * loading the page, so the exchange is done server-side instead:
 *
 *   browser → POST /api/auth/google/exchange { code, code_verifier, ... }
 *           ↓ (server adds client_secret)
 *   server → POST https://oauth2.googleapis.com/token
 *           ↓ (Google returns id_token + access_token + expires_in)
 *   browser ← server forwards the token response unchanged
 *
 * The browser's OIDC library (`oidc-client-ts`) is configured via
 * `metadataSeed.token_endpoint` to call this endpoint instead of Google's
 * token endpoint directly, so the rest of the PKCE flow (state, callback,
 * silent renew) keeps working with no other changes.
 *
 * This endpoint is intentionally NOT protected by `authPreHandler` — it IS
 * the authentication path. It only proxies; it doesn't issue or validate
 * tokens itself.
 */

import type { FastifyInstance } from 'fastify'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export function registerAuthProxyRoutes(app: FastifyInstance): void {
  const clientId = process.env['OIDC_CLIENT_ID']
  const clientSecret = process.env['OIDC_CLIENT_SECRET']

  if (!clientId || !clientSecret) {
    app.log.warn(
      '[authProxy] OIDC_CLIENT_ID or OIDC_CLIENT_SECRET missing — /api/auth/google/exchange will return 500',
    )
  }

  // Route path is `/auth/google/exchange` — Caddy strips the `/api/` prefix
  // before proxying (`handle_path /api/* { reverse_proxy server:3001 }`).
  app.post('/auth/google/exchange', async (request, reply) => {
    if (!clientId || !clientSecret) {
      await reply.status(500).send({ error: 'server_misconfigured' })
      return
    }

    // The media/tus plugin registers a "passthrough" parser for
    // application/x-www-form-urlencoded that hands the unparsed stream back
    // (so tus can read req.raw directly). For this route we need to read
    // the stream ourselves and URL-decode it.
    const chunks: Buffer[] = []
    for await (const chunk of request.raw) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const incoming = new URLSearchParams(raw)

    // Validate grant type — only support the two flows we use.
    const grantType = incoming.get('grant_type')
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      await reply.status(400).send({ error: 'unsupported_grant_type' })
      return
    }

    // Defense in depth: only accept exchanges for OUR registered client_id.
    const incomingClientId = incoming.get('client_id')
    if (incomingClientId && incomingClientId !== clientId) {
      await reply.status(400).send({ error: 'invalid_client' })
      return
    }

    // Build the form payload Google expects. We attach client_secret here so
    // it never leaves the server.
    const outgoing = new URLSearchParams()
    outgoing.set('client_id', clientId)
    outgoing.set('client_secret', clientSecret)
    outgoing.set('grant_type', grantType)
    if (grantType === 'authorization_code') {
      const code = incoming.get('code')
      const codeVerifier = incoming.get('code_verifier')
      const redirectUri = incoming.get('redirect_uri')
      if (!code || !codeVerifier || !redirectUri) {
        await reply.status(400).send({ error: 'invalid_request' })
        return
      }
      outgoing.set('code', code)
      outgoing.set('code_verifier', codeVerifier)
      outgoing.set('redirect_uri', redirectUri)
    } else {
      const refreshToken = incoming.get('refresh_token')
      if (!refreshToken) {
        await reply.status(400).send({ error: 'invalid_request' })
        return
      }
      outgoing.set('refresh_token', refreshToken)
    }

    try {
      const upstream = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: outgoing.toString(),
      })
      const text = await upstream.text()
      reply.status(upstream.status)
      reply.header('content-type', upstream.headers.get('content-type') ?? 'application/json')
      return text
    } catch (err) {
      request.log.error({ err }, '[authProxy] token-endpoint fetch failed')
      await reply.status(502).send({ error: 'upstream_unavailable' })
    }
  })
}
