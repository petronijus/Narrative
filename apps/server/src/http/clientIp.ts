/**
 * http/clientIp.ts
 *
 * The client address behind the proxy chain, for code that needs it without
 * Fastify's `trustProxy` (which stays off — see http/rateLimit.ts): the HTTP
 * rate limiter and the WebSocket failed-authentication throttle.
 *
 * `clientIpHeader` names a header that the proxy chain sets and overwrites
 * (production: `cf-connecting-ip`, which Cloudflare sets at the edge and
 * Caddy strips from any request that did not come through cloudflared — see
 * infra/caddy/Caddyfile). When it is unset, absent or not an IP address, the
 * socket's peer address is used.
 */

import { isIP } from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'

export function clientIpFromHeaders(
  headers: IncomingHttpHeaders,
  socketAddress: string | undefined,
  clientIpHeader?: string,
): string {
  if (clientIpHeader) {
    const raw = headers[clientIpHeader.toLowerCase()]
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim()
    if (value && isIP(value) !== 0) return value
  }
  return socketAddress ?? 'unknown'
}
